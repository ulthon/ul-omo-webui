/**
 * 压缩生命周期 SSE 事件接线（docs08-r6 任务 18 ①②⑥）：
 * - compaction_start/progress → messages store compacting 置位（消息流顶部进行条数据源），
 *   compaction_end 消除；引擎事件形态实测（senpi 核心 bundle）：start 携
 *   reason threshold/overflow/manual，end 携 status completed/declined。
 * - stale_progress_bar 防线：end 帧丢失时 COMPACTING_FALLBACK_MS 超时兜底回落，进行条不永挂；
 *   重复/乱序 end 幂等。
 * - compaction_end（status!=declined）→ broadcastUsageRefresh 广播（水位环/状态条重拉
 *   权威快照；504 超时路径后台完成的事件补偿）。
 * - ⑥ 自动压缩轻提示：start 且 reason!=manual → info toast；manual 不弹；重放窗口内不弹。
 * - 409 语义回归（conflict_409_semantics）：手动压缩链 runCompact 仍是同步 RPC 直调——
 *   409 already_processing 原样上抛由调用方行内明示，且不广播 usage 刷新。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dispatchSseEvent, resetDispatchState } from "@/lib/event-dispatch";
import { broadcastUsageRefresh, onUsageRefresh, runCompact } from "@/components/chat/compact-run";
import { useMessagesStore, COMPACTING_FALLBACK_MS } from "@/stores/messages";
import { useUiStore } from "@/stores/ui";
import { api, ApiError } from "@/lib/api";
import { zh } from "@/i18n/zh";

function frame(wire: Record<string, unknown>, cursor: number, durable = "d-1"): void {
  dispatchSseEvent(
    String(wire.type),
    JSON.stringify({ projectPath: "/p", event: wire, durableSessionId: durable }),
    cursor,
  );
}

function compactingOf(sid = "d-1"): boolean {
  return useMessagesStore.getState().bySession[sid]?.compacting ?? false;
}

let usageCalls = 0;
let unsubUsage: (() => void) | null = null;

beforeEach(() => {
  resetDispatchState();
  useMessagesStore.setState({ bySession: {} });
  useUiStore.setState({ toast: null });
  usageCalls = 0;
  // compact-run 的 usageListeners 是模块级单例：先退订上一个用例的订阅，
  // 防跨用例累积导致计数倍增
  unsubUsage?.();
  unsubUsage = onUsageRefresh(() => {
    usageCalls += 1;
  });
});

afterEach(() => {
  unsubUsage?.();
  unsubUsage = null;
  resetDispatchState();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("① 三事件分支：进行态置位与消除", () => {
  test("start → compacting 置位；progress 保持；end（completed）→ 消除且广播 usage 重拉", () => {
    frame({ type: "compaction_start", reason: "manual", runId: "op-1", lane: "main", startedAt: 1 }, 1);
    expect(compactingOf()).toBe(true);
    frame({ type: "compaction_progress", runId: "op-1" }, 2);
    expect(compactingOf()).toBe(true);
    expect(usageCalls).toBe(0);
    frame({ type: "compaction_end", reason: "manual", status: "completed", entryId: "e3be398e", endedAt: 2 }, 3);
    expect(compactingOf()).toBe(false);
    expect(usageCalls).toBe(1);
  });

  test("end（declined：引擎拒绝压缩，水位无变化）→ 消除进行态但不广播 usage", () => {
    frame({ type: "compaction_start", reason: "threshold" }, 1);
    frame({ type: "compaction_end", reason: "threshold", status: "declined" }, 2);
    expect(compactingOf()).toBe(false);
    expect(usageCalls).toBe(0);
  });

  test("重复 end / 无 start 的孤立 end 幂等不崩（乱序容错）", () => {
    frame({ type: "compaction_end", status: "completed" }, 1);
    expect(compactingOf()).toBe(false);
    frame({ type: "compaction_start", reason: "manual" }, 2);
    frame({ type: "compaction_end", status: "completed" }, 3);
    frame({ type: "compaction_end", status: "completed" }, 4);
    expect(compactingOf()).toBe(false);
  });

  test("载荷异形（reason/status 缺失）容错：start 置位、end 消除并广播（缺省按需重拉）", () => {
    frame({ type: "compaction_start" }, 1);
    expect(compactingOf()).toBe(true);
    frame({ type: "compaction_end" }, 2);
    expect(compactingOf()).toBe(false);
    expect(usageCalls).toBe(1);
  });

  test("多会话隔离：d-1 与 d-2 的进行态互不串扰", () => {
    frame({ type: "compaction_start", reason: "manual" }, 1, "d-1");
    frame({ type: "compaction_start", reason: "manual" }, 2, "d-2");
    frame({ type: "compaction_end", status: "completed" }, 3, "d-1");
    expect(compactingOf("d-1")).toBe(false);
    expect(compactingOf("d-2")).toBe(true);
  });
});

describe("stale_progress_bar 防线：end 帧丢失超时兜底", () => {
  test("start 后无 end 帧，COMPACTING_FALLBACK_MS 后进行态自动回落（不永挂）", () => {
    vi.useFakeTimers();
    frame({ type: "compaction_start", reason: "manual" }, 1);
    expect(compactingOf()).toBe(true);
    vi.advanceTimersByTime(COMPACTING_FALLBACK_MS - 1);
    expect(compactingOf()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(compactingOf()).toBe(false);
    // 兜底回落不广播 usage（水位真相由 usage 轮询/下次事件校正，不臆造）
    expect(usageCalls).toBe(0);
  });

  test("end 正常到达时兜底定时器拆除（后续不会再误回落新一轮进行态）", () => {
    vi.useFakeTimers();
    frame({ type: "compaction_start", reason: "manual" }, 1);
    frame({ type: "compaction_end", status: "completed" }, 2);
    vi.advanceTimersByTime(COMPACTING_FALLBACK_MS * 2);
    expect(compactingOf()).toBe(false);
    // 新一轮压缩在旧兜底窗口内启动：不被残留定时器误清
    frame({ type: "compaction_start", reason: "manual" }, 3);
    vi.advanceTimersByTime(1000);
    expect(compactingOf()).toBe(true);
  });
});

describe("⑥ 自动压缩轻提示（reason != manual）", () => {
  test("threshold / overflow / reason 缺失 → info toast；manual 不弹", () => {
    frame({ type: "compaction_start", reason: "threshold" }, 1);
    expect(useUiStore.getState().toast?.text).toBe(zh.chat.compact.autoStarted);
    expect(useUiStore.getState().toast?.kind).toBe("info");

    useUiStore.getState().clearToast();
    frame({ type: "compaction_start", reason: "overflow" }, 2);
    expect(useUiStore.getState().toast?.text).toBe(zh.chat.compact.autoStarted);

    useUiStore.getState().clearToast();
    frame({ type: "compaction_start", reason: "manual" }, 3);
    expect(useUiStore.getState().toast).toBeNull();
  });

  test("重放窗口内（replay_begin 包夹）不弹 toast（重连重播防重复提示），进行态照常置位", () => {
    dispatchSseEvent("replay_begin", "{}", 4);
    frame({ type: "compaction_start", reason: "threshold" }, 5);
    expect(useUiStore.getState().toast).toBeNull();
    expect(compactingOf()).toBe(true);
    dispatchSseEvent("replay_done", "{}", 6);
  });
});

describe("② broadcastUsageRefresh 订阅面（水位环/状态条数据源）", () => {
  test("手动导出直调与 end 事件驱动共用同一订阅面", () => {
    broadcastUsageRefresh();
    expect(usageCalls).toBe(1);
  });
});

describe("conflict_409_semantics：手动压缩 409 语义回归不动", () => {
  test("runCompact 409 already_processing 原样上抛（同步 RPC 直调链不变），且不广播 usage 刷新", async () => {
    const spy = vi.spyOn(api, "compactSession").mockRejectedValue(
      new ApiError(409, "already_processing", "该会话回合进行中，压缩前请先等待回合结束或中断"),
    );
    await expect(runCompact("d-1")).rejects.toMatchObject({
      status: 409,
      code: "already_processing",
    });
    expect(spy).toHaveBeenCalledWith("d-1");
    expect(usageCalls).toBe(0);
  });
});
