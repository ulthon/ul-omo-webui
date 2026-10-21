/**
 * 压缩过程条与摘要标记的真实分发链路挂载测试（docs08-r6 任务 19g，F3 IS-11 两失败面回归）：
 * 帧全部经 dispatchSseEvent 真实入口注入（wire 形态取 F3 隔离实例 server.log 实证：
 * compaction_start/progress/end + compaction_end 后紧跟的 entry_appended
 * {entry:{type:"compaction",id,summary,...}}），不用预置 store 状态。
 *
 * 修复面（19g）：
 * - 进行条 banner：start/progress 置位 → MessageList 挂载 data-testid=compacting-banner；
 *   end 消除。帧丢失由 COMPACTING_FALLBACK_MS 兑底（既有用例覆盖）。
 * - 摘要标记：entry_appended 白名单放行顶层 type:"compaction" 条目入列（修复前被
 *   isMemoryAppendedEntry 白名单丢弃——进行中页面永不出现标记块，仅刷新后才见）；
 *   compaction_end（status!=declined）补拉 GET messages 对账（帧丢失场景标记收敛）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { dispatchSseEvent, resetDispatchState } = await import("@/lib/event-dispatch");
const { useMessagesStore } = await import("@/stores/messages");
const { MessageList, CompactionMarkerBlock } = await import("@/components/chat/message-list");
const { mergeMemoryItems, buildMessageItems, compactionMarkerOf } = await import("@/components/chat/message-items");
const { api } = await import("@/lib/api");

const SID = "01a16037-7d1f-7d33-921e-35e36d08bf73";

/** wire 帧信封（服务端 sse.ts dataPayload 形态：{projectPath, event, durableSessionId}） */
function frame(wire: Record<string, unknown>, cursor: number): void {
  dispatchSseEvent(String(wire.type), JSON.stringify({ projectPath: "/p", event: wire, durableSessionId: SID }), cursor);
}

/** F3 实测 compaction 条目形态（task-3 枚举 §三 键集） */
function compactionEntryWire(): Record<string, unknown> {
  return {
    type: "compaction",
    id: "bff18e87",
    parentId: "e70e651b",
    timestamp: "2026-10-21T21:07:50.000Z",
    summary: "压缩摘要首行：会话上下文已收敛。\n第二行补充。",
    firstKeptEntryId: "e70e651b",
    tokensBefore: 30530,
    details: { schema: "senpi.compaction.summary.v1", origin: "core-route" },
    fromHook: true,
  };
}

function messageEntry(id: string, role: "user" | "assistant"): Record<string, unknown> {
  return { type: "message", id, message: { role, content: [{ type: "text", text: `${role} ${id}` }] } };
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot> | null = null;

async function mountList(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    const entries = useMessagesStore.getState().bySession[SID]?.entries ?? [];
    const items = buildMessageItems(entries as never, { hasStreamingMessage: false, interrupted: false });
    const storeEntries = useMessagesStore.getState().bySession[SID]?.entries ?? [];
    const merged = mergeMemoryItems(items, storeEntries);
    root!.render(
      createElement(MessageList, { items: merged, sessionId: SID, syncing: false, onReachTop: () => {} }),
    );
  });
}

beforeEach(() => {
  resetDispatchState();
  useMessagesStore.setState({ bySession: {} });
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container.remove();
  resetDispatchState();
  vi.restoreAllMocks();
});

describe("进行条 banner（19g 面一）：真实帧 → dispatch → 挂载", () => {
  test("start/progress 置位挂载 banner；end 消除", async () => {
    frame({ type: "compaction_start", reason: "manual", runId: "op-1" }, 1);
    frame({ type: "compaction_progress", runId: "op-1" }, 2);
    await mountList();
    expect(document.querySelector('[data-testid="compacting-banner"]')).not.toBeNull();

    frame({ type: "compaction_end", reason: "manual", status: "completed", entryId: "bff18e87" }, 3);
    await act(async () => {});
    expect(document.querySelector('[data-testid="compacting-banner"]')).toBeNull();
  });

  test("start 先于会话槽存在到达（槽缺席场景）同样置位并挂载", async () => {
    expect(useMessagesStore.getState().bySession[SID]).toBeUndefined();
    frame({ type: "compaction_start", reason: "threshold" }, 1);
    expect(useMessagesStore.getState().bySession[SID]?.compacting).toBe(true);
    await mountList();
    expect(document.querySelector('[data-testid="compacting-banner"]')).not.toBeNull();
  });
});

