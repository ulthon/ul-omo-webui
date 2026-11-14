// 叶切换编排单测（session-branching todo 6，F19 顺序契约定死）：
// 编排全序断言（navigate→清流式→full 整替→viewLeafId→usage 序号）以调用序数组取证
// （非日志，误导性成功输出防线）；navigating 互斥拒二次切换与发送；409/前置门拒绝
// 状态保持；expectedLeafId CAS 透传；replay 窗口整替推迟；迟到帧幂等；中途拆会话
// 不复活槽。纯 store + 注入 fetcher（fetchEarlierPage 同款先例），无真定时器——
// 推迟落地用订阅先行（switchLeaf 内部挂订阅）+ 手动关窗触发，微任务 flush 推进。
// 环境说明同 messages-paging.test.ts：@ts-nocheck + 动态 import。
// @ts-nocheck
import { describe, expect, test, beforeEach, vi, afterEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");
const { api, ApiError } = await import("@/lib/api");

const SID = "t6-switch-leaf";

function msgEntry(id, parentId, role = "user", text = id) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }] },
  };
}

function pageOf(entries, leafId) {
  return { sessionId: SID, entries, leafId, cursor: leafId, hasMore: false, oldestId: null };
}

const st = () => useMessagesStore.getState().bySession[SID];

/** 微任务推进（无真定时器）：async 编排在途态落定 */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** 种子槽：历史 u1→a1→u2→a2（叶 a2），预置视图叶 u1（验证整替后显式覆盖 keepView） */
function seedSlot(extra = {}) {
  useMessagesStore.getState().setEntries(
    SID,
    [msgEntry("u1", null), msgEntry("a1", "u1", "assistant"), msgEntry("u2", "a1"), msgEntry("a2", "u2", "assistant")],
    "a2",
    "a2",
  );
  useMessagesStore.setState((s) => ({
    bySession: { ...s.bySession, [SID]: { ...s.bySession[SID], viewLeafId: "u1", ...extra } },
  }));
}

const NEW_PAGE = [
  msgEntry("u1", null),
  msgEntry("a1", "u1", "assistant"),
  msgEntry("u2b", "a1"),
  msgEntry("a2b", "u2b", "assistant"),
];

/** 情景注入：navigate 在途置流式态（gate 已过、出网后迟到 message_start 同构），回簿记叶 */
function happyDeps(calls) {
  return {
    navigate: async (body) => {
      calls.push(["navigate", body.entryId, body.intent, body.expectedLeafId]);
      // 模拟导航在途时流式态被置位（SSE 帧先于回执到达）——③ 清流式必须在整替前消化它
      useMessagesStore.setState((s) => ({
        bySession: {
          ...s.bySession,
          [SID]: {
            ...s.bySession[SID],
            streaming: true,
            streamingMessage: { role: "assistant", content: [{ type: "text", text: "半截" }] },
            streamingEntryId: "h-stale",
          },
        },
      }));
      return { sessionId: SID, leafId: "bk-leaf", editorText: "第二条" };
    },
    fetchFull: async () => {
      const cur = st();
      calls.push(["fetchFull", cur.streaming === false && cur.streamingMessage === null]);
      return pageOf(NEW_PAGE, "a2b");
    },
  };
}

