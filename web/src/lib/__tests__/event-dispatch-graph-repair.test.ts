// task-10 缺陷 I（fix7）：编辑位发送后实时视图冻死空/残视图（QA attempt-8 实证：
// 服务端回合完成、SSE 帧全达且派发、连接健康、零错误，但 0 气泡无 pager 直到 reload）。
// 机制（attempt-8 estep2 + 本轮代码核实）：引擎在导航嫁接位与 user 消息之间插入回合
// 簿记链（oauth/env/custom/custom_message），SSE entry_appended 白名单只放行
// message/compaction/task-completion/memory 条目——簿记链永不入列 → 增量悬空 →
// advanceLeaf「延伸当前路径」永不命中（排队变体叶冻死嫁接尾 0 气泡）/孪生吸收拖叶
// （直发变体路径截断只显新消息）→ 兄弟派生无组。修复：分发层在活回合消息增量携悬空
// parentId 时触发全量重取重建图谱（并集合并+活叶锚定，store.repairEntriesGraph）；
// refetchSession 回合内不盲落地（迟滞到回合收尾后并集落地，杀 items N↔M 振荡类）。
// 本文件覆盖：①触发与图谱治愈（estep2 排队变体同构）②三重守卫不误触
// ③回合内迟滞整替不回拉视图、回合收尾并集落地不丢活条目。
// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");
const { useSessionsStore } = await import("@/stores/sessions");
const { dispatchSseEvent, resetDispatchState, GAP_INCREMENTAL_WINDOW } = await import("@/lib/event-dispatch");
const { api } = await import("@/lib/api");
const { filterEntriesToPath, deriveSiblingPositions } = await import("@/components/chat/branch-path-data");

const SID = "s1";

function msgEntry(id, parentId, role = "user", text = id) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }] },
  };
}

/** estep2 同构种子：主干 + 分支三嫁接链 + 编辑位嫁接尾 bk4（文件叶/引擎叶均 bk4）。
 *  发送后态：followLiveTurn 已解钉（viewLeafId=null）、streaming=true（排队投递后
 *  agent_start 已到）——本轮被测的活跟活叶用户。 */
const SEED = [
  msgEntry("t1", null),
  msgEntry("a1", "t1", "assistant"),
  { type: "custom", id: "bk3", parentId: "a1", customType: "graft" },
  msgEntry("u3", "bk3", "user", "分支三完成"),
  msgEntry("a3", "u3", "assistant", "分支三回答"),
  { type: "custom", id: "bk4", parentId: "a1", customType: "graft" }, // 编辑位（文件尾）
];

/** 服务端完整真相（修复页）：嫁接尾与 u4 之间的回合簿记链 tbk 在场 */
const REPAIRED = [
  ...SEED,
  { type: "custom", id: "tbk", parentId: "bk4", customType: "turn-context" },
  msgEntry("u4", "tbk", "user", "分支四完成"),
  msgEntry("a4", "u4", "assistant", "分支四完成。"),
];

function seedSlot(extra = {}) {
  useMessagesStore.getState().setEntries(SID, SEED, "bk4", "bk4");
  useMessagesStore.setState((s) => ({
    bySession: { ...s.bySession, [SID]: { ...s.bySession[SID], viewLeafId: null, ...extra } },
  }));
}

/** 活会话帧分发（envelope 同 events.ts 形态；游标单调递增不触回退分支） */
let cursorSeq = 100;
function emitWire(event) {
  dispatchSseEvent(event.type, JSON.stringify({ event }), ++cursorSeq);
}

function renderableIds() {
  const st = useMessagesStore.getState().bySession[SID];
  return filterEntriesToPath(st.entries, st.viewLeafId, st.leafId, (e) => e.type === "message").windowEntries.map(
    (e) => e.id,
  );
}

const ORIGINAL_LIST = api.listMessages;
let calls = [];

beforeEach(() => {
  calls = [];
  cursorSeq = 100;
  useMessagesStore.setState({ bySession: {}, replayRecovering: false });
  useSessionsStore.setState({ runStates: {}, byProject: {} });
  resetDispatchState();
});

afterEach(() => {
  api.listMessages = ORIGINAL_LIST;
  resetDispatchState();
});