describe("摘要标记（19g 面二）：entry_appended 白名单放行 → 派生标记项", () => {
  test("compaction_end 后紧跟的 entry_appended 压缩条目入列（修复前被丢弃），派生 marker 项", () => {
    frame({ type: "compaction_start", reason: "manual" }, 1);
    frame({ type: "compaction_end", reason: "manual", status: "completed", entryId: "bff18e87" }, 2);
    // F3 server.log 实证：compaction_end 后紧跟 entry_appended 携压缩条目
    dispatchSseEvent(
      "entry_appended",
      JSON.stringify({ projectPath: "/p", event: { type: "entry_appended", sessionId: "rpc-1", entry: compactionEntryWire() }, durableSessionId: SID }),
      3,
    );
    const entries = useMessagesStore.getState().bySession[SID]?.entries ?? [];
    const compaction = entries.find((e) => e.type === "compaction");
    expect(compaction).toBeDefined();
    const marker = compactionMarkerOf(compaction!);
    expect(marker).not.toBeNull();
    expect(marker!.summaryFirstLine).toBe("压缩摘要首行：会话上下文已收敛。");
    expect(marker!.tokensBefore).toBe(30530);
    // 归并管线产出标记项（MessageList 渲染 compaction-marker 块的数据源）
    const msgEntries = [messageEntry("u1", "user"), compactionEntryWire(), messageEntry("a1", "assistant")];
    const items = buildMessageItems(msgEntries as never, { hasStreamingMessage: false, interrupted: false });
    const merged = mergeMemoryItems(items, msgEntries as never);
    expect(merged.some((i) => i.kind === "compactionMarker")).toBe(true);
  });

  test("非 compaction 条目（custom 噪音）仍被白名单丢弃，不回归", () => {
    dispatchSseEvent(
      "entry_appended",
      JSON.stringify({ projectPath: "/p", event: { type: "entry_appended", sessionId: "rpc-1", entry: { type: "custom", id: "x1", customType: "pi-rules.scan", data: {} } }, durableSessionId: SID }),
      1,
    );
    const entries = useMessagesStore.getState().bySession[SID]?.entries ?? [];
    expect(entries.find((e) => e.id === "x1")).toBeUndefined();
  });

  test("compaction_end（completed）补拉 GET messages 对账（帧丢失场景标记收敛）；declined 不补拉", async () => {
    const spy = vi.spyOn(api, "listMessages").mockResolvedValue({ sessionId: SID, entries: [], cursor: "c1", leafId: null } as never);
    frame({ type: "compaction_start", reason: "manual" }, 0); // 置会话槽（refetchSession 仅对已加载会话补拉）
    frame({ type: "compaction_end", reason: "manual", status: "completed" }, 1);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]![0]).toBe(SID); // 槽未加载 → 无游标全量补拉

    spy.mockClear();
    frame({ type: "compaction_end", reason: "threshold", status: "declined" }, 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(spy).not.toHaveBeenCalled();
  });

  test("CompactionMarkerBlock 以派生 marker 渲染（常显首行 + 水位段）", async () => {
    frame({ type: "compaction_end", reason: "manual", status: "completed" }, 1);
    dispatchSseEvent(
      "entry_appended",
      JSON.stringify({ projectPath: "/p", event: { type: "entry_appended", sessionId: "rpc-1", entry: compactionEntryWire() }, durableSessionId: SID }),
      2,
    );
    const entries = useMessagesStore.getState().bySession[SID]?.entries ?? [];
    const marker = compactionMarkerOf(entries.find((e) => e.type === "compaction")!);
    expect(marker!.tokensBefore).toBe(30530);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(CompactionMarkerBlock, { marker: marker! }));
    });
    const block = document.querySelector('[data-testid="compaction-marker"]');
    expect(block).not.toBeNull();
    expect(block!.textContent).toContain("压缩摘要首行");
  });
});
