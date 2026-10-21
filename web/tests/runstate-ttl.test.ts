// W1 缺陷 #3（todo 4）单测：会话运行态无活动超时回落与服务重启（游标回退）重同步。
//   - setRunState 写活动时刻；该会话任何 SSE 帧刷新时刻（同态 setRunState 与 touchRunStateAt 两路）
//   - 周期清扫（store 动作，显式注入 now）：running >10min、waiting >30min 无活动回落 idle；
//     事件刷新把活动基准前推，活跃会话不被回落；error/idle 与无账本条目不碰
//   - 游标回退（服务重启强信号）触发 GET /api/sessions 重同步：服务端 runState 三态
//     直接对齐（docs08-r6 任务 11：null/列表缺席不动；running/waiting/idle 对齐；同态不刷账本）
// 时刻控制：bun setSystemTime 定格 at 写入，清扫以显式 now 注入（确定性，不依赖真定时器）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionListItem } from "@/lib/api";
import { dispatchSseEvent, isRunStateSweepArmed, resetDispatchState, SWEEP_INTERVAL_MS } from "@/lib/event-dispatch";
import { useMessagesStore } from "@/stores/messages";
import { usePermissionsStore } from "@/stores/permissions";
import { RUNNING_STALE_MS, useSessionsStore, WAITING_STALE_MS } from "@/stores/sessions";

const ORIGINAL_FETCH = globalThis.fetch;

function makeSession(
  id: string,
  runState: "running" | "waiting" | "idle" | null = "idle",
): SessionListItem {
  return {
    id,
    path: `/store/sessions/${id}.jsonl`,
    project: "/p",
    title: id,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: runState === "running" || runState === "waiting",
    runState,
  };
}

function frame(wire: Record<string, unknown>, durable?: string): string {
  return JSON.stringify(durable ? { projectPath: "/p", event: wire, durableSessionId: durable } : { projectPath: "/p", event: wire });
}

/** 排空 mock fetch → then → set 微任务链（重同步/重取均为 fire-and-forget promise） */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function ledger(): Record<string, number> {
  return useSessionsStore.getState().runStateAt;
}

beforeEach(() => {
  // 只冻结 Date（setSystemTime 生效前提），setTimeout 保持真实——tick() 排微任务链依赖它
  vi.useFakeTimers({ toFake: ["Date"] });
  resetDispatchState();
  useSessionsStore.setState({ byProject: {}, runStates: {}, runStateAt: {}, selectedId: null });
  usePermissionsStore.setState({ bySession: {} });
  useMessagesStore.setState({ bySession: {} });
});

afterEach(() => {
  resetDispatchState();
  vi.useRealTimers(); // 恢复真实时钟，防跨文件泄漏
  globalThis.fetch = ORIGINAL_FETCH;
  useSessionsStore.setState({ byProject: {}, runStates: {}, runStateAt: {}, selectedId: null });
  usePermissionsStore.setState({ bySession: {} });
  useMessagesStore.setState({ bySession: {} });
});

describe("清扫布防（event-dispatch 接线）", () => {
  test("常量口径：60s 周期（F3 调参引用锚点）", () => {
    expect(SWEEP_INTERVAL_MS).toBe(60_000);
  });

  test("首个 SSE 帧布防清扫；resetDispatchState 拆防", () => {
    expect(isRunStateSweepArmed()).toBe(false);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-1" }, "d-1"), 1);
    expect(isRunStateSweepArmed()).toBe(true);
    resetDispatchState();
    expect(isRunStateSweepArmed()).toBe(false);
  });
});

describe("setRunState 活动账本", () => {
  test("写入运行态即写时刻；同态写入只刷新时刻（runStates 引用不变）", () => {
    vi.setSystemTime(1000);
    useSessionsStore.getState().setRunState("d-1", "running");
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("running");
    expect(ledger()["d-1"]).toBe(1000);
    vi.setSystemTime(2000);
    useSessionsStore.getState().setRunState("d-1", "running");
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("running");
    expect(ledger()["d-1"]).toBe(2000);
  });

  test("clearRunState 连账本一并清；adoptSessionId 连账本一并迁移", () => {
    vi.setSystemTime(1000);
    useSessionsStore.getState().setRunState("d-1", "running");
    vi.setSystemTime(2000);
    useSessionsStore.getState().setRunState("d-2", "running");
    useSessionsStore.getState().adoptSessionId("d-1", "d-1x");
    expect(ledger()["d-1"]).toBeUndefined();
    expect(ledger()["d-1x"]).toBe(1000);
    useSessionsStore.getState().clearRunState("d-1x");
    expect(ledger()["d-1x"]).toBeUndefined();
    expect(useSessionsStore.getState().runStates["d-1x"]).toBeUndefined();
  });

  test("无运行态时 touch 为 no-op（不产生孤儿账本条目）", () => {
    useSessionsStore.getState().touchRunStateAt("d-none");
    expect(ledger()["d-none"]).toBeUndefined();
  });
});

