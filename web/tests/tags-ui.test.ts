// 标签 UI 纯逻辑单测（todo 11；docs08-r3 C14 徽标上限 1+计数）：
// - visibleTags 徽标截断（1 个全显 / 超出 +N）
// - isOrphanTag / orphanTags 孤儿判定（挂载的 (scope,name) 不在两源定义集中）
// - nextSessionTags 选择器勾选 → 整替载荷生成
// - mergeTagOptions 过滤 chips 选项合并去重（全局 + 项目级，跨 scope 同名去重）
// - 管理弹层整替列表生成（新增/重命名/删除/上移下移）
import { describe, expect, test } from "vitest";
import {
  TAG_BADGE_LIMIT,
  appendTagEntry,
  dedupeTagDefs,
  definedTagKeys,
  isOrphanTag,
  mergeTagOptions,
  nextSessionTags,
  orphanTags,
  removeTagEntry,
  renameTagEntries,
  reorderTagEntries,
  tagKey,
  visibleTags,
  type TagDefs,
  type TagRef,
} from "@/components/session-list/tag-data";

const ref = (scope: string, name: string): TagRef => ({ scope, name });
const def = (name: string, sort = 0) => ({ name, sort });

const DEFS: TagDefs = {
  global: [def("重要", 0), def("待跟进", 1), def("实验", 2)],
  project: [def("前端", 0), def("重构", 1)],
};
const KEYS = definedTagKeys(DEFS);

describe("visibleTags 徽标截断", () => {
  test("空/undefined 返回空集且 extra 为 0", () => {
    expect(visibleTags(undefined)).toEqual({ shown: [], extra: 0 });
    expect(visibleTags([])).toEqual({ shown: [], extra: 0 });
  });

  test("1 个以内全显不折叠", () => {
    const tags = [ref("global", "a")];
    const { shown, extra } = visibleTags(tags);
    expect(shown).toHaveLength(1);
    expect(extra).toBe(0);
  });

  test("超出 1 个折叠为前 1 + 计数（C14）", () => {
    const tags = [ref("global", "a"), ref("project", "b"), ref("global", "c"), ref("project", "d"), ref("global", "e")];
    const { shown, extra } = visibleTags(tags);
    expect(shown.map((t) => t.name)).toEqual(["a"]);
    expect(extra).toBe(4);
  });

  test("常量契约为 1（docs08-r3 C14：最多显示 1 个 + N 计数）", () => {
    expect(TAG_BADGE_LIMIT).toBe(1);
  });
});

describe("孤儿判定", () => {
  test("挂载的 (scope,name) 在两源定义集中 = 非孤儿", () => {
    expect(isOrphanTag(ref("global", "重要"), KEYS)).toBe(false);
    expect(isOrphanTag(ref("project", "前端"), KEYS)).toBe(false);
  });

  test("定义已删/改名的挂载 = 孤儿", () => {
    expect(isOrphanTag(ref("global", "已删除"), KEYS)).toBe(true);
    expect(isOrphanTag(ref("project", "旧名"), KEYS)).toBe(true);
  });

  test("跨 scope 同名不误判：project 源的名字不影响 global scope 挂载", () => {
    expect(isOrphanTag(ref("global", "前端"), KEYS)).toBe(true);
    expect(isOrphanTag(ref("project", "重要"), KEYS)).toBe(true);
  });

  test("tagKey 以 (scope,name) 为键区分同名跨 scope", () => {
    expect(tagKey(ref("global", "x"))).not.toBe(tagKey(ref("project", "x")));
  });

  test("orphanTags 只取孤儿部分（清理载荷 = 当前挂载 − 孤儿）", () => {
    const tags = [ref("global", "重要"), ref("global", "已删除"), ref("project", "旧名")];
    expect(orphanTags(tags, KEYS)).toEqual([ref("global", "已删除"), ref("project", "旧名")]);
    expect(orphanTags(undefined, KEYS)).toEqual([]);
  });
});