beforeEach(() => {
  useMessagesStore.setState({ bySession: {}, replayRecovering: false });
  useSessionsStore.setState({ runStates: {}, byProject: {} });
  useUiStore.setState({ modelsLoaded: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("switchLeaf 编排（F19 全序）", () => {
  test("(1) happy 全序：navigate→清流式→full 整替→viewLeafId=回传叶→usage 序号自增→拆防", async () => {
    seedSlot();
    const calls = [];
    const r = await useMessagesStore.getState().switchLeaf(SID, "u2", happyDeps(calls));
    // todo 8：SwitchLeafResult 透传回执 editorText（编辑重发/从此此处分支回填源）
    expect(r).toEqual({ ok: true, leafId: "bk-leaf", editorText: "第二条" });
    // 顺序断言（非日志）：navigate 先行；fetchFull 调用时点流式态已清（③ 先于 ④）
    expect(calls).toEqual([
      ["navigate", "u2", "select", "a2"],
      ["fetchFull", true],
    ]);
    const s = st();
    expect(s.entries).toBe(NEW_PAGE); // 整替=引用整换（非 cursor 增量合并）
    expect(s.leafId).toBe("a2b"); // 文件叶取自整替页
    // 回传 leafId 为唯一真相（F15）：簿记条目 id（非消息形、不在新文件）也直写，不回退
    expect(s.viewLeafId).toBe("bk-leaf");
    expect(s.leafNavSeq).toBe(1); // ⑥ usage 触发沿
    expect(s.navigating).toBe(false); // 拆防
    expect(s.streaming).toBe(false);
    expect(s.streamingMessage).toBe(null);
  });

  test("(2) expectedLeafId CAS 透传：带槽内文件叶指针（F13），空叶缺省不带", async () => {
    seedSlot();
    const seen = [];
    await useMessagesStore.getState().switchLeaf(SID, "u1", {
      navigate: async (body) => {
        seen.push(body.expectedLeafId);
        return { sessionId: SID, leafId: "bk-leaf" };
      },
      fetchFull: async () => pageOf(NEW_PAGE, "a2b"),
    });
    expect(seen).toEqual(["a2"]);
    // 空会话（叶 null）：缺省不带（服务端按无锁处理）
    useMessagesStore.setState({ bySession: {} });
    useMessagesStore.getState().setEntries(SID, [], null, null);
    await useMessagesStore.getState().switchLeaf(SID, "x", {
      navigate: async (body) => {
        seen.push(body.expectedLeafId);
        return { sessionId: SID, leafId: "x" };
      },
      fetchFull: async () => pageOf([], null),
    });
    expect(seen).toEqual(["a2", undefined]);
  });

  test("(3) navigating 互斥：在途二次切换拒 busy 且不触网；落定后可再切", async () => {
    seedSlot();
    let release;
    const calls = [];
    const p1 = useMessagesStore.getState().switchLeaf(SID, "u2", {
      navigate: (body) =>
        new Promise((res) => {
          calls.push("navigate-1");
          release = () => res({ sessionId: SID, leafId: "bk-leaf" });
        }),
      fetchFull: async () => {
        calls.push("fetchFull-1");
        return pageOf(NEW_PAGE, "a2b");
      },
    });
    await flush();
    expect(st().navigating).toBe(true);
    const navigate2 = vi.fn(async () => ({ sessionId: SID, leafId: "nope" }));
    const r2 = await useMessagesStore.getState().switchLeaf(SID, "u1", {
      navigate: navigate2,
      fetchFull: async () => pageOf([], null),
    });
    expect(r2).toEqual({ ok: false, reason: "busy" });
    expect(navigate2).not.toHaveBeenCalled(); // 二次切换零网络
    release();
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(st().navigating).toBe(false);
    // 落定后互斥释放：再切可成
    const r3 = await useMessagesStore.getState().switchLeaf(SID, "u1", happyDeps(calls));
    expect(r3.ok).toBe(true);
  });

  test("(4) navigating 互斥拒发送：api.prompt 布防期抛 409 navigating 且零网络", async () => {
    seedSlot();
    let touchedNetwork = false;
    vi.stubGlobal("fetch", () => {
      touchedNetwork = true;
      throw new Error("network-touched");
    });
    let release;
    const p1 = useMessagesStore.getState().switchLeaf(SID, "u2", {
      navigate: (body) =>
        new Promise((res) => {
          release = () => res({ sessionId: SID, leafId: "bk-leaf" });
        }),
      fetchFull: async () => pageOf(NEW_PAGE, "a2b"),
    });
    await flush();
    await expect(api.prompt(SID, { text: "hi" })).rejects.toMatchObject({
      status: 409,
      code: "navigating",
    });
    expect(touchedNetwork).toBe(false); // 守卫在出网前拦截
    release();
    await p1;
    expect(st().navigating).toBe(false);
  });

  test("(5) 409 拒绝状态保持：不整替、不清流式态、viewLeafId 不动、拆防", async () => {
    seedSlot();
    const before = st();
    let fetchCalled = false;
    const r = await useMessagesStore.getState().switchLeaf(SID, "u1", {
      navigate: async () => {
        // 在途流式态被置位（gate 已过、出网后帧到达同构），随后 409 拒绝——
        // 拒绝路径不得清它（状态保持）
        useMessagesStore.setState((s) => ({
          bySession: {
            ...s.bySession,
            [SID]: {
              ...s.bySession[SID],
              streaming: true,
              streamingMessage: { role: "assistant", content: [{ type: "text", text: "半截" }] },
            },
          },
        }));
        throw new ApiError(409, "already_processing", "回合进行中");
      },
      fetchFull: async () => {
        fetchCalled = true;
        return pageOf(NEW_PAGE, "a2b");
      },
    });
    expect(r).toEqual({ ok: false, reason: "rejected" });
    expect(fetchCalled).toBe(false); // 拒绝路径不进整替通道
    const after = st();
    expect(after.entries).toBe(before.entries); // 引用不变=零整替
    expect(after.streaming).toBe(true); // 流式态保持（不清）
    expect(after.streamingMessage).toEqual({ role: "assistant", content: [{ type: "text", text: "半截" }] });
    expect(after.viewLeafId).toBe("u1"); // 视图叶不动
    expect(after.navigating).toBe(false); // 拆防
    expect(after.leafNavSeq).toBe(0); // usage 触发沿未发生
  });

  test("(6) replay 窗口整替推迟：关窗（订阅先行）后才落地，落定沿随后发生", async () => {
    seedSlot();
    const calls = [];
    useMessagesStore.getState().beginReplayRecovery();
    let release;
    const p = useMessagesStore.getState().switchLeaf(SID, "u2", {
      navigate: async (body) => {
        calls.push("navigate");
        return { sessionId: SID, leafId: "bk-leaf" };
      },
      fetchFull: async () => {
        calls.push("fetchFull");
        return pageOf(NEW_PAGE, "a2b");
      },
    });
    await flush();
    const r = await p;
    expect(r.ok).toBe(true);
    // 整替未落地（窗口未关）：entries/viewLeafId/navigating 全保持
    expect(calls).toEqual(["navigate", "fetchFull"]);
    expect(st().entries.some((e) => e.id === "a2")).toBe(true); // 旧页仍在
    expect(st().viewLeafId).toBe("u1");
    expect(st().navigating).toBe(true); // 布防保持至落地
    expect(st().leafNavSeq).toBe(0);
    // 关窗（replay_done 同构）：订阅先行已挂，关窗即落地
    useMessagesStore.getState().endReplayRecovery();
    const s = st();
    expect(s.entries).toBe(NEW_PAGE);
    expect(s.viewLeafId).toBe("bk-leaf");
    expect(s.leafNavSeq).toBe(1);
    expect(s.navigating).toBe(false);
  });

  test("(7) 整替落地沿清流式与 replay 缓冲：推迟窗内重放重建的流式态不落新视图", async () => {
    seedSlot();
    useMessagesStore.getState().beginReplayRecovery();
    const p = useMessagesStore.getState().switchLeaf(SID, "u2", {
      navigate: async () => ({ sessionId: SID, leafId: "bk-leaf" }),
      fetchFull: async () => pageOf(NEW_PAGE, "a2b"),
    });
    await flush();
    await p;
    // 推迟窗内：旧分支流的重放帧不被前缀抑制（载荷与槽内定格条目无前缀关系）——
    // 重建流式态 + 缓冲 delta（applyWireEvent 正路，非 setState 伪装）
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "旧分支重放" }] },
    });
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "积压" },
    });
    expect(st().streaming).toBe(true);
    // 关窗：flush 把积压 delta 写入重放的流式态 → 订阅触发 apply → 清流式+清缓冲+整替
    useMessagesStore.getState().endReplayRecovery();
    const s = st();
    expect(s.streaming).toBe(false);
    expect(s.streamingMessage).toBe(null); // 半截重放不落新视图
    expect(s.entries).toBe(NEW_PAGE);
    expect(s.viewLeafId).toBe("bk-leaf");
    expect(s.navigating).toBe(false);
    // 缓冲已清：再开关一轮窗口，flush 无物可写（streamingMessage 不复活）
    useMessagesStore.getState().beginReplayRecovery();
    useMessagesStore.getState().endReplayRecovery();
    expect(st().streamingMessage).toBe(null);
    expect(st().entries).toBe(NEW_PAGE);
  });

  test("(8) 前置门并集禁用：streaming/running/waiting/探询 active 兜底四态拒且零网络零布防", async () => {
    seedSlot();
    const navigate = vi.fn(async () => ({ sessionId: SID, leafId: "bk-leaf" }));
    const deps = { navigate, fetchFull: async () => pageOf(NEW_PAGE, "a2b") };

    // streaming
    useMessagesStore.setState((s) => ({
      bySession: { ...s.bySession, [SID]: { ...s.bySession[SID], streaming: true } },
    }));
    expect(await useMessagesStore.getState().switchLeaf(SID, "u1", deps)).toEqual({
      ok: false,
      reason: "blocked",
    });
    useMessagesStore.setState((s) => ({
      bySession: { ...s.bySession, [SID]: { ...s.bySession[SID], streaming: false } },
    }));
    // runState running / waiting
    useSessionsStore.setState({ runStates: { [SID]: "running" } });
    expect(await useMessagesStore.getState().switchLeaf(SID, "u1", deps)).toEqual({
      ok: false,
      reason: "blocked",
    });
    useSessionsStore.setState({ runStates: { [SID]: "waiting" } });
    expect(await useMessagesStore.getState().switchLeaf(SID, "u1", deps)).toEqual({
      ok: false,
      reason: "blocked",
    });
    // 未见 SSE 事件（runState 缺席）+ 探询 active=true 兜底（knownRunning 同口径）
    useSessionsStore.setState({ runStates: {}, byProject: { p: [{ id: SID, active: true }] } });
    expect(await useMessagesStore.getState().switchLeaf(SID, "u1", deps)).toEqual({
      ok: false,
      reason: "blocked",
    });
    expect(navigate).not.toHaveBeenCalled(); // 前置门在出网前拦截
    expect(st().navigating).toBe(false); // 未布防（互斥位不泄漏）
    // 对照：权威 idle（active=false）放行
    useSessionsStore.setState({ runStates: { [SID]: "idle" }, byProject: { p: [{ id: SID, active: false }] } });
    const r = await useMessagesStore.getState().switchLeaf(SID, "u1", deps);
    expect(r.ok).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test("(9) 迟到帧幂等（stale 态）：整替后旧分支 message_end 伪影追加无害，不删真相不复活流式", async () => {
    seedSlot();
    await useMessagesStore.getState().switchLeaf(SID, "u2", happyDeps([]));
    // 迟到帧 A：已落库消息的 message_end 重放（settle 路径不用事件 id，落合成孪生伪影）
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "message_end",
      id: "a1",
      message: { role: "assistant", content: [{ type: "text", text: "a1" }] },
    });
    // 迟到帧 B：旧分支半截内容（无 id，同伪影路径）
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "半截" }] },
    });
    const s = st();
    expect(s.entries.length).toBe(NEW_PAGE.length + 2); // 伪影追加、真相零删除
    expect(s.entries.some((e) => e.id === "a2b")).toBe(true); // 新页真相在场
    expect(s.entries.some((e) => e.id === "u2b")).toBe(true);
    expect(s.streaming).toBe(false); // 不复活流式
    expect(s.streamingMessage).toBe(null);
    expect(s.leafId).toBe("a2b"); // 叶不因伪影回退
    expect(s.viewLeafId).toBe("bk-leaf"); // 视图叶不动
  });

  test("(10) 中途拆会话不复活槽：直接路径整替放弃；推迟路径关窗放弃；互斥位随槽拆", async () => {
    seedSlot();
    // (a) 直接路径：navigate 在途 clearSession，回执后整替静默放弃
    let release;
    const p1 = useMessagesStore.getState().switchLeaf(SID, "u2", {
      navigate: (body) =>
        new Promise((res) => {
          release = () => res({ sessionId: SID, leafId: "bk-leaf" });
        }),
      fetchFull: async () => pageOf(NEW_PAGE, "a2b"),
    });
    await flush();
    useMessagesStore.getState().clearSession(SID);
    release();
    await p1;
    expect(useMessagesStore.getState().bySession[SID]).toBeUndefined(); // 槽不复活
    // (b) 推迟路径：窗口内已推迟，槽拆后关窗即放弃（订阅拆除，零动作）
    seedSlot();
    useMessagesStore.getState().beginReplayRecovery();
    const p2 = await useMessagesStore.getState().switchLeaf(SID, "u2", {
      navigate: async () => ({ sessionId: SID, leafId: "bk-leaf" }),
      fetchFull: async () => pageOf(NEW_PAGE, "a2b"),
    });
    expect(p2.ok).toBe(true);
    useMessagesStore.getState().clearSession(SID);
    useMessagesStore.getState().endReplayRecovery();
    expect(useMessagesStore.getState().bySession[SID]).toBeUndefined();
    // (c) 槽拆后同 id 再切：无槽即 blocked（gate !cur 短路），不布防不触网
    const navigate = vi.fn(async () => ({ sessionId: SID, leafId: "x" }));
    const r = await useMessagesStore.getState().switchLeaf(SID, "u1", {
      navigate,
      fetchFull: async () => pageOf([], null),
    });
    expect(r).toEqual({ ok: false, reason: "blocked" });
    expect(navigate).not.toHaveBeenCalled();
  });

  test("(11) fetchFull 失败：navigating 拆防、不整替、viewLeafId 不动（流式已按③清）", async () => {
    seedSlot();
    const before = st();
    const r = await useMessagesStore.getState().switchLeaf(SID, "u2", {
      navigate: async () => ({ sessionId: SID, leafId: "bk-leaf" }),
      fetchFull: async () => {
        throw new ApiError(500, "internal", "网络瞬断");
      },
    });
    expect(r).toEqual({ ok: false, reason: "rejected" });
    const after = st();
    expect(after.entries).toBe(before.entries); // 零整替
    expect(after.viewLeafId).toBe("u1"); // 视图叶不动（真相未落地）
    expect(after.navigating).toBe(false); // 拆防可再切
    expect(after.leafNavSeq).toBe(0);
    expect(after.streaming).toBe(false); // ③ 已清（navigate 成功即清，F19 顺序）
    expect(after.streamingMessage).toBe(null);
  });
});
