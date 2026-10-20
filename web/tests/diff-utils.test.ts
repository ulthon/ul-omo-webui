// diff-utils 单测（todo 19）：工具结果 diff 提取启发式、porcelain 状态码解读与
// path 清洗、全量 diff 前端切分与按路径匹配。
import { describe, expect, test } from "vitest";
import {
  cleanStatusPath,
  extractDiffText,
  extractParseableDiff,
  matchDiffFile,
  parseGitDiff,
  statusInfo,
} from "@/components/diff/diff-utils";

const GIT_DIFF_SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
-old line
+new line
 line3
+added line
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
diff --git a/gone.md b/gone.md
deleted file mode 100644
index 3333333..0000000
--- a/gone.md
+++ /dev/null
@@ -1 +0,0 @@
-bye`;

describe("extractDiffText", () => {
  test("```diff 围栏块提取（带前导说明文字）", () => {
    const text = `已更新文件：\n\n\`\`\`diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n\`\`\`\n完成。`;
    expect(extractDiffText(text)).toBe("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b");
  });

  test("多段 ```diff 围栏拼接", () => {
    const text = "```diff\n@@ -1 +1 @@\n``` middle ```diff\n@@ -2 +2 @@\n``` tail";
    // 第一段正则惰性匹配到第一个结束围栏，剩余按第二段提取
    const result = extractDiffText(text);
    expect(result).toContain("@@ -1 +1 @@");
    expect(result).toContain("@@ -2 +2 @@");
  });

  test("git diff 输出：从 diff --git 起截取", () => {
    const text = `结果如下：\ndiff --git a/f.ts b/f.ts\nindex 1..2 100644\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b`;
    const result = extractDiffText(text);
    expect(result).toMatch(/^diff --git a\/f\.ts b\/f\.ts/);
  });

  test("裸 unified 片段：---/+++/@@ 头识别", () => {
    const text = "修改完成\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b";
    expect(extractDiffText(text)).toMatch(/^--- a\/f\.ts/);
  });

  test("无 diff 形态返回 null", () => {
    expect(extractDiffText("编辑成功：src/a.ts（2 处替换）")).toBeNull();
    expect(extractDiffText("")).toBeNull();
    expect(extractDiffText("@@ 孤立符号不构成 hunk")).toBeNull();
  });
});

describe("extractParseableDiff", () => {
  test("可解析 diff 返回原文", () => {
    const diff = "--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b";
    expect(extractParseableDiff(`前导文字\n${diff}`)).toBe(diff);
  });

  test("启发式假阳性（不可解析）返回 null", () => {
    expect(extractParseableDiff("普通文本，没有 diff")).toBeNull();
  });
});

describe("statusInfo", () => {
  test("常规状态映射", () => {
    expect(statusInfo(" M")).toEqual({ code: "M", label: "diff.status.modified", tone: "modify" });
    expect(statusInfo("M ")).toEqual({ code: "M", label: "diff.status.modified", tone: "modify" });
    expect(statusInfo("A ")).toEqual({ code: "A", label: "diff.status.added", tone: "add" });
    expect(statusInfo("D ")).toEqual({ code: "D", label: "diff.status.deleted", tone: "delete" });
    expect(statusInfo("R ")).toEqual({ code: "R", label: "diff.status.renamed", tone: "rename" });
    expect(statusInfo("??")).toEqual({ code: "??", label: "diff.status.untracked", tone: "untracked" });
  });

  test("未合并对判冲突，混合态取信息量大侧", () => {
    expect(statusInfo("UU").tone).toBe("conflict");
    expect(statusInfo("AU").tone).toBe("conflict");
    expect(statusInfo("AM").tone).toBe("add");
    expect(statusInfo("MM").tone).toBe("modify");
  });
});

describe("cleanStatusPath", () => {
  test("普通路径原样", () => {
    expect(cleanStatusPath("src/a.ts")).toBe("src/a.ts");
  });

  test("重命名 old => new 取 new 侧", () => {
    expect(cleanStatusPath("old.txt => new.txt")).toBe("new.txt");
  });

  test("引号路径去引号", () => {
    expect(cleanStatusPath('"with space.txt"')).toBe("with space.txt");
  });
});

describe("parseGitDiff / matchDiffFile", () => {
  const files = parseGitDiff(GIT_DIFF_SAMPLE);

  test("多文件切分：modify / rename / delete 三形态", () => {
    expect(files.map((f) => f.type)).toEqual(["modify", "rename", "delete"]);
    expect(files[0].newPath).toBe("src/a.ts");
    expect(files[0].hunks.length).toBe(1);
    expect(files[2].oldPath).toBe("gone.md");
  });

  test("按路径匹配：rename 命中新路径，delete 靠 oldPath 命中", () => {
    expect(matchDiffFile(files, "src/a.ts")?.type).toBe("modify");
    expect(matchDiffFile(files, "new.txt")?.type).toBe("rename");
    expect(matchDiffFile(files, "old.txt")?.type).toBe("rename");
    expect(matchDiffFile(files, "gone.md")?.type).toBe("delete");
    expect(matchDiffFile(files, "not-in-diff.txt")).toBeNull();
  });

  test("二进制文件解析出条目但无 hunk", () => {
    const binary = `diff --git a/blob.bin b/blob.bin\nindex 111..222 100644\nBinary files a/blob.bin and b/blob.bin differ`;
    const parsed = parseGitDiff(binary);
    expect(parsed.length).toBe(1);
    expect(parsed[0].hunks.length).toBe(0);
  });

  test("异常输入不抛错返回空数组", () => {
    expect(parseGitDiff("")).toEqual([]);
    expect(parseGitDiff("完全不是 diff 的文本")).toEqual([]);
  });
});