describe("nextSessionTags 选择器整替载荷", () => {
  test("勾选追加到尾部", () => {
    const next = nextSessionTags([ref("global", "重要")], ref("project", "前端"), true);
    expect(next).toEqual([ref("global", "重要"), ref("project", "前端")]);
  });

  test("取消只移除目标 (scope,name)", () => {
    const tags = [ref("global", "重要"), ref("project", "前端")];
    expect(nextSessionTags(tags, ref("project", "前端"), false)).toEqual([ref("global", "重要")]);
    // 跨 scope 同名不受影响
    expect(nextSessionTags(tags, ref("project", "重要"), false)).toEqual(tags);
  });

  test("重复勾选幂等（不产生重复项）", () => {
    const tags = [ref("global", "重要")];
    expect(nextSessionTags(tags, ref("global", "重要"), true)).toEqual(tags);
  });

  test("undefined 当前挂载视为空集", () => {
    expect(nextSessionTags(undefined, ref("global", "新"), true)).toEqual([ref("global", "新")]);
    expect(nextSessionTags(undefined, ref("global", "新"), false)).toEqual([]);
  });
});

describe("mergeTagOptions 过滤选项合并", () => {
  test("全局 + 项目级合并，全局在前", () => {
    expect(mergeTagOptions(DEFS)).toEqual(["重要", "待跟进", "实验", "前端", "重构"]);
  });

  test("跨 scope 同名去重只留一个（全局优先）", () => {
    const defs: TagDefs = { global: [def("同名")], project: [def("同名"), def("仅项目")] };
    expect(mergeTagOptions(defs)).toEqual(["同名", "仅项目"]);
  });

  test("空两源返回空数组", () => {
    expect(mergeTagOptions({ global: [], project: [] })).toEqual([]);
  });
});

describe("dedupeTagDefs 多项目合并去重", () => {
  test("项目级同名去重保留首现，global 原样", () => {
    const defs: TagDefs = {
      global: [def("重要", 0)],
      project: [def("前端", 0), def("重构", 1), def("前端", 0)],
    };
    const next = dedupeTagDefs(defs);
    expect(next.project.map((d) => d.name)).toEqual(["前端", "重构"]);
    expect(next.global).toBe(defs.global);
  });

  test("空项目组原样", () => {
    expect(dedupeTagDefs({ global: [], project: [] })).toEqual({ global: [], project: [] });
  });
});

describe("管理弹层整替列表生成", () => {  test("appendTagEntry 追加尾部且 sort 递增", () => {
    const next = appendTagEntry([def("a", 0), def("b", 5)], "c");
    expect(next).toEqual([def("a", 0), def("b", 5), def("c", 6)]);
  });

  test("renameTagEntries 只改目标名，sort 保持", () => {
    const next = renameTagEntries([def("a", 0), def("b", 1)], "b", "b2");
    expect(next).toEqual([def("a", 0), def("b2", 1)]);
  });

  test("removeTagEntry 只删目标", () => {
    const next = removeTagEntry([def("a", 0), def("b", 1)], "a");
    expect(next).toEqual([def("b", 1)]);
  });

  test("reorderTagEntries 下移交换相邻并重排 sort", () => {
    const next = reorderTagEntries([def("a", 0), def("b", 1), def("c", 2)], "a", 1);
    expect(next.map((e) => e.name)).toEqual(["b", "a", "c"]);
    expect(next.map((e) => e.sort)).toEqual([0, 1, 2]);
  });

  test("reorderTagEntries 上移对称", () => {
    const next = reorderTagEntries([def("a", 0), def("b", 1), def("c", 2)], "c", -1);
    expect(next.map((e) => e.name)).toEqual(["a", "c", "b"]);
  });

  test("reorderTagEntries 越界/不存在原样返回", () => {
    const entries = [def("a", 0), def("b", 1)];
    expect(reorderTagEntries(entries, "a", -1)).toBe(entries);
    expect(reorderTagEntries(entries, "b", 1)).toBe(entries);
    expect(reorderTagEntries(entries, "不存在", 1)).toBe(entries);
  });
});
