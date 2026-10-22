// 标签 UI 纯逻辑单测（todo 11；docs08-r3 C14 徽标上限 1+计数；todo 20 v2 颜色/展示模式）：
// - visibleTags 徽标截断（1 个全显 / 超出 +N）
// - isOrphanTag / orphanTags 孤儿判定（挂载的 (scope,name) 不在两源定义集中）
// - nextSessionTags 选择器勾选 → 整替载荷生成
// - mergeTagOptions 过滤 chips 选项合并去重（全局 + 项目级，跨 scope 同名去重）
// - 管理弹层整替列表生成（新增/重命名/删除/上移下移）
// - todo 20 v2：fnv1a32 官方向量、tagColor 显式/hash 优先级、rowTagDisplayMode 行级
//   判定（覆盖优先级/孤儿不参与/defs 未就绪）、tagColorMap 跨 scope 优先、
//   setTagColor/resetTagColor/setTagDisplay 与重命名保色
import { describe, expect, test } from "vitest";
import {
  TAG_BADGE_LIMIT,
  TAG_PALETTE,
  appendTagEntry,
  dedupeTagDefs,
  definedTagKeys,
  fnv1a32,
  findTagDef,
  isOrphanTag,
  mergeTagOptions,
  nextSessionTags,
  orphanTags,
  removeTagEntry,
  renameTagEntries,
  reorderTagEntries,
  resetTagColor,
  rowTagDisplayMode,
  setTagColor,
  setTagDisplay,
  tagColor,
  tagColorMap,
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

// ---------------------------------------------------------------- todo 20 v2：颜色与展示模式

describe("fnv1a32 hash（官方测试向量锁定实现）", () => {
  test("FNV-1a 32 位官方向量：空串/a/foobar", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  test("确定性：同名恒同值（跨端跨重启自动取色一致的根基）", () => {
    for (const name of ["重要", "待跟进", "experiment-42", "标签名 带空格"]) {
      expect(fnv1a32(name)).toBe(fnv1a32(name));
    }
    // 不同名不同值（样本内无一碰撞即可，不扇断言全局单射）
    expect(fnv1a32("a")).not.toBe(fnv1a32("b"));
  });
});

describe("tagColor 显式色优先，hash 色落板内", () => {
  test("显式 color 优先返回原值（rename 后显式色不变的根基）", () => {
    expect(tagColor({ name: "任意", color: "#112233" })).toBe("#112233");
  });

  test("无显式色时按名称 hash 取色：恒落 TAG_PALETTE 且同名稳定", () => {
    expect(TAG_PALETTE).toHaveLength(10);
    for (const name of ["重要", "待跟进", "实验", "x", "y"]) {
      const c = tagColor({ name });
      expect(TAG_PALETTE).toContain(c);
      expect(c).toBe(tagColor({ name }));
    }
    // hash 直接取模与 tagColor 派生一致（色板 %10 契约）
    expect(tagColor({ name: "a" })).toBe(TAG_PALETTE[fnv1a32("a") % 10]);
  });
});

describe("rowTagDisplayMode 行级展示判定", () => {
  const defs: TagDefs = {
    global: [
      { name: "强文字", sort: 0, display: "text" },
      { name: "强色格", sort: 1, display: "grid" },
      { name: "无覆盖", sort: 2 },
    ],
    project: [{ name: "项目格", sort: 0, display: "grid" }],
  };

  test("无挂载 → text；无覆盖标签 → 全局档", () => {
    expect(rowTagDisplayMode([], defs, "grid")).toBe("text");
    expect(rowTagDisplayMode(undefined, defs, "grid")).toBe("text");
    expect(rowTagDisplayMode([{ scope: "global", name: "无覆盖" }], defs, "text")).toBe("text");
    expect(rowTagDisplayMode([{ scope: "global", name: "无覆盖" }], defs, "grid")).toBe("grid");
  });

  test("任一 display:text 覆盖 → 整行回退文字（优先于 grid 覆盖与全局档）", () => {
    expect(rowTagDisplayMode([{ scope: "global", name: "强文字" }], defs, "grid")).toBe("text");
    const mixed = [
      { scope: "global", name: "强色格" },
      { scope: "global", name: "强文字" },
    ] as TagRef[];
    expect(rowTagDisplayMode(mixed, defs, "grid")).toBe("text");
  });

  test("display:grid 覆盖 → 全局 text 时仍强制色格", () => {
    expect(rowTagDisplayMode([{ scope: "global", name: "强色格" }], defs, "text")).toBe("grid");
    expect(rowTagDisplayMode([{ scope: "project", name: "项目格" }], defs, "text")).toBe("grid");
  });

  test("孤儿不参与覆盖判定；defs 未就绪视为无覆盖", () => {
    expect(rowTagDisplayMode([{ scope: "global", name: "已删除" }], defs, "text")).toBe("text");
    expect(rowTagDisplayMode([{ scope: "global", name: "已删除" }], defs, "grid")).toBe("grid");
    expect(rowTagDisplayMode([{ scope: "global", name: "强文字" }], null, "grid")).toBe("grid");
  });

  test("findTagDef 两源按 (scope,name) 命中，未命中 null", () => {
    expect(findTagDef(defs, { scope: "global", name: "强文字" })?.display).toBe("text");
    expect(findTagDef(defs, { scope: "project", name: "项目格" })?.display).toBe("grid");
    expect(findTagDef(defs, { scope: "project", name: "强文字" })).toBeNull();
  });
});

describe("tagColorMap 选择面有效色表", () => {
  test("显式色原样、无定义条目 hash；跨 scope 同名全局优先（与 mergeTagOptions 口径一致）", () => {
    const defs: TagDefs = {
      global: [{ name: "同名", sort: 0, color: "#111111" }],
      project: [
        { name: "同名", sort: 0, color: "#222222" },
        { name: "自动色", sort: 1 },
      ],
    };
    const colors = tagColorMap(defs);
    expect(colors.get("同名")).toBe("#111111");
    expect(colors.get("自动色")).toBe(TAG_PALETTE[fnv1a32("自动色") % 10]);
  });
});

describe("管理弹层 v2 操作（取色/自动/三态/重命名保字段）", () => {
  test("setTagColor 仅改目标且保留 display", () => {
    const entries = [
      { name: "a", sort: 0, display: "grid" as const },
      { name: "b", sort: 1 },
    ];
    expect(setTagColor(entries, "a", "#aabbcc")).toEqual([
      { name: "a", sort: 0, display: "grid", color: "#aabbcc" },
      { name: "b", sort: 1 },
    ]);
  });

  test("resetTagColor 剩目标 color 保留 display（回 hash 自动色）", () => {
    const entries = [
      { name: "a", sort: 0, color: "#112233", display: "text" as const },
      { name: "b", sort: 1, color: "#445566" },
    ];
    expect(resetTagColor(entries, "a")).toEqual([
      { name: "a", sort: 0, display: "text" },
      { name: "b", sort: 1, color: "#445566" },
    ]);
    expect(resetTagColor(entries, "b")).toEqual([
      { name: "a", sort: 0, color: "#112233", display: "text" },
      { name: "b", sort: 1 },
    ]);
    // 原条目不变（纯函数）
    expect(entries[0].color).toBe("#112233");
  });

  test("setTagDisplay 三态：置 text/grid、回 undefined 剩字段，保留 color", () => {
    const entries = [{ name: "a", sort: 0, color: "#112233" }];
    expect(setTagDisplay(entries, "a", "text")).toEqual([{ name: "a", sort: 0, color: "#112233", display: "text" }]);
    expect(setTagDisplay(entries, "a", "grid")).toEqual([{ name: "a", sort: 0, color: "#112233", display: "grid" }]);
    expect(setTagDisplay(entries, "a", undefined)).toEqual([{ name: "a", sort: 0, color: "#112233" }]);
  });

  test("rename hash 变显式不变：显式色/覆盖随条目保留（验收验收项）", () => {
    const entries = [
      { name: "旧名", sort: 0, color: "#112233", display: "grid" as const },
      { name: "旧名2", sort: 1 },
    ];
    const renamed = renameTagEntries(entries, "旧名", "新名");
    expect(renamed[0]).toEqual({ name: "新名", sort: 0, color: "#112233", display: "grid" });
    // 显式色 rename 后仍原值（hash 变化不影响显式色）
    expect(tagColor(renamed[0])).toBe("#112233");
    // 无显式色的同名 rename 后 hash 色随新名变化（名称取色的稳定语义）
    const renamed2 = renameTagEntries(entries, "旧名2", "新名2");
    expect(tagColor(renamed2[1])).toBe(TAG_PALETTE[fnv1a32("新名2") % 10]);
  });
});
