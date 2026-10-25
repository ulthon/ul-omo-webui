// 任务 9（docs08-2026-10-23-24-batch）：gap 对账分级——小缺口 ?before= 增量补齐、
// 大缺口 / 畸形 / 无锚点保持 full=1 全量、首连空 store 零请求、合并语义（去重 /
// 保序 / 不碰活跃流式态）。与任务 8（服务端回放窗口）的联合验收即本文件 (a)/(b)。
// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");
const { dispatchSseEvent, resetDispatchState, GAP_INCREMENTAL_WINDOW } = await import("@/lib/event-dispatch");
const { api, ApiError } = await import("@/lib/api");

function entry(id: string) {
  return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
}

/** 尾窗已加载形态的会话槽（任务 16 首载语义：hasMore=true + oldestId 锚点在） */
function tailLoaded(entries) {
  return {
    entries,
    cursor: entries.at(-1)?.id ?? null,
    leafId: entries.at(-1)?.id ?? null,
    loaded: true,
    hasMore: true,
    oldestId: entries[0]?.id ?? null,
    streaming: false,
    streamingMessage: null,
    streamingEntryId: null,
    toolRuns: {},
    compacting: false,
  };
}

const ORIGINAL_LIST = api.listMessages;
let calls = [];

beforeEach(() => {
  calls = [];
  useMessagesStore.setState({ bySession: {} });
  resetDispatchState();
});

afterEach(() => {
  api.listMessages = ORIGINAL_LIST;
  resetDispatchState();
});

/** gap 帧（cursor 任意合法值，不触游标回退分支） */
function emitGap(from, to) {
  dispatchSseEvent("gap", JSON.stringify({ from, to }), 900);
}

describe("任务 9：(a) 小缺口 → 单次 ?before= 增量补齐（联合验收 t8）", () => {
  test("gap 宽度 ≤ 窗口：恰一次 ?before=<oldestId>，条目合并，无 full 请求", async () => {
    useMessagesStore.setState({
      bySession: { s1: tailLoaded([entry("e180"), entry("e181"), entry("e182")]) },
    });
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve({
        sessionId,
        entries: [entry("e178"), entry("e179"), entry("e180")], // 与既有 e180 重叠一帧
        leafId: "e180",
        cursor: "e180",
        hasMore: false,
        oldestId: "e178",
      });
    };
    emitGap(700, 899); // 宽度 200 = GAP_INCREMENTAL_WINDOW，恰在小缺口边界内
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ sessionId: "s1", opts: { before: "e180" } }]);
    const st = useMessagesStore.getState().bySession.s1;
    // 去重 + 保序：e180 不重复，旧→新单调
    expect(st.entries.map((e) => e.id)).toEqual(["e178", "e179", "e180", "e181", "e182"]);
    expect(st.hasMore).toBe(false);
    expect(st.oldestId).toBe("e178");
  });

  test("多会话：有锚点走增量，无锚点（全量加载完）走全量", async () => {
    useMessagesStore.setState({
      bySession: {
        s1: tailLoaded([entry("t1")]),
        s2: { ...tailLoaded([]), entries: [], hasMore: false, oldestId: null },
      },
    });
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve({
        sessionId,
        entries: [entry("x1")],
        leafId: "x1",
        cursor: "x1",
        hasMore: false,
        oldestId: "x1",
      });
    };
    emitGap(10, 19);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContainEqual({ sessionId: "s1", opts: { before: "t1" } });
    expect(calls).toContainEqual({ sessionId: "s2", opts: { full: true } });
    expect(calls).toHaveLength(2);
  });

  test("增量连击去重（stale_state）：对账在途时第二个 gap 不重复发射", async () => {
    let resolveFetch;
    useMessagesStore.setState({ bySession: { s1: tailLoaded([entry("t1")]) } });
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return new Promise((res) => {
        resolveFetch = res;
      });
    };
    emitGap(10, 19);
    emitGap(10, 19); // 在途连击
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    resolveFetch({ sessionId: "s1", entries: [entry("x1")], leafId: "x1", cursor: "x1", hasMore: false, oldestId: "x1" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(useMessagesStore.getState().bySession.s1.entries.map((e) => e.id)).toEqual(["x1", "t1"]);
  });

  test("cursor_invalid（锚点被压缩/截断，t8 契约 5）升级 full=1", async () => {
    useMessagesStore.setState({ bySession: { s1: tailLoaded([entry("t1")]) } });
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      if (opts?.before) return Promise.reject(new ApiError(409, "cursor_invalid", "边界失效"));
      return Promise.resolve({
        sessionId,
        entries: [entry("f1"), entry("f2")],
        leafId: "f2",
        cursor: "f2",
        hasMore: false,
        oldestId: null,
      });
    };
    emitGap(10, 19);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([
      { sessionId: "s1", opts: { before: "t1" } },
      { sessionId: "s1", opts: { full: true } },
    ]);
    expect(useMessagesStore.getState().bySession.s1.entries.map((e) => e.id)).toEqual(["f1", "f2"]);
  });

  test("其余失败静默：不升级不抛错，待下次 gap 兜底", async () => {
    useMessagesStore.setState({ bySession: { s1: tailLoaded([entry("t1")]) } });
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.reject(new ApiError(500, "boom", "x"));
    };
    expect(() => emitGap(10, 19)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ sessionId: "s1", opts: { before: "t1" } }]);
    expect(useMessagesStore.getState().bySession.s1.entries.map((e) => e.id)).toEqual(["t1"]);
  });
});

