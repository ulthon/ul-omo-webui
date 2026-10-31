// r10 todo 7：会话级事件进消息流——三类事件（排队交接/压缩完成/模型切换回执）触发后
// messages store sessionEvents 含对应事件行；重放窗口与同模型重申不追加；纯 UI 反馈
// （复制成功）不进消息流只走 toast；notify 错误语义分级纠偏（tone=error → error 常驻）。
// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");
const { useQueueStore } = await import("@/stores/queue");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");
const { dispatchSseEvent, resetDispatchState } = await import("@/lib/event-dispatch");
const { mergeSessionEventLines } = await import("@/components/chat/message-items");
const { api } = await import("@/lib/api");

const ORIGINAL_LIST = api.listMessages;

function slot() {
  return {
    entries: [],
    cursor: null,
    leafId: null,
    loaded: true,
    hasMore: false,
    oldestId: null,
    streaming: false,
    streamingMessage: null,
    streamingEntryId: null,
    toolRuns: {},
    compacting: false,
    sessionEvents: [],
  };
}

function emit(sessionId, event, cursor = 100) {
  dispatchSseEvent("wire", JSON.stringify({ durableSessionId: sessionId, event }), cursor);
}

beforeEach(() => {
  useMessagesStore.setState({ bySession: {}, replayRecovering: false });
  useQueueStore.setState({ bySession: {} });
  useSessionsStore.setState({ appliedModels: {} });
  useUiStore.setState({ toasts: [] });
  resetDispatchState();
  // @ts-expect-error 测试桩：compaction_end 路径 refetchSession 补拉，静默空页即可
  api.listMessages = (sessionId) =>
    Promise.resolve({
      sessionId,
      entries: [],
      leafId: null,
      cursor: null,
      hasMore: false,
      oldestId: null,
    });
});

afterEach(() => {
  api.listMessages = ORIGINAL_LIST;
  resetDispatchState();
});

function linesOf(sessionId) {
  return useMessagesStore.getState().bySession[sessionId]?.sessionEvents ?? [];
}

describe("r10 todo 7：三类事件进消息流", () => {
  test("(a) 压缩完成（status!=declined）→ 不再追加事件行（标记块承载，2026-10-31 撤双报）", () => {
    useMessagesStore.setState({ bySession: { s1: slot() } });
    emit("s1", { type: "compaction_end", status: "completed" });
    expect(linesOf("s1")).toHaveLength(0);
  });

  test("(a2) declined 压缩与重放窗口内的完成帧均不追加事件行", () => {
    useMessagesStore.setState({ bySession: { s1: slot() } });
    emit("s1", { type: "compaction_end", status: "declined" });
    expect(linesOf("s1")).toHaveLength(0);
    // 重放窗口：begin 包夹的实时重放帧不产生事件行
    dispatchSseEvent("replay_begin", "{}", 101);
    emit("s1", { type: "compaction_end", status: "completed" }, 102);
    dispatchSseEvent("replay_done", "{}", 103);
    expect(linesOf("s1")).toHaveLength(0);
  });

  test("(b) 排队→引擎队列交接（ordered 新增项）→ queued 事件行携首行片段；重复全量与投递不重复报", () => {
    useMessagesStore.setState({ bySession: { s1: slot() } });
    emit("s1", {
      type: "queue_update",
      ordered: [{ text: "帮我查天气\n附注第二行", mode: "followUp", enqueueOrder: 1 }],
    });
    let lines = linesOf("s1");
    expect(lines).toHaveLength(1);
    expect(lines[0].summary.key).toBe("chat.sessionEvents.queued");
    expect(lines[0].summary.vars).toEqual({ text: "帮我查天气" });
    // 引擎全量 ordered 重复宣布同项（后续 queue_update）→ 不重复追加
    emit("s1", {
      type: "queue_update",
      ordered: [{ text: "帮我查天气\n附注第二行", mode: "followUp", enqueueOrder: 1 }],
    });
    expect(linesOf("s1")).toHaveLength(1);
    // 投递（ordered 出队宣布）→ 事件行送达即撤（2026-10-31 对齐 CLI 瞬态），不再常驻
    emit("s1", { type: "queue_update", ordered: [] });
    expect(linesOf("s1")).toHaveLength(0);
  });

  test("(c) 模型切换回执 → modelSwitch 事件行；同模型重申不追加，异模型再切追加", () => {
    useMessagesStore.setState({ bySession: { s1: slot() } });
    emit("s1", { type: "model_changed", model: { provider: "zai-coding-cn", id: "glm-5.3" } });
    let lines = linesOf("s1");
    expect(lines).toHaveLength(1);
    expect(lines[0].summary.key).toBe("chat.sessionEvents.modelSwitch");
    expect(lines[0].summary.vars).toEqual({ model: "zai-coding-cn/glm-5.3" });
    // 同模型重申（prompt 注入同源重发）→ 不追加
    emit("s1", { type: "model_changed", model: { provider: "zai-coding-cn", id: "glm-5.3" } });
    expect(linesOf("s1")).toHaveLength(1);
    // 异模型再切 → 追加第二行
    emit("s1", { type: "model_changed", model: { provider: "zai-coding-cn", id: "glm-5.3-4k" } });
    lines = linesOf("s1");
    expect(lines).toHaveLength(2);
    expect(lines[1].summary.vars).toEqual({ model: "zai-coding-cn/glm-5.3-4k" });
  });

  test("(d) 纯 UI 反馈（复制成功）只走 toast，不进消息流", () => {
    useMessagesStore.setState({ bySession: { s1: slot() } });
    useUiStore.getState().showToast("已复制", "info");
    expect(useUiStore.getState().toasts).toHaveLength(1);
    expect(linesOf("s1")).toHaveLength(0);
  });

  test("(a3) 切页回来可见：全量重取 setEntries 整替 entries 不冲掉事件行（非 toast 瞬态）", () => {
    useMessagesStore.setState({ bySession: { s1: slot() } });
    emit("s1", { type: "model_changed", model: { provider: "p", id: "m1" } });
    expect(linesOf("s1")).toHaveLength(1);
    // 模拟切页回来触发的水合点：GET messages 全量整替 entries（重取替换服务端真相）
    useMessagesStore.getState().setEntries("s1", [], null, null);
    expect(useMessagesStore.getState().bySession.s1.entries).toHaveLength(0);
    expect(linesOf("s1")).toHaveLength(1);
  });

  test("(e) notify 分级纠偏：tone=error 走 error 常驻，无 tone 维持 info", () => {
    useMessagesStore.setState({ bySession: { s1: slot() } });
    emit("s1", { type: "extension_ui_request", method: "notify", message: "备份失败", tone: "error" });
    let toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("error");
    expect(toasts[0].text).toBe("备份失败");
    emit("s1", { type: "extension_ui_request", method: "notify", message: "普通通知" }, 101);
    toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[1].kind).toBe("info");
  });
});

describe("mergeSessionEventLines 归并纯函数", () => {
  test("尾部追加事件行；空事件行原样返回（引用不变）", () => {
    const items = [{ key: "e1", kind: "entry", entryId: "e1", interrupted: false, model: null }];
    expect(mergeSessionEventLines(items, [])).toBe(items);
    const merged = mergeSessionEventLines(items, [
      { id: "ev-1", summary: { key: "chat.sessionEvents.modelSwitch", vars: { model: "p/m" } } },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[1].kind).toBe("sessionEvent");
    expect(merged[1].key).toBe("session-event-ev-1");
    expect(merged[1].line.summary.key).toBe("chat.sessionEvents.modelSwitch");
  });
});