describe("无活动超时清扫", () => {
  test("running 无活动 >10min 回落 idle；恰好 10min 不回落", () => {
    vi.setSystemTime(1000);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-1" }, "d-1"), 1);
    const at = ledger()["d-1"]!;
    useSessionsStore.getState().sweepStaleRunStates(at + RUNNING_STALE_MS);
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("running");
    useSessionsStore.getState().sweepStaleRunStates(at + RUNNING_STALE_MS + 1);
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("idle");
  });

  test("waiting 无活动 >30min 回落 idle（权限等待从宽）", () => {
    vi.setSystemTime(1000);
    dispatchSseEvent(
      "extension_ui_request",
      frame({ type: "extension_ui_request", method: "confirm", id: "r1", sessionId: "rpc-1" }, "d-1"),
      1,
    );
    const at = ledger()["d-1"]!;
    useSessionsStore.getState().sweepStaleRunStates(at + WAITING_STALE_MS);
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("waiting");
    useSessionsStore.getState().sweepStaleRunStates(at + WAITING_STALE_MS + 1);
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("idle");
  });

  test("任何事件刷新防衰减：流式帧触达的活跃 running 永不被清扫周期误杀", () => {
    vi.setSystemTime(1000);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-1" }, "d-1"), 1);
    // 5min 处一帧 message_end（非运行态事件，仅活动记账）——活动基准前推
    vi.setSystemTime(1000 + 5 * 60_000);
    dispatchSseEvent("message_end", frame({ type: "message_end", sessionId: "rpc-1", message: { role: "assistant", content: [] } }, "d-1"), 2);
    expect(ledger()["d-1"]).toBe(1000 + 5 * 60_000);
    // 原始 10min 死线上不回落（若未刷新此刻必已 decay）
    useSessionsStore.getState().sweepStaleRunStates(1000 + RUNNING_STALE_MS + 1);
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("running");
    // 新基准 +10min 才回落
    useSessionsStore.getState().sweepStaleRunStates(1000 + 5 * 60_000 + RUNNING_STALE_MS + 1);
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("idle");
  });

  test("同态 setRunState（重复 agent_start）同样刷新防衰减", () => {
    vi.setSystemTime(1000);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-1" }, "d-1"), 1);
    vi.setSystemTime(2000);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-1" }, "d-1"), 2);
    expect(ledger()["d-1"]).toBe(2000);
    useSessionsStore.getState().sweepStaleRunStates(2000 + RUNNING_STALE_MS + 1);
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("idle");
  });

  test("error/idle 不参与清扫；无账本条目（外部直写残留）不判超时", () => {
    vi.setSystemTime(1000);
    dispatchSseEvent("engine_event", frame({ type: "session_error", sessionId: "rpc-1" }, "d-err"), 1);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-2" }, "d-idle"), 2);
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-2" }, "d-idle"), 3);
    useSessionsStore.setState({ runStates: { ...useSessionsStore.getState().runStates, "d-ghost": "running" } });
    useSessionsStore.getState().sweepStaleRunStates(1000 + 60 * 60_000);
    const rs = useSessionsStore.getState().runStates;
    expect(rs["d-err"]).toBe("error");
    expect(rs["d-idle"]).toBe("idle");
    expect(rs["d-ghost"]).toBe("running"); // 宁可不回落
  });

  test("清扫不改活动账本（回落后的 idle 记录的仍是最后活动时刻）", () => {
    vi.setSystemTime(1000);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-1" }, "d-1"), 1);
    const at = ledger()["d-1"]!;
    useSessionsStore.getState().sweepStaleRunStates(at + RUNNING_STALE_MS + 1);
    expect(ledger()["d-1"]).toBe(at);
  });
});

