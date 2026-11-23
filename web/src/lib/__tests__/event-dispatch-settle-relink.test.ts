// webui-refetch-storm 任务 7（F3 stage-B 真浏览器实锤回归）：落定和解跨 custom 父链丢条目根修。
// F3 实录（.omo/evidence/webui-refetch-storm/task-6-stageB/）：17k 会话贴底发消息，回合落定后
// 本轮用户消息 + 助手回复从投影消失（fe.scroll items 53→52），磁盘父链完整（记忆卡 →
// session-lifecycle custom → user → assistant），重载全量恢复。根因（服务端日志实证）：
// 引擎把回合簿记（session-lifecycle）以 wire type "session_lifecycle" 帧发布（载荷为运行
// 快照，不携磁盘条目 id/parentId），store 永不入列该图节点 → user 消息以悬空 parentId
// 入列 → advanceLeaf「延伸当前路径」永不命中，叶冻在记忆卡；叶→根路径投影把叶的
// 后代（本轮全部条目）排除——回合内容 live 全程不可见，落定时刻流式占位项消失即呈现
// 为 items 回退。窗口内零 /api/messages 请求（悬空修复未触发），全量路径正确。
// 修复口径 = 分支树投影「parentId 跨滤重链」的叶推进面：活回合增量携悬空 parentId 的
// 新条目按追加式文件语义视为当前路径的延伸（引擎叶解析同口径：沿 parentId 上溯穿过
// session-lifecycle/work-custody/child-lifecycle 簿记条目）。本文件锁定：
// ① F3 帧序回归（条目全程可见 + 投影成员单调不降 + 稳定态零修复请求）
// ② 引擎源码形态变体（entry_appended 携悬空 parentId）——修复触发与可见性兼得
// ③ 多级 custom 嵌套（custom→custom→message）同样保留
// ④ 对照：真丢帧（父 id 全局缺席）仍走图谱修复恰一次，活条目不丢
// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");
const { useSessionsStore } = await import("@/stores/sessions");
const { dispatchSseEvent, resetDispatchState } = await import("@/lib/event-dispatch");
const { api } = await import("@/lib/api");
const { filterEntriesToPath, advanceLeaf } = await import("@/components/chat/branch-path-data");

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

function userMsg(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1700000000000 };
}

/** F3 同构种子：主干 + 上一回合记忆卡（叶=memA，即开场 fe.scroll items 基线的替身） */
const TAIL = [
  msgEntry("t1", null),
  msgEntry("a1", "t1", "assistant"),
  { type: "custom", id: "memA", parentId: "a1", customType: "omo-memory:accepted-turns", data: {} },
];

/** 完整磁盘真相（修复页/重载形态）：回合簿记链在场 */
const FULLPAGE = [
  ...TAIL,
  { type: "custom", id: "memB", parentId: "memA", customType: "omo-memory:accepted-turns", data: {} },
  { type: "custom", id: "lifecycleB", parentId: "memB", customType: "session-lifecycle", data: {} },
  msgEntry("b92eafe6", "lifecycleB", "user", "回复一个字：好"),
  msgEntry("9e73abff", "b92eafe6", "assistant", "好"),
];

function seedSlot(extra = {}) {
  useMessagesStore.getState().setEntries(SID, TAIL, "memA", "memA", { hasMore: true, oldestId: "t1" });
  useMessagesStore.setState((s) => ({
    bySession: { ...s.bySession, [SID]: { ...s.bySession[SID], viewLeafId: null, ...extra } },
  }));
  useSessionsStore.setState({ runStates: { [SID]: "idle" }, byProject: {} });
}

let cursorSeq = 100;
function emitWire(event) {
  dispatchSseEvent(event.type, JSON.stringify({ event, durableSessionId: SID }), ++cursorSeq);
}

