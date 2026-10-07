// 文件树纯逻辑（todo 20）：@ 引用插入、模糊过滤、文件类型判断、有界路径扫描。
// 组件层（file-tree / file-preview / file-picker）只做渲染与请求编排，可测逻辑全部收敛在此。
import { api, type FsTreeEntry } from "@/lib/api";

/** 相对路径转显示名（叶子名） */
export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** 常见图片扩展名 → MIME（供预览内联与类型识别；位图依赖服务端二进制契约，见 file-preview 注释） */
const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

export function imageMimeOf(path: string): string | null {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_EXT_MIME[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** 人类可读文件大小 */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * @ 引用插入：把输入框 [triggerIndex, caret) 区间（键入触发的 "@" 及过滤词）替换为
 * `@<path> `（尾随空格分隔便于续写），返回新内容与新光标位置（落插入点之后）。
 * triggerIndex 为 null（@ 按钮入口）时在 caret 处直接插入。
 */
export function insertMention(
  text: string,
  caret: number,
  triggerIndex: number | null,
  path: string,
): { content: string; caret: number } {
  const token = `@${path} `;
  const start = triggerIndex === null ? caret : Math.min(Math.max(triggerIndex, 0), caret);
  const content = text.slice(0, start) + token + text.slice(caret);
  return { content, caret: start + token.length };
}

/**
 * 模糊过滤打分：null = 不命中；数值越小越相关。
 * 叶子名子串命中 > 全路径子串命中 > 字符按序模糊命中（顺序匹配不保证连续）。
 */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const p = path.toLowerCase();
  const name = baseName(p);
  const nameHit = name.indexOf(q);
  if (nameHit >= 0) return nameHit; // 叶子名命中：出现越早越靠前
  const pathHit = p.indexOf(q);
  if (pathHit >= 0) return 100 + pathHit;
  let i = 0;
  for (let c = 0; c < p.length && i < q.length; c++) {
    if (p[c] === q[i]) i++;
  }
  if (i < q.length) return null;
  return 1000 + p.length; // 顺序命中垫底，短路径优先
}

export function filterPaths(paths: string[], query: string, limit = 50): string[] {
  if (!query.trim()) return [];
  return paths
    .map((p) => ({ p, s: fuzzyScore(query, p) }))
    .filter((x): x is { p: string; s: number } => x.s !== null)
    .sort((a, b) => a.s - b.s || a.p.localeCompare(b.p))
    .slice(0, limit)
    .map((x) => x.p);
}

/** 有界扫描忽略的目录名（大仓库防拖垮；树导航不忽略，仅全量扫描用） */
export const SCAN_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
]);

export interface ScanLimits {
  maxDepth: number;
  maxEntries: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = { maxDepth: 8, maxEntries: 3000 };

/**
 * 有界 BFS 全量路径扫描（@ 选择器模糊过滤数据源）：从根逐层列目录，直至深度/条目上限。
 * 达到上限即停（返回已收集部分），不递归 symlink。失败的单层目录跳过不中断。
 */
export async function collectProjectPaths(
  project: string,
  limits: ScanLimits = DEFAULT_SCAN_LIMITS,
): Promise<string[]> {
  const out: string[] = [];
  let count = 0;
  let layer: string[] = [""];
  while (layer.length > 0 && count < limits.maxEntries) {
    const results = await Promise.all(
      layer.map(async (path) => {
        try {
          const res = await api.fsTree(project, path || undefined);
          return { path, entries: res.entries };
        } catch {
          return { path, entries: [] as FsTreeEntry[] };
        }
      }),
    );
    const nextLayer: string[] = [];
    for (const { path, entries } of results) {
      for (const entry of entries) {
        if (count >= limits.maxEntries) break;
        const child = path ? `${path}/${entry.name}` : entry.name;
        count++;
        if (entry.type === "directory") {
          if (path === "" && SCAN_IGNORE_DIRS.has(entry.name)) continue;
          if (child.split("/").length - 1 >= limits.maxDepth) {
            // 深度耗尽：目录本身仍计入（可在树中展开），不再下探
            out.push(child);
            continue;
          }
          nextLayer.push(child);
          out.push(child);
        } else {
          out.push(child);
        }
      }
      if (count >= limits.maxEntries) break;
    }
    layer = nextLayer;
  }
  return out;
}
