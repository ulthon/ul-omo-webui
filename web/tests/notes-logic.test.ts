// 笔记页签纯逻辑单测（todo 15）：列表过滤、标签解析（逗号分隔）、chips 聚合、相对时间。
import { describe, expect, test } from "vitest";
import { collectTags, filterNotesByTag, parseTagInput, relTime, tagsToInput } from "@/components/notes/notes-logic";

describe("parseTagInput（编辑态逗号分隔标签解析）", () => {
  test("英文逗号分隔并去首尾空白", () => {
    expect(parseTagInput("a, b,c ")).toEqual(["a", "b", "c"]);
  });

  test("中文逗号与英文逗号混用", () => {
    expect(parseTagInput("工作，待办, 阅读")).toEqual(["工作", "待办", "阅读"]);
  });

  test("空段与纯空白段丢弃", () => {
    expect(parseTagInput("a,, ,b,")).toEqual(["a", "b"]);
  });

  test("重复标签去重保首次出现序", () => {
    expect(parseTagInput("b, a, b, a ,c")).toEqual(["b", "a", "c"]);
  });

  test("空输入与空白输入返回空数组", () => {
    expect(parseTagInput("")).toEqual([]);
    expect(parseTagInput("   ")).toEqual([]);
  });
});

describe("tagsToInput（编辑态回显）", () => {
  test("数组转逗号分隔文本", () => {
    expect(tagsToInput(["a", "b"])).toBe("a, b");
  });

  test("空数组返回空串", () => {
    expect(tagsToInput([])).toBe("");
  });
});

describe("collectTags（标签 chips 数据源）", () => {
  test("多笔记 tags 并集去重", () => {
    expect(collectTags([{ tags: ["a", "b"] }, { tags: ["b", "c"] }, { tags: [] }])).toEqual(["a", "b", "c"]);
  });

  test("空列表返回空数组", () => {
    expect(collectTags([])).toEqual([]);
  });
});

describe("filterNotesByTag（列表过滤）", () => {
  const notes = [
    { id: "1", tags: ["工作"] },
    { id: "2", tags: ["生活", "工作"] },
    { id: "3", tags: [] },
  ];

  test("tag 为 null 返回全量", () => {
    expect(filterNotesByTag(notes, null).map((n) => n.id)).toEqual(["1", "2", "3"]);
  });

  test("按标签包含过滤", () => {
    expect(filterNotesByTag(notes, "工作").map((n) => n.id)).toEqual(["1", "2"]);
    expect(filterNotesByTag(notes, "生活").map((n) => n.id)).toEqual(["2"]);
  });

  test("无匹配返回空数组；不修改输入数组", () => {
    expect(filterNotesByTag(notes, "不存在")).toEqual([]);
    expect(notes).toHaveLength(3);
  });
});

describe("relTime（相对时间容错）", () => {
  test("null 或非法时间返回占位符", () => {
    expect(relTime(null)).toBe("—");
    expect(relTime("")).toBe("—");
    expect(relTime("not-a-date")).toBe("—");
  });

  test("一分钟内显示刚刚", () => {
    const now = Date.now();
    expect(relTime(new Date(now - 30_000).toISOString(), now)).toBe("刚刚");
  });

  test("分钟/小时/天逐级", () => {
    const now = Date.now();
    expect(relTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5 分钟前");
    expect(relTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3 小时前");
    expect(relTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe("2 天前");
  });

  test("超过 30 天显示日期", () => {
    const now = new Date("2026-10-11T12:00:00Z").getTime();
    const old = new Date(now - 40 * 86_400_000).toISOString();
    expect(relTime(old, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