describe("游标回退（服务重启）触发运行态重同步（docs08-r6 任务 11：服务端 runState 真相源）", () => {
  /** mock fetch：/api/sessions? 返回聚合快照，其余（GET messages 重取兜底）返回空页 */
  function mockFetchRessync(sessions: SessionListItem[]): { listUrl(): string } {
    const state = { url: "" };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions?")) {
        state.url = url;
        return new Response(JSON.stringify({ project: null, archived: "all", sessions }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ sessionId: "", entries: [], leafId: null, cursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { listUrl: () => state.url };
  }

  test("runState 三态对齐：waiting/running/idle 直接对齐；null 与列表缺席不动；error 落 idle；本地权限队列不参与", async () => {
    const snapshot: SessionListItem[] = [
      makeSession("d-run", "running"),
      makeSession("d-wait", "waiting"),
      makeSession("d-runq", "running"), // 服务端 running：本地权限队列非空也不再改判 waiting（真相源）
      makeSession("d-err", "idle"), // 服务端 idle：前端 error 一并对齐（服务端已无回合在途）
      makeSession("d-idle", "idle"),
      makeSession("d-null", null), // 引擎未就绪：不动
      makeSession("d-off", "idle"),
      makeSession("d-quiet", "running"), // 服务端仍 running：本地已落 idle 也提升（真相源）
      // d-absent 故意缺席：跨端已删等场景
    ];
    const { listUrl } = mockFetchRessync(snapshot);
    vi.setSystemTime(1000);
    // 状态建立（游标依次推进）
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-a" }, "d-run"), 1);
    dispatchSseEvent(
      "extension_ui_request",
      frame({ type: "extension_ui_request", method: "select", id: "r1", sessionId: "rpc-b" }, "d-wait"),
      2,
    );
    usePermissionsStore.getState().pushRequest("d-wait", { id: "r1", method: "select", title: "Permission required: bash" });
    dispatchSseEvent("engine_event", frame({ type: "session_error", sessionId: "rpc-c" }, "d-err"), 3);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-d" }, "d-idle"), 4);
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-d" }, "d-idle"), 5);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-e" }, "d-null"), 6);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-f" }, "d-off"), 7);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-g" }, "d-quiet"), 8);
    dispatchSseEvent("agent_end", frame({ type: "agent_end", sessionId: "rpc-g" }, "d-quiet"), 9);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-i" }, "d-runq"), 10);
    usePermissionsStore.getState().pushRequest("d-runq", { id: "r2", method: "confirm", title: "Permission required: bash" });
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-h" }, "d-absent"), 11);
    expect(useSessionsStore.getState().runStates).toEqual({
      "d-run": "running",
      "d-wait": "waiting",
      "d-runq": "running",
      "d-err": "error",
      "d-idle": "idle",
      "d-null": "running",
      "d-off": "running",
      "d-quiet": "idle",
      "d-absent": "running",
    });

    // 服务重启：新纪元游标回退 → 重同步并行发射
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-z" }, "d-z"), 1);
    await tick();
    await tick();

    const rs = useSessionsStore.getState().runStates;
    expect(rs["d-run"]).toBe("running"); // 服务端 running：同态幂等
    expect(rs["d-wait"]).toBe("waiting"); // 服务端 waiting：直接对齐
    expect(rs["d-runq"]).toBe("running"); // 本地权限队列不参与推导（旧 active+队列启发式退役）
    expect(rs["d-err"]).toBe("idle"); // 服务端 idle：error 一并对齐
    expect(rs["d-idle"]).toBe("idle"); // 同态幂等
    expect(rs["d-null"]).toBe("running"); // runState null（引擎未就绪）→ 不动（原 active===null 不动规则保留）
    expect(rs["d-off"]).toBe("idle"); // 服务端 idle：running 落 idle
    expect(rs["d-quiet"]).toBe("running"); // 服务端 running：idle 提升（重启时回合实际在途）
    expect(rs["d-absent"]).toBe("running"); // 列表缺席 → 不动
    const url = listUrl();
    expect(url).toContain("archived=all"); // 聚合端点（覆盖全项目 + 归档）
    expect(url).not.toContain("project=");
  });

  test("同态对齐不刷活动账本（重同步不推迟无活动清扫兜底）", async () => {
    mockFetchRessync([makeSession("d-1", "running")]);
    vi.setSystemTime(1000);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-a" }, "d-1"), 5);
    const at = ledger()["d-1"]!;
    vi.setSystemTime(at + 60_000);
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-z" }, "d-z"), 1); // 游标回退
    await tick();
    await tick();
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("running");
    expect(ledger()["d-1"]).toBe(at); // 同态不重写：活动时刻不被重同步推后
  });

  test("旧服务端未下发 runState 字段：全体不动（退化为无活动清扫兜底）", async () => {
    const snapshot: SessionListItem[] = [{ ...makeSession("d-1", "idle"), runState: undefined }];
    mockFetchRessync(snapshot);
    vi.setSystemTime(1000);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-a" }, "d-1"), 5);
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-z" }, "d-z"), 1); // 游标回退
    await tick();
    await tick();
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("running"); // 行无字段 → 不动
  });

  test("重同步失败静默：状态原样保留，交无活动清扫兜底", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    vi.setSystemTime(1000);
    dispatchSseEvent("agent_start", frame({ type: "agent_start", sessionId: "rpc-a" }, "d-1"), 5);
    dispatchSseEvent("message_update", frame({ type: "message_update", sessionId: "rpc-z" }, "d-z"), 1); // 游标回退
    await tick();
    await tick();
    expect(useSessionsStore.getState().runStates["d-1"]).toBe("running");
  });
});
