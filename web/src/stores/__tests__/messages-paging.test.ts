// 任务 16（docs08-2026-10-22-batch）：消息 store 尾窗翻页
// - setEntries 携带 hasMore/oldestId（尾窗首载）
// - prependEntries id 去重头插：重叠窗拼缝零重复零丢失
// - resolveReachTopAction 触顶决策（before 翻页 / cursor 增量 / 不动作）
// @ts-nocheck
import { describe, expect, test, beforeEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");
const { resolveReachTopAction } = await import("@/components/chat/reach-top");

function entry(id: string): { type: string; id: string; parentId: string | null; timestamp: string } {
  return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
}
const ids = (n: number, from = 0): string[] =>
  Array.from({ length: n }, (_, i) => `e${String(from + i).padStart(5, "0")}`);
const entries = (list: string[]) => list.map(entry);
const SID = "t16-seam";

beforeEach(() => {
  useMessagesStore.setState({ bySession: {} });
});

describe("setEntries 尾窗首载", () => {
  test("携带 hasMore/oldestId，loaded=true，cursor 仍为 leafId 同源", () => {
    const store = useMessagesStore.getState();
    store.setEntries(SID, entries(ids(216, 784)), "e00999", "e00999", {
      hasMore: true,
      oldestId: "e00784",
    });
    const st = useMessagesStore.getState().bySession[SID];
    expect(st.loaded).toBe(true);
    expect(st.hasMore).toBe(true);
    expect(st.oldestId).toBe("e00784");
    expect(st.cursor).toBe("e00999");
  });

  test("全量重取（gap 对账）不传 paging：hasMore 复位 false", () => {
    useMessagesStore.getState().setEntries(SID, entries(ids(216, 784)), "e00999", "e00999", {
      hasMore: true,
      oldestId: "e00784",
    });
    useMessagesStore.getState().setEntries(SID, entries(ids(600, 0)), "e00599", "e00599");
    const st = useMessagesStore.getState().bySession[SID];
    expect(st.hasMore).toBe(false);
    expect(st.oldestId).toBeNull();
    expect(st.entries).toHaveLength(600);
  });
});

describe("prependEntries 拼缝", () => {
  test("零重复零丢失：尾窗 + 上一窗（含 16 条重叠）去重并集 = 文件连续区间", () => {
    // 尾窗：600 条文件中最新 216 条（e00384..e00599）
    useMessagesStore.getState().setEntries(SID, entries(ids(216, 384)), "e00599", "e00599", {
      hasMore: true,
      oldestId: "e00384",
    });
    // 上一窗：?before=e00384 → e00169..e00384（216 条，末条为重叠锚）
    const page2 = entries(ids(216, 169));
    useMessagesStore.getState().prependEntries(SID, page2, { hasMore: true, oldestId: "e00169" });
    const st = useMessagesStore.getState().bySession[SID];
    const got = st.entries.map((e) => e.id);
    // 无重复
    expect(new Set(got).size).toBe(got.length);
    // 无缺口：恰为 e00169..e00599 连续区间
    expect(got).toEqual(ids(431, 169));
    // 游标推进
    expect(st.oldestId).toBe("e00169");
    expect(st.hasMore).toBe(true);
    // cursor（前向增量）不被翻页覆盖
    expect(st.cursor).toBe("e00599");
  });

  test("翻到文件头：hasMore=false，窗口不足额照收", () => {
    useMessagesStore.getState().setEntries(SID, entries(ids(216, 184)), "e00399", "e00399", {
      hasMore: true,
      oldestId: "e00184",
    });
    useMessagesStore.getState().prependEntries(SID, entries(ids(184, 0)), {
      hasMore: false,
      oldestId: "e00000",
    });
    const st = useMessagesStore.getState().bySession[SID];
    expect(st.entries.map((e) => e.id)).toEqual(ids(400, 0));
    expect(st.hasMore).toBe(false);
    expect(st.oldestId).toBe("e00000");
  });
});

describe("resolveReachTopAction 触顶决策", () => {
  test("hasMore：before 翻页", () => {
    expect(resolveReachTopAction({ hasMore: true, oldestId: "e00784", cursor: "e00999" })).toEqual({
      kind: "before",
      before: "e00784",
    });
  });
  test("无更早历史：cursor 增量同步（原行为）", () => {
    expect(resolveReachTopAction({ hasMore: false, oldestId: null, cursor: "e00999" })).toEqual({
      kind: "cursor",
      cursor: "e00999",
    });
  });
  test("两者皆无 / 会话不在 store：不动作", () => {
    expect(resolveReachTopAction({ hasMore: false, oldestId: null, cursor: null })).toBeNull();
    expect(resolveReachTopAction(undefined)).toBeNull();
  });
});