describe("缺陷 I（fix7）：悬空父增量触发图谱修复", () => {
  test("① 活回合悬空父消息增量 → full=1 重建图谱，路径完整 + pager 派生（estep2 排队变体：叶冻死嫁接尾 0 气泡）", async () => {
    seedSlot({ streaming: true });
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve({ sessionId, entries: REPAIRED, leafId: "a4", cursor: "a4", hasMore: false, oldestId: null });
    };
    // 引擎增量：u4.parentId=tbk（回合簿记链尾）不在本地图谱（SSE 白名单永不入列）
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: { type: "message", id: "u4", parentId: "tbk", message: u4Msg() },
    });
    // 症状位（触发前同步态）：叶冻死嫁接尾（排队变体无孪生吸收拖叶）
    const st0 = useMessagesStore.getState().bySession[SID];
    expect(st0.entries.some((e) => e.id === "u4")).toBe(true);
    expect(st0.leafId).toBe("bk4");
    expect(renderableIds()).toEqual(["t1", "a1"]); // 0 新气泡（u4 悬空掉路径外）

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ sessionId: SID, opts: { full: true } }]); // 恰一次全量重取
    const st = useMessagesStore.getState().bySession[SID];
    expect(st.entries.some((e) => e.id === "tbk")).toBe(true); // 簿记祖先链补齐
    expect(st.leafId).toBe("a4"); // 活叶锚定（新页文件叶=回合尾）
    expect(renderableIds()).toEqual(["t1", "a1", "u4", "a4"]); // 新分支完整可见
    // pager 派生：u3/u4 经生效父归一（tbk→bk4→a1 气泡级）同组 ‹2/2›
    const pos = deriveSiblingPositions(st.entries);
    expect(pos.get("u4")).toEqual({ index: 1, count: 2, prevId: "u3", nextId: null });
    expect(st.viewLeafId).toBe(null); // 回跟活叶态保持
    expect(st.streaming).toBe(true); // 活回合流式不清
  });

  test("①b 排队投递形态：无 agent_start（streaming=false）但 runState=running/waiting —— 同样触发（两轮探针实证形态）", async () => {
    seedSlot({ streaming: false }); // 排队投递：整回合无新 agent_start，streaming 恒 false
    useSessionsStore.setState({ runStates: { [SID]: "running" } }); // 权威/发送链已落 running
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve({ sessionId, entries: REPAIRED, leafId: "a4", cursor: "a4", hasMore: false, oldestId: null });
    };
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: { type: "message", id: "u4", parentId: "tbk", message: u4Msg() },
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ sessionId: SID, opts: { full: true } }]);
    const st = useMessagesStore.getState().bySession[SID];
    expect(st.leafId).toBe("a4");
    expect(renderableIds()).toEqual(["t1", "a1", "u4", "a4"]);
    expect(st.streaming).toBe(false); // 不虚构流式态
    // Ask 提问把 runState 打成 waiting（二轮探针末段腿形态）：回合仍在途，后续悬空腿照样修
    useSessionsStore.setState({ runStates: { [SID]: "waiting" } });
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: { type: "message", id: "a6", parentId: "tbk2", message: { role: "assistant", content: [{ type: "text", text: "末段腿" }] } },
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(2); // waiting 态同样触发（对旧门：waiting 不入触发面必漏）
  });

  test("② 三重守卫不误触：非在途回合 / 视图钉住 / 父在场——零重取", async () => {
    // (a) 非在途回合（streaming 与 runState 双 false，idle 他端追加）：不修
    seedSlot({ streaming: false });
    api.listMessages = () => {
      calls.push("a");
      return Promise.resolve({ entries: REPAIRED, leafId: "a4", cursor: "a4" });
    };
    emitWire({ type: "entry_appended", sessionId: SID, entry: { type: "message", id: "u4", parentId: "tbk", message: u4Msg() } });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);

    // (b) 在途但视图钉住（用户显式切叶，todo 4 离径不拽）：不修
    useSessionsStore.setState({ runStates: { [SID]: "running" } });
    useMessagesStore.setState((s) => ({
      bySession: { ...s.bySession, [SID]: { ...s.bySession[SID], viewLeafId: "a3", streaming: true } },
    }));
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: { type: "message", id: "u4b", parentId: "tbk", message: u4Msg() },
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);

    // (c) 在途且解钉但父在场（图谱完整，正常链式增量）：不修
    useMessagesStore.setState((s) => ({
      bySession: { ...s.bySession, [SID]: { ...s.bySession[SID], viewLeafId: null } },
    }));
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: { type: "message", id: "u5", parentId: "bk4", message: u4Msg() },
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
  });
});

describe("缺陷 I 第二写者治理（fix7）：refetchSession 回合内迟滞整替", () => {
  test("③ 回合在途页快照不盲落地（SSE 活条目不打回、叶不回拉）；回合收尾并集落地不丢列", async () => {
    // 活回合态：SSE 已推进 u4（父在场，链式）——叶 u4
    seedSlot({ streaming: true });
    useSessionsStore.setState({ runStates: { [SID]: "running" } });
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: { type: "message", id: "u4", parentId: "bk4", message: u4Msg() },
    });
    expect(useMessagesStore.getState().bySession[SID].leafId).toBe("u4");
    // 迟到的全量重取（大 gap 触发）带回**滞后页**：不含 u4、叶还停嫁接尾
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve({ sessionId, entries: SEED, leafId: "bk4", cursor: "bk4", hasMore: false, oldestId: null });
    };
    dispatchSseEvent("gap", JSON.stringify({ from: 1, to: 1 + GAP_INCREMENTAL_WINDOW + 5 }), ++cursorSeq);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // 回合内：页迟滞未落地——SSE 活条目在列、叶不回拉（盲整替即 items N↔M 振荡类）
    expect(calls).toEqual([{ sessionId: SID, opts: { full: true } }]);
    const mid = useMessagesStore.getState().bySession[SID];
    expect(mid.entries.some((e) => e.id === "u4")).toBe(true);
    expect(mid.leafId).toBe("u4");
    // 迟滞窗内新到活条目（并集落地不丢列的证据位）
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: { type: "message", id: "a4", parentId: "u4", message: { role: "assistant", content: [{ type: "text", text: "完成。" }] } },
    });
    // 回合收尾（runState 离开 running）→ 迟滞页并集落地
    useSessionsStore.setState({ runStates: { [SID]: "idle" } });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const fin = useMessagesStore.getState().bySession[SID];
    expect(fin.entries.map((e) => e.id)).toEqual(["t1", "a1", "bk3", "u3", "a3", "bk4", "u4", "a4"]); // 页 + 活条目并集，零丢列
    expect(fin.leafId).toBe("a4"); // 叶沿页叶+活增量推进，不回拉不冻结
  });
});

function u4Msg() {
  return { role: "user", content: [{ type: "text", text: "分支四完成" }], timestamp: 1 };
}
