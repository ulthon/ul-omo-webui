// #27a 触顶翻页两缺陷修复回归：
// - R1：before 翻页成功不进冷却（冷却窗内 before 仍可发起；finish 不写冷却窗）；
// - R2：before/cursor 遇 409 cursor_invalid 升级 full=1 全量整替并重置翻页锚。
// @ts-nocheck
import { describe, expect, test, beforeEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");
const { ApiError } = await import("@/lib/api");
const { runReachTopSync } = await import("@/components/chat/reach-top-sync");

function entry(id: string): { type: string; id: string; parentId: string | null; timestamp: string } {
  return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
}
const ids = (n: number, from = 0): string[] =>
  Array.from({ length: n }, (_, i) => `e${String(from + i).padStart(5, "0")}`);
const entries = (list: string[]) => list.map(entry);
const SID = "t27a";

/** 假 api：记录请求序列，按入队脚本逐个应答 */
function fakeApi(responses: Array<Record<string, unknown> | Error>, calls: Array<Record<string, unknown>>) {
  const listMessages = async (_sid: string, opts?: Record<string, unknown>) => {
    calls.push({ ...(opts ?? {}) });
    const r = responses[calls.length - 1];
    if (r instanceof Error) throw r;
    return r;
  };
  return listMessages;
}

function deps(listMessages: unknown, state: { cooling: boolean; finished: Array<string> }) {
  return {
    listMessages: listMessages as never,
    coolingDown: () => state.cooling,
    begin: () => {},
    finish: (kind: "before" | "cursor") => {
      state.finished.push(kind);
      // 模拟 chat-view 真实收尾：仅 cursor 写冷却窗
      if (kind === "cursor") state.cooling = true;
    },
  };
}

beforeEach(() => {
  useMessagesStore.setState({ bySession: {} });
});

describe("R1：before 翻页不受冷却门住、成功不写冷却窗", () => {
  test("冷却窗内 before 仍可发起并成功头插", async () => {
    useMessagesStore.getState().setEntries(SID, entries(ids(216, 384)), "e00599", "e00599", {
      hasMore: true,
      oldestId: "e00384",
    });
    const calls: Array<Record<string, unknown>> = [];
    const st = { cooling: true, finished: [] as string[] }; // 冷却进行中
    await runReachTopSync(
      SID,
      deps(fakeApi([{ entries: entries(ids(216, 169)), hasMore: false, oldestId: "e00169" }], calls), st),
    );
    expect(calls).toEqual([{ before: "e00384" }]);
    const s = useMessagesStore.getState().bySession[SID];
    expect(s.entries.map((e) => e.id)).toEqual(ids(431, 169));
    expect(st.finished).toEqual(["before"]);
  });

  test("before 成功后 finish 不写冷却窗（chat-view 契约：只有 cursor 进冷却）", async () => {
    useMessagesStore.getState().setEntries(SID, entries(ids(10, 10)), "e00019", "e00019", {
      hasMore: true,
      oldestId: "e00010",
    });
    const calls: Array<Record<string, unknown>> = [];
    const st = { cooling: false, finished: [] as string[] };
    await runReachTopSync(
      SID,
      deps(fakeApi([{ entries: entries(ids(10, 0)), hasMore: false, oldestId: "e00000" }], calls), st),
    );
    // finish("before") 不得置 cooling=true
    expect(st.cooling).toBe(false);
  });
});

describe("R2：409 cursor_invalid 升级 full=1 全量整替", () => {
  test("before 撞 409 → full=1 整替，翻页锚重置为整替页锚", async () => {
    useMessagesStore.getState().setEntries(SID, entries(ids(100, 200)), "e00299", "e00299", {
      hasMore: true,
      oldestId: "e00200", // 压缩重写后失效的旧锚
    });
    const calls: Array<Record<string, unknown>> = [];
    const st = { cooling: false, finished: [] as string[] };
    await runReachTopSync(
      SID,
      deps(
        fakeApi(
          [
            new ApiError(409, "cursor_invalid", "oldest anchor no longer exists"),
            { entries: entries(ids(50, 10)), hasMore: true, oldestId: "e00010", cursor: "e00059", leafId: "e00059" },
          ],
          calls,
        ),
        st,
      ),
    );
    expect(calls).toEqual([{ before: "e00200" }, { full: true }]);
    const s = useMessagesStore.getState().bySession[SID];
    expect(s.entries.map((e) => e.id)).toEqual(ids(50, 10)); // 整替而非头插叠加
    expect(s.hasMore).toBe(true);
    expect(s.oldestId).toBe("e00010"); // 锚重置
    expect(s.cursor).toBe("e00059");
    expect(st.finished).toEqual(["before"]);
  });

  test("cursor 撞 409 保持既有升级 full=1 行为（t12 同法不回退）", async () => {
    useMessagesStore.getState().setEntries(SID, entries(ids(100, 200)), "e00299", "e00299", {
      hasMore: false,
      oldestId: null,
    });
    const calls: Array<Record<string, unknown>> = [];
    const st = { cooling: false, finished: [] as string[] };
    await runReachTopSync(
      SID,
      deps(
        fakeApi(
          [
            new ApiError(409, "cursor_invalid", "cursor no longer exists"),
            { entries: entries(ids(30, 0)), hasMore: false, oldestId: null, cursor: "e00029", leafId: "e00029" },
          ],
          calls,
        ),
        st,
      ),
    );
    expect(calls).toEqual([{ cursor: "e00299" }, { full: true }]);
    expect(useMessagesStore.getState().bySession[SID].entries.map((e) => e.id)).toEqual(ids(30, 0));
  });

  test("非 cursor_invalid 错误保持静默，不发全量", async () => {
    useMessagesStore.getState().setEntries(SID, entries(ids(10, 10)), "e00019", "e00019", {
      hasMore: true,
      oldestId: "e00010",
    });
    const calls: Array<Record<string, unknown>> = [];
    const st = { cooling: false, finished: [] as string[] };
    await runReachTopSync(
      SID,
      deps(fakeApi([new ApiError(503, "engine_not_ready", "down")], calls), st),
    );
    expect(calls).toEqual([{ before: "e00010" }]);
    // 窗口未被破坏
    expect(useMessagesStore.getState().bySession[SID].entries).toHaveLength(10);
  });
});
