// 任务 16（docs08-2026-10-22-batch）：SSE gap 全量重取回退保持 ?full=1——
// 首载改尾窗直读后，gap/游标回退对账必须回全量不被尾窗截断。
// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");
const { refetchLoadedSessions, resetDispatchState } = await import("@/lib/event-dispatch");
const { api } = await import("@/lib/api");

function entry(id: string) {
  return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
}

const ORIGINAL_LIST = api.listMessages;
let calls: Array<{ sessionId: string; opts: unknown }> = [];

beforeEach(() => {
  calls = [];
  useMessagesStore.setState({ bySession: {} });
  resetDispatchState();
  // @ts-expect-error 测试桩
  api.listMessages = (sessionId, opts) => {
    calls.push({ sessionId, opts });
    return Promise.resolve({
      sessionId,
      entries: [entry("full-1"), entry("full-2")],
      leafId: "full-2",
      cursor: "full-2",
      hasMore: false,
      oldestId: "full-1",
    });
  };
});

afterEach(() => {
  api.listMessages = ORIGINAL_LIST;
  resetDispatchState();
});

describe("gap 全量重取 full=1 回退", () => {
  test("refetchLoadedSessions 以 {full:true} 拉全量并整替（hasMore 复位）", async () => {
    // 模拟尾窗首载后的 store 形态
    useMessagesStore.setState({
      bySession: {
        s1: {
          entries: [entry("tail-216")],
          cursor: "tail-216",
          leafId: "tail-216",
          loaded: true,
          hasMore: true,
          oldestId: "tail-216",
          streaming: false,
          streamingMessage: null,
          streamingEntryId: null,
          toolRuns: {},
          compacting: false,
        },
      },
    });
    refetchLoadedSessions();
    // 微任务排空（refetch 内部 promise 链）
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ sessionId: "s1", opts: { full: true } }]);
    const st = useMessagesStore.getState().bySession.s1;
    expect(st.entries.map((e) => e.id)).toEqual(["full-1", "full-2"]);
    expect(st.loaded).toBe(true);
    expect(st.hasMore).toBe(false);
    expect(st.oldestId).toBeNull();
  });

  test("store 外会话不拉（客户端未关心过）", async () => {
    refetchLoadedSessions();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
  });
});
