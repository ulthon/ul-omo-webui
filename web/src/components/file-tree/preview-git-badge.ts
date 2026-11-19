// 预览 git 状态角标辅助（files-ux-revamp 任务 11）：porcelain v1 XY → 角标信息的纯函数，
// 外加 per-project gitStatus 缓存（FilePreview 每次选中重挂载，缓存保证换文件零额外请求；
// 写操作后由宿主调 invalidateGitStatusCache 失效——宿主接线是后续任务）。
// 注意：不进 file-tree-logic.ts（该文件由并行车道占用）。
import { api } from "@/lib/api";

export type GitBadgeTone = "amber" | "emerald" | "red" | "blue" | "gray";

export interface GitBadgeInfo {
  /** 角标显示字母：取 XY 首个非空字符（"MM"→M、" M"→M、"??"→?） */
  letter: string;
  tone: GitBadgeTone;
}

/** tone → 样式类（沿用 changes-view.tsx 的半透明底 + 深浅色文字惯例） */
export const GIT_BADGE_TONE_CLASS: Record<GitBadgeTone, string> = {
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  emerald: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  red: "bg-red-500/15 text-red-600 dark:text-red-400",
  blue: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  gray: "bg-muted text-muted-foreground",
};

/** tone → i18n 提示文案键（zh/en fileTree.preview.git*）；键面为字面量联合，保 t() 类型安全 */
export const GIT_BADGE_TONE_KEY: Record<GitBadgeTone, "fileTree.preview.gitModified" | "fileTree.preview.gitAdded" | "fileTree.preview.gitDeleted" | "fileTree.preview.gitRenamed" | "fileTree.preview.gitChanged"> = {
  amber: "fileTree.preview.gitModified",
  emerald: "fileTree.preview.gitAdded",
  red: "fileTree.preview.gitDeleted",
  blue: "fileTree.preview.gitRenamed",
  gray: "fileTree.preview.gitChanged",
};

/** porcelain v1 两字符 XY → 角标信息。M=修改(amber)；A/U/?=新增或未跟踪(emerald)；
 * D=删除(red)；R=重命名(blue)；其余/空格=gray。取首个非空字符。 */
export function gitBadgeInfo(xy: string): GitBadgeInfo {
  const ch = (xy ?? "").trim().charAt(0);
  if (ch === "M") return { letter: "M", tone: "amber" };
  if (ch === "A" || ch === "U" || ch === "?") return { letter: ch, tone: "emerald" };
  if (ch === "D") return { letter: "D", tone: "red" };
  if (ch === "R") return { letter: "R", tone: "blue" };
  return { letter: ch, tone: "gray" };
}

// ---- 扩展名 → Shiki 语言（聊天侧无扩展名映射：fence 语言直传 worker，不支持时 worker
// 返回 null 降级；预览侧补充此小映射，未列出的扩展名返回 ""（不进 worker，纯文本）。）----
const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "jsonc",
  css: "css", scss: "scss", less: "less",
  html: "html", htm: "html",
  md: "markdown", markdown: "markdown",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  swift: "swift", lua: "lua", php: "php", cs: "csharp",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini",
  sql: "sql", xml: "xml", vue: "vue", diff: "diff", patch: "diff",
  gql: "graphql", graphql: "graphql",
};

/** 文件路径 → Shiki 语言标识；"" = 不高亮 */
export function shikiLangOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return EXT_LANG[ext] ?? "";
}

// ---- gitStatus per-project 缓存 ----

export interface GitStatusCacheEntry {
  /** path → porcelain XY；ok=false（非仓库/请求失败）时为空表 */
  map: Map<string, string>;
  ok: boolean;
}

const cache = new Map<string, Promise<GitStatusCacheEntry>>();

async function loadGitStatus(project: string): Promise<GitStatusCacheEntry> {
  try {
    const res = await api.gitStatus(project);
    const map = new Map<string, string>();
    for (const entry of res.entries) {
      const status = typeof entry.status === "string" ? entry.status : "";
      const path = typeof entry.path === "string" ? entry.path : "";
      if (path) map.set(path, status);
    }
    return { map, ok: true };
  } catch {
    // 非 git 仓库（409）或请求失败：缓存空结果，避免每次换文件重发注定失败的请求
    return { map: new Map(), ok: false };
  }
}

/** 取项目 git 状态映射（首个调用触发请求，后续复用缓存 promise） */
export function fetchGitStatusMap(project: string): Promise<GitStatusCacheEntry> {
  let entry = cache.get(project);
  if (!entry) {
    entry = loadGitStatus(project);
    cache.set(project, entry);
  }
  return entry;
}

/** 失效缓存：写操作后由宿主调用；不传 project 清空全部 */
export function invalidateGitStatusCache(project?: string): void {
  if (project === undefined) cache.clear();
  else cache.delete(project);
}

