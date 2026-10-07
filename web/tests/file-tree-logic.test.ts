// 文件树纯逻辑单测（todo 20）：@ 引用插入、模糊过滤、类型识别、大小格式化。
// 树导航/预览/弹窗交互与端到端发送走浏览器 QA（.omo/qa/W4/file-tree.md）。
import { describe, expect, test } from "bun:test";
import {
  baseName,
  filterPaths,
  formatBytes,
  fuzzyScore,
  imageMimeOf,
  insertMention,
} from "@/components/file-tree/file-tree-logic";

describe("insertMention", () => {
  test("键入 @ 触发：替换 [trigger, caret) 区间的 @ 字符", () => {
    // 文本 "读取 @"，@ 在 index 3，光标 4
    expect(insertMention("读取 @", 4, 3, "README.md")).toEqual({
      content: "读取 @README.md ",
      caret: "读取 @README.md ".length,
    });
  });

  test("按钮触发（trigger=null）：在光标处直接插入", () => {
    expect(insertMention("前文", 2, null, "src/index.ts")).toEqual({
      content: "前文@src/index.ts ",
      caret: "前文@src/index.ts ".length,
    });
  });

  test("光标后有尾随文本：插入到中间，其后文本保留", () => {
    expect(insertMention("ab", 1, null, "x.md")).toEqual({ content: "a@x.md b", caret: 7 });
  });

  test("空文本 + trigger=null：从零插入", () => {
    expect(insertMention("", 0, null, "README.md")).toEqual({ content: "@README.md ", caret: 11 });
  });

  test("trigger 越界被钳制不产生负切片", () => {
    expect(insertMention("abc", 3, -5, "x")).toEqual({ content: "@x ", caret: 3 });
    expect(insertMention("abc", 3, 99, "x")).toEqual({ content: "abc@x ", caret: 6 });
  });

  test("含中文路径原样保留", () => {
    const r = insertMention("看看 ", 3, null, "docs/中文长文.md");
    expect(r.content).toBe("看看 @docs/中文长文.md ");
  });
});

describe("fuzzyScore / filterPaths", () => {
  const paths = ["README.md", "src/index.ts", "src/lib/deep.ts", "docs/中文长文.md", "big-dir/item-001.txt"];

  test("叶子名子串命中优先于路径子串", () => {
    // "deep" 命中叶子名（分数 0）；"lib/deep" 只能走全路径子串分支（100+ 偏移）
    const nameHit = fuzzyScore("deep", "src/lib/deep.ts");
    const pathHit = fuzzyScore("lib/deep", "src/lib/deep.ts");
    expect(nameHit).toBe(0);
    expect(pathHit).not.toBeNull();
    expect(nameHit).toBeLessThan(pathHit);
  });

  test("大小写不敏感", () => {
    expect(fuzzyScore("DEEP", "src/lib/deep.ts")).not.toBeNull();
  });

  test("顺序模糊命中垫底但不缺席", () => {
    const s = fuzzyScore("rm", "README.md"); // r-m 按序出现
    expect(s).not.toBeNull();
    const direct = fuzzyScore("read", "README.md");
    expect(direct).toBeLessThan(s);
  });

  test("完全不命中返回 null", () => {
    expect(fuzzyScore("zzzz", "README.md")).toBeNull();
  });

  test("空 query 返回空列表", () => {
    expect(filterPaths(paths, "  ")).toEqual([]);
  });

  test("filterPaths 按分数排序且限量", () => {
    const many = Array.from({ length: 120 }, (_, i) => `dir/file-${String(i).padStart(3, "0")}.ts`);
    many.push("README.md");
    const hits = filterPaths(many, "readme");
    expect(hits).toEqual(["README.md"]);
    expect(filterPaths(many, "file-0").length).toBe(50); // limit 50
  });

  test("中文命中", () => {
    expect(filterPaths(paths, "中文")).toEqual(["docs/中文长文.md"]);
  });
});

describe("imageMimeOf / formatBytes / baseName", () => {
  test("常见图片扩展名映射", () => {
    expect(imageMimeOf("assets/logo.png")).toBe("image/png");
    expect(imageMimeOf("a/b/läuft.JPG")).toBe("image/jpeg");
    expect(imageMimeOf("diagram.svg")).toBe("image/svg+xml");
  });

  test("非图片返回 null", () => {
    expect(imageMimeOf("data.bin")).toBeNull();
    expect(imageMimeOf("README.md")).toBeNull();
    expect(imageMimeOf("noext")).toBeNull();
  });

  test("formatBytes 三档", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.00 MB");
  });

  test("baseName 取叶子", () => {
    expect(baseName("src/lib/deep.ts")).toBe("deep.ts");
    expect(baseName("README.md")).toBe("README.md");
  });
});