describe("任务 9：(b) 大缺口 / 畸形 gap → full=1 全量（回归保持，联合验收 t8）", () => {
  function fullPage(sessionId) {
    return {
      sessionId,
      entries: [entry("full-1"), entry("full-2")],
      leafId: "full-2",
      cursor: "full-2",
      hasMore: false,
      oldestId: null,
    };
  }

  test("宽度 > 窗口（如 t8 手动 QA 场景 gap {from:1,to:961}）走全量", async () => {
    useMessagesStore.setState({ bySession: { s1: tailLoaded([entry("e1000")]) } });
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve(fullPage(sessionId));
    };
    emitGap(1, 961); // 宽度 961 > 200
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ sessionId: "s1", opts: { full: true } }]);
    expect(useMessagesStore.getState().bySession.s1.entries.map((e) => e.id)).toEqual(["full-1", "full-2"]);
  });

  test.each([
    ["from>to", { from: 5, to: 1 }],
    ["null 界", { from: null, to: 9 }],
    ["无下界（from 缺席）", { to: 9 }],
    ["非数字 id", { from: "1", to: 9 }],
    ["from<1", { from: 0, to: 9 }],
  ])("畸形 gap（%s）降级全量不崩", async (_name, payload) => {
    useMessagesStore.setState({ bySession: { s1: tailLoaded([entry("t1")]) } });
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve(fullPage(sessionId));
    };
    expect(() => dispatchSseEvent("gap", JSON.stringify(payload), 900)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ sessionId: "s1", opts: { full: true } }]);
  });

  test("非 JSON gap 帧被信封层容错忽略（不崩、零请求，既有守卫行为）", async () => {
    useMessagesStore.setState({ bySession: { s1: tailLoaded([entry("t1")]) } });
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve(fullPage(sessionId));
    };
    // dispatchSseEvent 入口对非 JSON 帧整体容错忽略（既有行为，先于 gap 分支）：
    // 不崩、不误发请求；后续真实 gap / 游标回退仍能触发对账兑底
    expect(() => dispatchSseEvent("gap", "{not-json", 900)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
  });
});

describe("任务 9：(c) 首连空 store 的 gap → 零对账请求", () => {
  test("bySession 空时小 / 大 gap 均零 messages 请求", async () => {
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve({ sessionId, entries: [], leafId: null, cursor: null });
    };
    emitGap(1, 50);
    emitGap(1, 961);
    dispatchSseEvent("gap", "{bad", 900);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
  });
});

describe("任务 9：(d) 合并语义——去重 / 保序 / 不碰活跃流式态", () => {
  test("增量合并保留 streaming/toolRuns 活跃态，不重置 loaded/cursor", async () => {
    const streamingMsg = { role: "assistant", content: [{ type: "text", text: "半截" }] };
    useMessagesStore.setState({
      bySession: {
        s1: {
          ...tailLoaded([entry("e180"), entry("e181")]),
          streaming: true,
          streamingMessage: streamingMsg,
          streamingEntryId: "live-1",
          toolRuns: { run1: { id: "run1", status: "running" } },
        },
      },
    });
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve({
        sessionId,
        entries: [entry("e179"), entry("e180"), entry("e181")], // 大面积重叠
        leafId: "e181",
        cursor: "e181",
        hasMore: true,
        oldestId: "e179",
      });
    };
    emitGap(800, 899);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const st = useMessagesStore.getState().bySession.s1;
    expect(st.entries.map((e) => e.id)).toEqual(["e179", "e180", "e181"]); // 零重复、单调
    expect(st.streaming).toBe(true);
    expect(st.streamingMessage).toBe(streamingMsg);
    expect(st.streamingEntryId).toBe("live-1");
    expect(st.toolRuns).toEqual({ run1: { id: "run1", status: "running" } });
    expect(st.loaded).toBe(true);
    expect(st.cursor).toBe("e181");
    expect(st.hasMore).toBe(true);
    expect(st.oldestId).toBe("e179");
  });

  test("游标回退（纪元变化）仍走全量三路（resync 面不变，messages 全量）", async () => {
    useMessagesStore.setState({ bySession: { s1: tailLoaded([entry("t1")]) } });
    api.listMessages = (sessionId, opts) => {
      calls.push({ sessionId, opts });
      return Promise.resolve({ sessionId, entries: [], leafId: null, cursor: null, hasMore: false, oldestId: null });
    };
    // 旧纪元游标记账
    dispatchSseEvent("agent_start", JSON.stringify({ projectPath: "/p", event: { type: "agent_start", sessionId: "s1" } }), 100);
    // 新纪元：id 回退 → 全量（不经 gap 分级）
    dispatchSseEvent("agent_start", JSON.stringify({ projectPath: "/p", event: { type: "agent_start", sessionId: "s1" } }), 3);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ sessionId: "s1", opts: { full: true } }]);
  });
});
