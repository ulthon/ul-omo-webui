// 添加项目目录浏览纯逻辑（todo 16）：路径补全触发判定、建议列表生成、目录树状态转移。
// 组件层（directory-tree / add-project-dialog）只做渲染与请求编排，可测逻辑全部收敛在此。
// 数据源是 /api/fs/browse（todo 7）：仅目录、base=realpath(home)、entry.path 为绝对路径——
// 与 fs/tree（项目内相对路径）不同源，故 DirectoryTree 独立实现不复用 FileTree。
import type { FsBrowseEntry } from "@/lib/api";

/** 补全防抖窗口：输入停顿该毫秒数后才发起目录请求 */
export const SUGGEST_DEBOUNCE_MS = 300;

/** 下拉建议条数上限（home 根目录几十条以内，深目录防刷屏） */
export const SUGGEST_LIMIT = 30;

/**
 * 输入框文本中"已输入目录部分"（最后一个 / 及其之前）。
 * 非绝对路径（缺省 / 前缀）、含 ..（逃逸语义）、空串 → null（静默不建议）。
 */
export function suggestDirOf(raw: string): string | null {
  if (!raw.startsWith("/")) return null;
  if (raw.includes("..")) return null;
  const i = raw.lastIndexOf("/");
  return i <= 0 ? "/" : raw.slice(0, i + 1);
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

/** 目录部分 → browse path 参数：根目录 "/" 越界（base=home），映射为缺省参数（服务端取 home） */
export function browsePathOf(dir: string): string | undefined {
  return dir === "/" ? undefined : dir;
}

/**
 * 建议列表：按尾部未完成段过滤（大小写不敏感子串），排序为
 * 非隐藏优先 > 段首前缀命中优先 > 名称字典序；截断到 SUGGEST_LIMIT。
 */
export function pickSuggestions(raw: string, entries: FsBrowseEntry[]): FsBrowseEntry[] {
  const dir = suggestDirOf(raw);
  if (dir === null) return [];
  const seg = raw.slice(dir.length).toLowerCase();
  const prefixOf = (e: FsBrowseEntry): 0 | 1 => (e.name.toLowerCase().startsWith(seg) ? 0 : 1);
  return entries
    .filter((e) => seg === "" || e.name.toLowerCase().includes(seg))
    .sort(
      (a, b) =>
        Number(a.hidden) - Number(b.hidden) || prefixOf(a) - prefixOf(b) || a.name.localeCompare(b.name),
    )
    .slice(0, SUGGEST_LIMIT);
}

/** 点选建议后的回填值：建议目录完整路径 + 尾随 /（可继续下钻输入） */
export function suggestionBackfill(entry: FsBrowseEntry): string {
  return `${entry.path}/`;
}

// ---------- DirectoryTree 状态转移（纯函数，状态三件套整体替换触发渲染） ----------

/** 树键："" = home 根（browse 缺省参数），其余为 entry 绝对路径 */
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