/** 渲染投影口径（chat-view messageEntries 同构：message 系条目门 + 叶路径过滤） */
function visibleIds() {
  const st = useMessagesStore.getState().bySession[SID];
  return filterEntriesToPath(st.entries, st.viewLeafId, st.leafId, (e) => {
    if (e.type !== "message" || typeof e.id !== "string") return false;
    const m = e.message;
    return Boolean(m && typeof m.role === "string");
  }).windowEntries.map((e) => e.id);
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

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("任务 7：落定和解跨 custom 父链丢条目根修（F3 回归）", () => {
  test("① F3 帧序：流式录取跨 custom 父链（wire 不携 parentId）→ 回合条目全程可见、投影成员单调不降、零修复请求", async () => {
    seedSlot();
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve({
        sessionId,
        entries: FULLPAGE,
        leafId: "9e73abff",
        cursor: "9e73abff",
        hasMore: false,
        oldestId: null,
      });
    };
    const seen: string[][] = [];
    const snap = () => {
      seen.push(visibleIds());
      return seen[seen.length - 1];
    };

    // 10143：本轮记忆卡（accepted-turns，父在场链式）——F3 中 items 51→52
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: { type: "custom", id: "memB", parentId: "memA", customType: "omo-memory:accepted-turns", data: {} },
    });
    snap();
    expect(visibleIds()).toEqual(["t1", "a1"]); // 记忆卡走 marker 通道，消息门计数不变

    // 10144/10149：session_lifecycle wire 帧（快照形态无 entry id/parentId）——store 零变化
    emitWire({ type: "session_lifecycle", sessionId: SID, lifecycle: { state: "running", seq: 3, epoch: 1 } });
    emitWire({ type: "session_lifecycle", sessionId: SID, lifecycle: { state: "running", seq: 4, epoch: 1 } });
    snap();
    expect(useMessagesStore.getState().bySession[SID].entries.some((e) => e.id === "lifecycleB")).toBe(false);

    // 10151 agent_start：回合在途
    emitWire({ type: "agent_start", sessionId: SID });
    expect(useMessagesStore.getState().bySession[SID].streaming).toBe(true);

    // 10153/10154：user echo message 帧携悬空 parentId（F3 实证形态：message 帧带父链接，
    // 落在 store 永不准入的 session-lifecycle 节点下；合成孪生先入列）
    emitWire({ type: "message_start", sessionId: SID, parentId: "lifecycleB", message: userMsg("回复一个字：好") });
    const twinIds = useMessagesStore
      .getState()
      .bySession[SID].entries.filter((e) => typeof e.id === "string" && e.id.startsWith("h"))
      .map((e) => e.id);
    expect(twinIds.length).toBe(1); // 合成孪生入列（真实 id 帧未到）
    snap();
    expect(visibleIds()).toContain(twinIds[0]); // 悬空父不冻结视图：孪生经重链即时可见
    emitWire({ type: "message_end", sessionId: SID, parentId: "lifecycleB", message: userMsg("回复一个字：好") });
    snap();

    // 10155：entry_appended 真实 id（F3 实测零修复请求 ⇒ wire 条目不携 parentId）
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: { type: "message", id: "b92eafe6", message: userMsg("回复一个字：好") },
    });
    snap();
    const stUser = useMessagesStore.getState().bySession[SID];
    expect(stUser.entries.some((e) => e.id === "b92eafe6")).toBe(true);
    // 核心回归位：用户消息可见（孪生收敛 + 叶推进过悬空缺口），投影含本轮
    expect(visibleIds()).toContain("b92eafe6");
    expect(stUser.leafId).toBe("b92eafe6");

    // 10157 assistant 流式 → 10194 message_end 定格孪生 → 10195 真实 id 条目
    emitWire({
      type: "message_start",
      sessionId: SID,
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
    });
    snap();
    emitWire({
      type: "message_end",
      sessionId: SID,
      message: { role: "assistant", content: [{ type: "text", text: "好" }] },
    });
    snap();
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: msgEntry("9e73abff", "b92eafe6", "assistant", "好"),
    });
    snap();
    const visAfterTurn = visibleIds();
    expect(visAfterTurn).toContain("b92eafe6");
    expect(visAfterTurn).toContain("9e73abff");
    expect(useMessagesStore.getState().bySession[SID].leafId).toBe("9e73abff");

    // 10196/10200/10201：turn_end / agent_end / agent_settled——落定时刻投影不丢
    emitWire({
      type: "turn_end",
      sessionId: SID,
      message: { role: "assistant", content: [{ type: "text", text: "好" }] },
    });
    emitWire({ type: "agent_end", sessionId: SID });
    emitWire({ type: "agent_settled", sessionId: SID });
    snap();
    const visSettled = visibleIds();
    expect(visSettled).toContain("b92eafe6");
    expect(visSettled).toContain("9e73abff");

    // 投影成员单调不降（F3 症状 = items 回退）：检查点上仍在于 store 的条目一经可见不得
    // 从投影消失；合成孪生允许被真实 id 收敛（收敛后已不在 entries，自然豁免）
    const finalIds = new Set(
      useMessagesStore.getState().bySession[SID].entries.map((e) => e.id).filter((id) => typeof id === "string"),
    );
    for (let i = 1; i < seen.length; i++) {
      for (const id of seen[i - 1]) {
        if (!finalIds.has(id)) continue; // 已被真值收敛的孪生：豁免
        expect(seen[i], `检查点 ${i} 丢失 ${id}`).toContain(id);
      }
    }
    await flush();
    expect(calls).toEqual([]); // 稳定态零 /api/messages（修复风暴口径不回归）
  });

  test("② 变体（引擎源码形态）：entry_appended 携悬空 parentId——触发前即可见，修复仍恰一次", async () => {
    seedSlot();
    useSessionsStore.setState({ runStates: { [SID]: "running" } });
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve({
        sessionId,
        entries: FULLPAGE,
        leafId: "9e73abff",
        cursor: "9e73abff",
        hasMore: false,
        oldestId: null,
      });
    };
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: msgEntry("b92eafe6", "lifecycleB", "user", "回复一个字：好"),
    });
    // 触发前同步态：条目在列且已可见（叶推进不再冻死视图等修复）
    const st0 = useMessagesStore.getState().bySession[SID];
    expect(st0.entries.some((e) => e.id === "b92eafe6")).toBe(true);
    expect(visibleIds()).toContain("b92eafe6");
    await flush();
    expect(calls).toEqual([{ sessionId: SID, opts: { full: true } }]); // 真实图谱缺口仍修复恰一次
    const st = useMessagesStore.getState().bySession[SID];
    expect(st.entries.some((e) => e.id === "lifecycleB")).toBe(true); // 祖先链补齐
    expect(visibleIds()).toEqual(["t1", "a1", "b92eafe6", "9e73abff"]);
  });

  test("③ 多级 custom 嵌套（custom→custom→message）：叶推进穿过缺席链", () => {
    seedSlot();
    useSessionsStore.setState({ runStates: { [SID]: "running" } });
    // 第一级 custom 簿记（父 ghost0 缺席）——准入兜底入列 + 叶重链推进
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: { type: "custom", id: "c1", parentId: "ghost0", customType: "turn-context", data: {} },
    });
    expect(useMessagesStore.getState().bySession[SID].leafId).toBe("c1");
    // 第二级 custom（父 c1 在场）+ message（父链 c2→c1 逐级在场延伸）
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: { type: "custom", id: "c2", parentId: "c1", customType: "oauth", data: {} },
    });
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: msgEntry("u1", "c2", "user", "跨两级簿记的消息"),
    });
    const vis = visibleIds();
    expect(vis).toContain("u1");
    expect(useMessagesStore.getState().bySession[SID].leafId).toBe("u1");
    // 叶→根回溯撞缺席祖先（c1 的父 ghost0 不在列）：hasPartialPath 置位语义保持，不空屏
  });

  test("④ 对照：真丢帧（父条目帧全局丢失）→ 修复恰一次，祖先补齐、条目随修复页恢复可见", async () => {
    seedSlot();
    useSessionsStore.setState({ runStates: { [SID]: "running" } });
    // 修复页 = 触发时刻后的完整磁盘真相：丢失的簿记祖先 tbk-lost 与其子消息 uX 均已落盘
    const REPAIRED = [
      ...FULLPAGE,
      { type: "custom", id: "tbk-lost", parentId: "9e73abff", customType: "turn-context", data: {} },
      msgEntry("uX", "tbk-lost", "user", "父帧丢失的消息"),
    ];
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve({
        sessionId,
        entries: REPAIRED,
        leafId: "uX",
        cursor: "uX",
        hasMore: false,
        oldestId: null,
      });
    };
    // 真丢帧形态：wire 条目携真实父 id（磁盘真相），但该父条目的 entry_appended 帧已丢
    emitWire({
      type: "entry_appended",
      sessionId: SID,
      entry: msgEntry("uX", "tbk-lost", "user", "父帧丢失的消息"),
    });
    await flush();
    expect(calls).toEqual([{ sessionId: SID, opts: { full: true } }]); // 修复恰一次
    const st = useMessagesStore.getState().bySession[SID];
    expect(st.entries.some((e) => e.id === "tbk-lost")).toBe(true); // 祖先由修复页补齐
    expect(st.entries.some((e) => e.id === "uX")).toBe(true); // 真实条目保留
    expect(visibleIds()).toContain("uX"); // 修复页落地后可见
  });
});

describe("任务 7：advanceLeaf 悬空父重链口径（branch-path-data 单元）", () => {
  const list = [msgEntry("a1", null), msgEntry("a2", "a1", "assistant")];
  test("默认关闭：悬空父保持离径不拽（既有契约不回归）", () => {
    expect(advanceLeaf("a1", list, "n1", "ghost", false)).toBe("a1");
    expect(advanceLeaf("a1", list, "n1", null, false)).toBe("a1");
  });
  test("开启重链：悬空父的新条目视为当前路径延伸；无父（根声明）与已在列不推", () => {
    expect(advanceLeaf("a1", list, "n1", "ghost", false, true)).toBe("n1");
    expect(advanceLeaf("a1", list, "n1", "a1", false, true)).toBe("n1"); // 在场父照常延伸
    expect(advanceLeaf("a1", list, "n1", null, false, true)).toBe("a1"); // 无父=根声明，不重链
    expect(advanceLeaf("a1", list, "n1", "ghost", true, true)).toBe("a1"); // 重放幂等回填不推
  });
});
