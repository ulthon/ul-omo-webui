// 会话分支路径纯函数单测（session-branching todo 4）：derivePathEntryIds 沿 parentId
// 回溯到根（防环/孤儿/空叶/悬空叶/自环）与 filterEntriesToPath（全类型先推导路径、
// 类型过滤在后；空路径集不启用过滤=平铺兜底）。纯数据 fixture，无时序无 DOM。
// 环境说明同 messages-paging.test.ts：@ts-nocheck + 动态 import。
// @ts-nocheck
import { describe, expect, test } from "vitest";

const { derivePathEntryIds, filterEntriesToPath, lastEntryId, advanceLeaf, resolveBranchLeaf } = await import(
  "@/components/chat/branch-path-data"
);

function msg(id, parentId, text = id) {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

const ALL = () => true;

describe("derivePathEntryIds 纯函数", () => {
  test("多分支 fixture：从叶回溯只得当前路径，兄弟分支不在集合", () => {
    const entries = [
      msg("u1", null),
      msg("a1", "u1"),
      msg("u2", "a1"),
      msg("u2x", "a1"), // 兄弟分支
      msg("a2", "u2"), // 当前叶
      msg("a2x", "u2x"), // 兄弟分支叶
    ];
    const path = derivePathEntryIds(entries, "a2");
    expect([...path.ids].sort()).toEqual(["a1", "a2", "u1", "u2"]);
    expect(path.ids.has("u2x")).toBe(false);
    expect(path.ids.has("a2x")).toBe(false);
    expect(path.hasPartialPath).toBe(false);
    expect(path.leafFound).toBe(true);
  });

  test("防环：parentId 环 A→B→A 有 visited 守卫，回溯收敛不死循环", () => {
    const entries = [msg("a", "b"), msg("b", "a"), msg("c", "a")];
    const path = derivePathEntryIds(entries, "c");
    expect([...path.ids].sort()).toEqual(["a", "b", "c"]);
    expect(path.hasPartialPath).toBe(false);
  });

  test("空叶：leafId null → 空集", () => {
    const path = derivePathEntryIds([msg("u1", null)], null);
    expect(path.ids.size).toBe(0);
    expect(path.leafFound).toBe(false);
    expect(path.hasPartialPath).toBe(false);
  });

  test("孤儿根：叶的 parentId 指向不在场 id（被压缩/丢失）→ 路径含叶且 hasPartialPath=true", () => {
    const path = derivePathEntryIds([msg("u1", null), msg("a1", "ghost")], "a1");
    expect([...path.ids]).toEqual(["a1"]);
    expect(path.hasPartialPath).toBe(true);
    expect(path.leafFound).toBe(true);
  });

  test("无 parentId 根：回溯到无父条目即根，干净收敛", () => {
    const path = derivePathEntryIds([msg("u1", null), msg("a1", "u1")], "a1");
    expect([...path.ids].sort()).toEqual(["a1", "u1"]);
    expect(path.hasPartialPath).toBe(false);
  });

  test("路径头在未加载区（尾窗分页）：窗口内条目全在路径，hasPartialPath=true", () => {
    const entries = [msg("m1", "m0"), msg("m2", "m1")]; // m0 在未加载区
    const path = derivePathEntryIds(entries, "m2");
    expect([...path.ids].sort()).toEqual(["m1", "m2"]);
    expect(path.hasPartialPath).toBe(true);
  });

  test("悬空叶（吸收竞态残留）：leafId 不在 entries → 空集 leafFound=false", () => {
    const path = derivePathEntryIds([msg("u1", null)], "gone-id");
    expect(path.ids.size).toBe(0);
    expect(path.leafFound).toBe(false);
  });

  test("自环（parentId 指向自身）不死循环", () => {
    const path = derivePathEntryIds([msg("a", "a")], "a");
    expect([...path.ids]).toEqual(["a"]);
    expect(path.hasPartialPath).toBe(false);
  });
});

describe("filterEntriesToPath（类型过滤在路径推导之后）", () => {
  test("多分支只保留当前路径条目；路径推导用全类型（tool 条目续链但不入窗）", () => {
    const entries = [
      msg("u1", null),
      { type: "toolCall", id: "t1", parentId: "u1" },
      msg("a1", "t1"), // 经 tool 条目续链——类型过滤前先推导路径
      msg("u2x", "t1"), // 兄弟分支
      msg("a2", "a1"),
    ];
    const { windowEntries, path } = filterEntriesToPath(entries, null, "a2", (e) => e.type === "message");
    expect(windowEntries.map((e) => e.id)).toEqual(["u1", "a1", "a2"]);
    expect(path.ids.has("t1")).toBe(true); // 推导链穿过 tool 条目
  });

  test("空叶/悬空叶：路径集为空不启用过滤（平铺兜底，绝不空屏）", () => {
    const entries = [msg("u1", null), msg("a1", "u1")];
    const emptyLeaf = filterEntriesToPath(entries, null, null, ALL);
    expect(emptyLeaf.windowEntries.map((e) => e.id)).toEqual(["u1", "a1"]);
    const dangling = filterEntriesToPath(entries, null, "gone", ALL);
    expect(dangling.windowEntries.length).toBe(2);
  });

  test("viewLeafId 优先于 store leafId 作为起点（todo 6 编排位语义）", () => {
    const entries = [msg("u1", null), msg("a1", "u1"), msg("a1x", "u1")];
    const { windowEntries } = filterEntriesToPath(entries, "a1x", "a1", ALL);
    expect(windowEntries.map((e) => e.id)).toEqual(["u1", "a1x"]);
  });

  test("无 id 条目防御保留（挂不上树也不因过滤丢数据）", () => {
    const entries = [
      msg("u1", null),
      { type: "message", message: { role: "user", content: [] } },
      msg("a1", "u1"),
    ];
    const { windowEntries } = filterEntriesToPath(entries, null, "a1", (e) => e.type === "message");
    expect(windowEntries.length).toBe(3);
  });
});

describe("叶推进与尾条助手（store 共用口径）", () => {
  test("lastEntryId：末条有效 id；excludeId 跳过自身（重复定格防自环）；空表 null", () => {
    expect(lastEntryId([msg("u1", null), msg("a1", "u1")])).toBe("a1");
    expect(lastEntryId([msg("u1", null), msg("a1", "u1")], "a1")).toBe("u1");
    expect(lastEntryId([])).toBe(null);
  });

  test("advanceLeaf：叶空→推进；parentId 即叶→延伸推进；叶被移除→随真值推进；离径/已存在→不拽", () => {
    const list = [msg("u1", null), msg("a1", "u1")];
    expect(advanceLeaf(null, list, "n1", "a1", false)).toBe("n1"); // 叶空（会话首条）
    expect(advanceLeaf("a1", list, "n1", "a1", false)).toBe("n1"); // 延伸当前路径
    expect(advanceLeaf("a1", [msg("u1", null)], "n1", "u1", false)).toBe("n1"); // 叶被移除（吸收/孪生收敛）
    expect(advanceLeaf("a1", list, "n1", "u1", false)).toBe("a1"); // 离径不拽
    expect(advanceLeaf("a1", list, "a1", "u1", true)).toBe("a1"); // 已在列（重放回填）不推
  });
});

describe("切视图目标叶解析 resolveBranchLeaf（task-10 缺陷 E-1）", () => {
  const asst = (id, parentId) => ({
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content: [{ type: "text", text: id }] },
  });
  const bk = (id, parentId) => ({ type: "custom", id, parentId, customType: "navigate" });

  test("QA 实测拓扑：user 兄弟 → 子树最深 assistant（绝非 user id 本身——select(user)=编辑位陷阱）", () => {
    const entries = [
      msg("seed-u", null),
      asst("fork", "seed-u"),
      msg("u1", "fork"),
      asst("a-b1", "u1"),
      bk("graft2", "fork"),
      msg("u2", "graft2"),
      asst("a-b2", "u2"),
      bk("graft3", "fork"),
      msg("u3", "graft3"),
      asst("a-b3", "u3"),
    ];
    expect(resolveBranchLeaf(entries, "u2")).toBe("a-b2");
    expect(resolveBranchLeaf(entries, "u3")).toBe("a-b3");
    expect(resolveBranchLeaf(entries, "u1")).toBe("a-b1");
  });

  test("多轮分支：user 兄弟子树取整支最深 assistant（不是首个回复）", () => {
    const entries = [
      msg("u1", null),
      asst("a1", "u1"),
      msg("u2", "a1"),
      asst("a2", "u2"),
      msg("u2b", "a2"),
      asst("a2b", "u2b"),
    ];
    expect(resolveBranchLeaf(entries, "u2")).toBe("a2b");
  });

  test("无 assistant 分支（未获回复）：确定性回退子树最后一条条目（user 自身）", () => {
    const entries = [msg("u1", null), asst("a1", "u1"), msg("u2", "a1")];
    expect(resolveBranchLeaf(entries, "u2")).toBe("u2");
  });

  test("子树尾挂簿记：最深 assistant 优先于其后 custom 尾条", () => {
    const entries = [
      msg("u1", null),
      asst("a1", "u1"),
      msg("u2", "a1"),
      asst("a2", "u2"),
      bk("tail-bk", "a2"),
    ];
    expect(resolveBranchLeaf(entries, "u2")).toBe("a2");
  });

  test("pending 提问在 assistant 之后：规约取最深 assistant（确定性优先级，配合 resume 意图消费）", () => {
    const entries = [
      msg("u1", null),
      asst("a1", "u1"),
      msg("u2", "a1"),
      asst("a2", "u2"),
      msg("u3", "a2"), // 已问未答
    ];
    expect(resolveBranchLeaf(entries, "u2")).toBe("a2");
  });

  test("seed 不在场返回 null（调用方回退原 id，resume 语义下仍安全）；children 环守卫不死循环", () => {
    expect(resolveBranchLeaf([msg("u1", null)], "nope")).toBe(null);
    const cyc = [bk("g1", "g2"), bk("g2", "g1"), msg("x", "g1"), asst("ax", "x")];
    expect(resolveBranchLeaf(cyc, "x")).toBe("ax");
  });
});
