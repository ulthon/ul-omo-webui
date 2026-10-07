// diff 数据工具面（todo 19）：
// - 工具结果文本中的 diff 提取启发式（```diff 围栏 / git diff 头 / 裸 unified 片段）
// - git status --porcelain 的 XY 状态码解读与 path 清洗
// - 全量工作区 diff 的前端切分（GET /api/git/diff 无按文件参数，按路由实际 shape
//   用 react-diff-view 的 parseDiff 一次解析出单文件结构数组）
// 全部为纯函数，供组件与 bun 单测共用。
import { parseDiff } from "react-diff-view";
import type { FileData } from "react-diff-view";

export type { FileData };

/** 从工具结果文本中提取 unified diff 内容；无 diff 形态返回 null。
 *  识别启发式（按优先级，编辑类工具结果常含前导说明文字）：
 *  1. ```diff 围栏块（可多段，拼接返回）
 *  2. git diff 输出（从首个 "diff --git " 起截取到结尾）
 *  3. 裸 unified 片段（"+++ " 行或标准 "@@ -a,b +c,d @@" 数字形态 hunk 头；从紧邻的 "--- " 行起带上路径头）
 *  本函数只做文本定位不做语法校验，解析失败由 extractParseableDiff / 渲染层兜底。 */
export function extractDiffText(text: string): string | null {
  if (!text) return null;
  const fences = [...text.matchAll(/```diff[ \t]*\r?\n([\s\S]*?)```/g)];
  if (fences.length > 0) {
    const joined = fences
      .map((m) => m[1])
      .join("\n")
      .trim();
    return joined || null;
  }
  const gitIdx = text.indexOf("diff --git ");
  if (gitIdx >= 0) return text.slice(gitIdx).trim() || null;
  const plusIdx = text.search(/^\+\+\+ /m);
  if (plusIdx >= 0) {
    // 标准 unified 头序是 ---/+++/@@；+++ 前最近的 "--- " 行若紧邻则一并带上
    let start = plusIdx;
    const dashIdx = text.lastIndexOf("\n--- ", plusIdx);
    if (dashIdx >= 0 && plusIdx - dashIdx <= 200) start = dashIdx + 1;
    else if (text.startsWith("--- ") && plusIdx < 200) start = 0;
    return text.slice(start).trim() || null;
  }
  const hunkIdx = text.search(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m);
  if (hunkIdx >= 0) return text.slice(hunkIdx).trim() || null;
  return null;
}

/** extractDiffText + 解析校验：能解析出至少一个文件结构才返回 diff 文本。
 *  工具卡片据此判定"结果含 diff"并切换 diff 渲染；误判（启发式假阳性）时回退纯文本。 */
export function extractParseableDiff(text: string): string | null {
  const t = extractDiffText(text);
  if (!t) return null;
  return parseGitDiff(t).length > 0 ? t : null;
}

/** git status --porcelain 行的 XY 状态码 → 展示信息（X=暂存区侧，Y=工作区侧，取信息量更大者） */
export interface StatusInfo {
  /** 徽标短码（"M" / "??" / "UU" 等） */
  code: string;
  /** 中文标签 */
  label: string;
  /** 色调语义，组件层映射为类名 */
  tone: "add" | "modify" | "delete" | "rename" | "untracked" | "conflict";
}

export function statusInfo(xy: string): StatusInfo {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";
  if (x === "?" || y === "?") return { code: "??", label: "未跟踪", tone: "untracked" };
  if (x === "!" || y === "!") return { code: "!", label: "已忽略", tone: "untracked" };
  // 未合并对（AA/DD/UU/AU/UA/DU/UD）：两位都是 A/D/U 即冲突
  if ("ADU".includes(x) && "ADU".includes(y)) return { code: "UU", label: "冲突", tone: "conflict" };
  const pick = (c: string): StatusInfo | null => {
    switch (c) {
      case "A":
        return { code: "A", label: "新增", tone: "add" };
      case "M":
        return { code: "M", label: "修改", tone: "modify" };
      case "D":
        return { code: "D", label: "删除", tone: "delete" };
      case "R":
        return { code: "R", label: "重命名", tone: "rename" };
      case "C":
        return { code: "C", label: "复制", tone: "rename" };
      case "T":
        return { code: "T", label: "类型变更", tone: "modify" };
      default:
        return null;
    }
  };
  return pick(x) ?? pick(y) ?? { code: xy.trim() || "-", label: "变更", tone: "modify" };
}

/** porcelain 行 path 字段清洗：`old => new` 重命名形态取 new 侧；C 风格引号路径去引号 */
export function cleanStatusPath(raw: string): string {
  const arrow = raw.lastIndexOf(" => ");
  const p = arrow >= 0 ? raw.slice(arrow + 4) : raw;
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    try {
      return JSON.parse(p) as string;
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

/** 全量工作区 diff 文本 → 单文件结构数组；解析异常（截断尾部等）返回已解析出的前缀或空数组。
 *  gitdiff-parser 对空输入返回路径全空且无 hunk 的占位条目，此处过滤；
 *  裸 unified 片段（无 diff --git 头）解析出的条目路径为空但有 hunk，保留（视图层给"diff 片段"标题）。 */
export function parseGitDiff(diffText: string): FileData[] {
  if (!diffText) return [];
  try {
    return parseDiff(diffText).filter((f) => f.oldPath !== "" || f.newPath !== "" || f.hunks.length > 0);
  } catch {
    return [];
  }
}

/** 按文件路径（porcelain 口径，无 a/ b/ 前缀）在解析结果中定位对应 diff 文件。
 *  parseDiff 特性：删除文件 newPath 为 "/dev/null"（靠 oldPath 命中），新增文件反之。 */
export function matchDiffFile(files: FileData[], path: string): FileData | null {
  return files.find((f) => f.newPath === path || f.oldPath === path) ?? null;
}
