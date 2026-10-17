// 添加项目目录浏览纯逻辑（todo 16）：路径补全触发判定、建议列表生成、目录树状态转移。
// 组件层（directory-tree / add-project-dialog）只做渲染与请求编排，可测逻辑全部收敛在此。
// 数据源是 /api/fs/browse（todo 7；W5 todo 14 base 放开到文件系统根）：仅目录、
// entry.path 为绝对路径——与 fs/tree（项目内相对路径）不同源，故 DirectoryTree 独立实现不复用 FileTree。
import type { FsBrowseEntry } from "@/lib/api";

/** 补全防抖窗口：输入停顿该毫秒数后才发起目录请求 */
export const SUGGEST_DEBOUNCE_MS = 300;

/** DirectoryPickerDialog 路径框联动防抖窗口（docs08-r3 任务 20）：停顿后才刷新列表 */
export const PICKER_DEBOUNCE_MS = 300;

/** 下拉建议条数上限（目录几十条以内，深目录防刷屏） */
export const SUGGEST_LIMIT = 30;

/**
 * 绝对路径形态判定（客户端不知服务端平台，两种形态都放行，最终裁判在服务端）：
 * POSIX（/…）、Windows 盘符（D:\… / D:/…，裸 "D:" 不算——win32 语义是"该盘当前目录"）、UNC（\\server\share）。
 */
export function isAbsoluteInput(raw: string): boolean {
  return raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\");
}

/**
 * 输入框文本中"已输入目录部分"（最后一个路径分隔符及其之前；/ 与 \ 皆认）。
 * 非绝对路径（isAbsoluteInput 不通过）、空串 → null（静默不建议）。
 * W5 todo 14：不再拒绝含 .. 的输入（服务端 resolve 归一后仍在 base 内即放行）。
 */
export function suggestDirOf(raw: string): string | null {
  if (!isAbsoluteInput(raw)) return null;
  const i = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  if (i <= 0) return "/";
  return raw.slice(0, i + 1);
}

/**
 * 防抖到期后是否需要（重新）取目录：目录部分有效且与上次已取目录不同即触发——
 * 覆盖"以 / 结尾"（目录部分整体新增）与"有新增路径段"（跨过新的 /）两种形态；
 * 同一段内继续打字（如 /home/u → /home/ub）目录部分不变，不重复请求。
 */
export function nextSuggestDir(raw: string, lastDir: string | null): string | null {
  const dir = suggestDirOf(raw);
  if (dir === null || dir === lastDir) return null;
  return dir;
}

/** 目录部分 → browse path 参数。W5 todo 14：根即文件系统根 "/"，原样传回（服务端缺省同为 /） */
export function browsePathOf(dir: string): string {
  return dir;
}

/**
 * 建议列表：按尾部未完成段过滤（大小写不敏感子串），排序为
 * 非隐藏优先 > 段首前缀命中优先 > 名称字典序；截断到 SUGGEST_LIMIT。
 * 服务端合成的 ".." 行是树的上行导航入口，不作为补全候选（回填 path+"/" 对根会产生 "//"）。
 */
export function pickSuggestions(raw: string, entries: FsBrowseEntry[]): FsBrowseEntry[] {
  const dir = suggestDirOf(raw);
  if (dir === null) return [];
  const seg = raw.slice(dir.length).toLowerCase();
  const prefixOf = (e: FsBrowseEntry): 0 | 1 => (e.name.toLowerCase().startsWith(seg) ? 0 : 1);
  return entries
    .filter((e) => e.name !== ".." && (seg === "" || e.name.toLowerCase().includes(seg)))
    .sort(
      (a, b) =>
        Number(a.hidden) - Number(b.hidden) || prefixOf(a) - prefixOf(b) || a.name.localeCompare(b.name),
    )
    .slice(0, SUGGEST_LIMIT);
}

/** 点选建议后的回填值：建议目录完整路径 + 尾随分隔符（按路径自身分隔符形态选 / 或 \；盘根/POSIX 根保形不加） */
export function suggestionBackfill(entry: FsBrowseEntry): string {
  if (/[\\/]$/.test(entry.path)) return entry.path;
  return `${entry.path}${entry.path.includes("\\") ? "\\" : "/"}`;
}

/**
 * 浏览判重键（docs08-r3 任务 20 联动）：合并连续正斜杠、去尾分隔符（POSIX 根 "/" 与
 * win32 盘根 "D:\" 保形——去尾会退化成盘相对路径 "D:"，语义不同）。
 * 不展开 .. 与 .（交服务端 resolve）——仅用于跳过同形输入的重复请求，多一次请求无害。
 */
export function normalizeBrowsePath(raw: string): string {
  // 盘符根三形态（D:\、D:/、裸 D:）统一为 "D:\"
  if (/^[A-Za-z]:[\\/]{0,1}$/.test(raw)) return raw.length === 3 ? raw : `${raw}\\`;
  const merged = raw.replace(/\/{2,}/g, "/");
  if (merged.length <= 1) return merged;
  const stripped = merged.replace(/[\\/]+$/, "");
  if (stripped.length === 0) return merged;
  return stripped;
}

// ---------- DirectoryTree 状态转移（纯函数，状态三件套整体替换触发渲染） ----------

/** 树键："" = 文件系统根（browse 缺省参数），其余为 entry 绝对路径 */
export type DirTreeKey = string;

export interface DirTreeData {
  /** 目录键 → 子目录列表；null = 尚未加载 */
  children: Map<DirTreeKey, FsBrowseEntry[] | null>;
  expanded: Set<DirTreeKey>;
  loading: Set<DirTreeKey>;
}

/** 初始态：根目录（""）直接处于加载中（挂载即加载，避免 effect 内同步 setState） */
export function initialDirTree(): DirTreeData {
  return { children: new Map(), expanded: new Set(), loading: new Set([""]) };
}

/** 展开目录；无缓存时置 loading（懒加载由调用方发起请求） */
export function treeExpand(data: DirTreeData, path: DirTreeKey): DirTreeData {
  if (data.expanded.has(path)) return data;
  const expanded = new Set(data.expanded);
  const loading = new Set(data.loading);
  expanded.add(path);
  if (data.children.get(path) == null && !data.loading.has(path)) loading.add(path);
  return { ...data, expanded, loading };
}

export function treeCollapse(data: DirTreeData, path: DirTreeKey): DirTreeData {
  if (!data.expanded.has(path)) return data;
  const expanded = new Set(data.expanded);
  expanded.delete(path);
  return { ...data, expanded };
}

/** 目录加载成功：写入子列表并清 loading */
export function treeLoaded(data: DirTreeData, path: DirTreeKey, entries: FsBrowseEntry[]): DirTreeData {
  const children = new Map(data.children);
  const loading = new Set(data.loading);
  children.set(path, entries);
  loading.delete(path);
  return { ...data, children, loading };
}

/** 目录加载失败：收回展开并清 loading（行恢复可重试形态） */
export function treeLoadFailed(data: DirTreeData, path: DirTreeKey): DirTreeData {
  const expanded = new Set(data.expanded);
  const loading = new Set(data.loading);
  expanded.delete(path);
  loading.delete(path);
  return { ...data, expanded, loading };
}
