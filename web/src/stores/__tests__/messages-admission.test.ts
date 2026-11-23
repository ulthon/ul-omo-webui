// webui-refetch-storm 任务 1（GAP-1 主 / GAP-2 半）：entry_appended 准入兜底单测。
// 白名单外的簿记条目（未知 custom/custom_message/其他顶层类型、非 user/assistant 的
// message 内层）携有效字符串 id 一律入列为不可见图节点；可见性口径 D7 不变：
// buildMessageItems 渲染分类门照旧收紧（未知 custom、display!=true 的 custom_message、
// toolResult 内层一律零渲染行），窗口态与 REST 全量态可见集不发散。
// 场景 ②④ 与 malformed 探针为纯 store 行为（直接 applyWireEvent）；场景 ①③ 的修复
// 触发面走 SSE 分发层（event-dispatch），修复取数以 api.listMessages spy 计数。
// 环境说明同 messages-branch-path.test.ts：node 环境、@ts-nocheck + 动态 import。
// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");
const { useSessionsStore } = await import("@/stores/sessions");
const { dispatchSseEvent, resetDispatchState } = await import("@/lib/event-dispatch");
const { api } = await import("@/lib/api");
const { filterEntriesToPath } = await import("@/components/chat/branch-path-data");
const { buildMessageItems } = await import("@/components/chat/message-items");

const SID = "t1-admission";

function msgEntry(id, parentId, role = "user", text = id) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }] },
  };
}

const SEED = [msgEntry("t1", null), msgEntry("a1", "t1", "assistant")];

const ORIGINAL_LIST = api.listMessages;
let cursorSeq = 100;

beforeEach(() => {
  cursorSeq = 100;
  useMessagesStore.setState({ bySession: {}, replayRecovering: false });
  useSessionsStore.setState({ runStates: {}, byProject: {} });
  resetDispatchState();
  api.listMessages = ORIGINAL_LIST;
});

afterEach(() => {
  api.listMessages = ORIGINAL_LIST;
  resetDispatchState();
});

const st = () => useMessagesStore.getState().bySession[SID];

function seedSlot(extra = {}) {
  useMessagesStore.getState().setEntries(SID, SEED, "a1", "a1");
  useMessagesStore.setState((s) => ({
    bySession: { ...s.bySession, [SID]: { ...s.bySession[SID], viewLeafId: null, ...extra } },
  }));
}

/** 生产 chat-view 可见条目总门（isRenderableEntry 四型并集 + 有效 id）同构镜像 */
function isRenderableEntry(e) {
  return (
    typeof e.id === "string" &&
    e.id !== "" &&
    (e.type === "message" || e.type === "custom_message" || e.type === "custom" || e.type === "model_change")
  );
}

/** chat-view messageEntries 同构管线：路径过滤后经 buildMessageItems 组装可见 items */
function itemsOf(slot = st()) {
  const { windowEntries } = filterEntriesToPath(slot.entries, slot.viewLeafId, slot.leafId, isRenderableEntry);
  return buildMessageItems(windowEntries.filter(isRenderableEntry), {
    hasStreamingMessage: false,
    interrupted: false,
  });
}

/** 消息气泡 id 序列（入口 kind="entry" 的 entryId） */
const bubbleIds = (items) => items.filter((it) => it.kind === "entry").map((it) => it.entryId);

/** 任一 item 形态（key/entryId/entryIds）是否引用该条目 id */
function itemRefersTo(items, id) {
  return items.some(
    (it) => it.key === id || it.entryId === id || (Array.isArray(it.entryIds) && it.entryIds.includes(id)),
  );
}

/** 消息可见窗 id 序列（路径连续断言用；路径回溯在全类型 entries 上进行） */
function messageWindowIds(slot = st()) {
  return filterEntriesToPath(slot.entries, slot.viewLeafId, slot.leafId, (e) => e.type === "message")
    .windowEntries.map((e) => e.id);
}

/** 活会话帧分发（envelope 同 events.ts 形态；游标单调递增不触回退分支） */
function emitWire(event) {
  dispatchSseEvent(event.type, JSON.stringify({ event }), ++cursorSeq);
}

/** 确定性两拍宏任务 flush（同 event-dispatch-graph-repair.test.ts 惯例；无真实时序依赖） */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("webui-refetch-storm 任务 1：entry_appended 准入兜底", () => {
  test("① 未知 customType 簿记入列：零可见 item、后续 message 路径连续、修复 fetch 计数 0", async () => {
    seedSlot({ streaming: true });
    let fetchCalls = 0;
    api.listMessages = (sessionId, _opts) => {
      fetchCalls++;
      return Promise.resolve({ sessionId, entries: SEED, leafId: "a1", cursor: "a1", hasMore: false, oldestId: null });
    };
    // 引擎嫁接位簿记链增量：未知 customType（白名单外）+ 挂其下的后续消息
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: { type: "custom", id: "bk", parentId: "a1", customType: "graft" },
    });
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: {
        type: "message",
        id: "u2",
        parentId: "bk",
        message: { role: "user", content: [{ type: "text", text: "嫁接后续腿" }], timestamp: 1 },
      },
    });
    const s = st();
    expect(s.entries.some((e) => e.id === "bk")).toBe(true); // 兜底入列（不可见图节点）
    expect(s.leafId).toBe("u2"); // 沿簿记链延伸当前路径推叶
    expect(bubbleIds(itemsOf(s))).toEqual(["t1", "a1", "u2"]); // bk 零可见 item，消息气泡齐全
    expect(itemRefersTo(itemsOf(s), "bk")).toBe(false);
    // 路径连续：消息窗 t1→a1→u2 穿过 bk，无悬空
    const path = filterEntriesToPath(s.entries, s.viewLeafId, s.leafId, (e) => e.type === "message");
    expect(messageWindowIds(s)).toEqual(["t1", "a1", "u2"]);
    expect(path.path.hasPartialPath).toBe(false);
    await flush();
    await flush();
    expect(fetchCalls).toBe(0); // 父在图（bk 已兜底入列）→ 修复面不触发
  });

  test("② custom_message：display=true 未知 customType 占位行与全量态同形；display=false 零可见行", () => {
    // REST 全量态参照：setEntries 直接入列（不过滤）——占位行即全量态可见面
    useMessagesStore.getState().setEntries(
      SID,
      [
        ...SEED,
        {
          type: "custom_message",
          id: "cm-rest",
          parentId: "a1",
          customType: "some.engine.note",
          display: true,
          content: "全量态占位",
        },
      ],
      "cm-rest",
      "cm-rest",
    );
    // SSE 增量态：display=true 未知 customType 经 entry_appended 到达
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "entry_appended",
      entry: {
        type: "custom_message",
        id: "cm-live",
        parentId: "cm-rest",
        customType: "some.engine.note",
        display: true,
        content: "增量占位",
      },
    });
    let s = st();
    expect(s.entries.some((e) => e.id === "cm-live")).toBe(true); // 兜底入列（图节点）
    const items = itemsOf(s);
    expect(items.filter((it) => it.kind === "customMessage").map((it) => it.entryId)).toEqual([
      "cm-rest",
      "cm-live",
    ]); // 窗口态与全量态可见集不发散（同构占位行）
    // display=false：引擎明示不展示——入列（图节点）但渲染分类门零可见行
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "entry_appended",
      entry: {
        type: "custom_message",
        id: "cm-hidden",
        parentId: "cm-live",
        customType: "some.engine.note",
        display: false,
        content: "引擎明示不展示",
      },
    });
    s = st();
    expect(s.entries.some((e) => e.id === "cm-hidden")).toBe(true);
    expect(itemRefersTo(itemsOf(s), "cm-hidden")).toBe(false);
    expect(itemsOf(s).filter((it) => it.kind === "customMessage").map((it) => it.entryId)).toEqual([
      "cm-rest",
      "cm-live",
    ]);
  });

  test("③ 真丢帧（父 id 不在页内且不在增量）仍恰触发一次修复", async () => {
    seedSlot({ streaming: true });
    const REPAIRED = [
      ...SEED,
      { type: "custom", id: "tbk", parentId: "a1", customType: "turn-context" },
      msgEntry("u4", "tbk", "user", "分支四完成"),
      msgEntry("a4", "u4", "assistant", "分支四完成。"),
    ];
    let fetchCalls = 0;
    api.listMessages = (sessionId, _opts) => {
      fetchCalls++;
      return Promise.resolve({ sessionId, entries: REPAIRED, leafId: "a4", cursor: "a4", hasMore: false, oldestId: null });
    };
    // 兜底不吞修复面：tbk 帧真丢（未发），u4.parentId 悬空 → 分发层触发全量重取
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: {
        type: "message",
        id: "u4",
        parentId: "tbk",
        message: { role: "user", content: [{ type: "text", text: "分支四完成" }], timestamp: 1 },
      },
    });
    await flush();
    await flush();
    expect(fetchCalls).toBe(1); // 恰一次全量重取
    const s = st();
    expect(s.entries.some((e) => e.id === "tbk")).toBe(true); // 祖先链补齐
    expect(s.leafId).toBe("a4"); // 活叶锚定
    expect(messageWindowIds(s)).toEqual(["t1", "a1", "u4", "a4"]); // 新分支完整可见
  });

  test("④ role=toolResult 的 message 条目入列且不可见、路径连续", () => {
    seedSlot();
    // 多腿回合簿记内层：不再丢弃，兜底入列
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "entry_appended",
      entry: {
        type: "message",
        id: "tr1",
        parentId: "a1",
        message: { role: "toolResult", content: [{ type: "text", text: "工具结果" }], timestamp: 1 },
      },
    });
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "entry_appended",
      entry: {
        type: "message",
        id: "a2",
        parentId: "tr1",
        message: { role: "assistant", content: [{ type: "text", text: "下一腿" }], timestamp: 1 },
      },
    });
    const s = st();
    expect(s.entries.some((e) => e.id === "tr1")).toBe(true); // 兜底入列
    expect(s.leafId).toBe("a2"); // 穿过 tr1 延伸当前路径
    expect(bubbleIds(itemsOf(s))).toEqual(["t1", "a1", "a2"]); // tr1 不可见（结果由 ToolCard 关联展示）
    expect(itemRefersTo(itemsOf(s), "tr1")).toBe(false);
    // 路径连续：回溯穿过 tr1 无悬空
    const path = filterEntriesToPath(s.entries, s.viewLeafId, s.leafId, (e) => e.type === "message");
    expect(messageWindowIds(s)).toEqual(["t1", "a1", "tr1", "a2"]);
    expect(path.path.hasPartialPath).toBe(false);
  });

  test("malformed_input：缺 id/空 id/null 载荷跳过不抛错，后续有效条目照常入列", () => {
    seedSlot();
    const before = st().entries.length;
    expect(() =>
      useMessagesStore.getState().applyWireEvent(SID, { type: "entry_appended", entry: null }),
    ).not.toThrow();
    expect(() =>
      useMessagesStore.getState().applyWireEvent(SID, { type: "entry_appended", entry: 42 }),
    ).not.toThrow();
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "entry_appended",
      entry: { type: "custom", customType: "no-id" },
    });
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "entry_appended",
      entry: { type: "custom", id: "", customType: "empty-id" },
    });
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "entry_appended",
      entry: { type: "message", id: "", message: { role: "user", content: [] } },
    });
    const s = st();
    expect(s.entries.length).toBe(before); // 无垃圾节点
    expect(s.leafId).toBe("a1"); // 叶不动
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "entry_appended",
      entry: { type: "custom", id: "bk-ok", parentId: "a1", customType: "fine" },
    });
    expect(st().entries.some((e) => e.id === "bk-ok")).toBe(true);
    expect(st().leafId).toBe("bk-ok");
  });
});
