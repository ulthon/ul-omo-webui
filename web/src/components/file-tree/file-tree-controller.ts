// 文件树 headless controller（files-ux-revamp 任务 1）：目录树数据层从 FileTree 组件中
// 抽出为可测 hook + 纯转移函数。组件层（file-tree / files-page）只消费返回面渲染，
// 请求编排、失效、竞态防护、reveal 逐段导航全部收敛在此（分层口径同 directory-tree-logic）。
//
// 设计要点：
// - 纯转移函数沿用 directory-tree-logic 命名与不可变风格：每次转移整体替换 FileTreeData
//   （Map/Set 均新建），浅比较即可触发重渲染；根目录键 ""，children 缺失 = 尚未加载。
// - gen 计数器（每目录一代号）：loadDir 派发时快照 gen，回包只认代号一致的响应——
//   refreshDirs 先自增 gen 再回源，旧在途响应（如慢网下的首次加载）回来后因代号不匹配
//   被静默丢弃，避免旧数据覆盖新状态；项目切换整体自增 resetRef 代纪元，跨项目迟到
//   响应同样拦截（gen 快照与 reset 快照任一不符即丢）。
// - refresh / evict 双集合分离（失效矩阵 dirsAfterOp）：refresh = 操作后父级列表变动、
//   需要立即可见新内容的目录；evict = 已不存在的路径（删除/移动源）。两者都逐出子树
//   缓存（children/loading）且 evict 绝不回源——对旧路径重取必 404，会产生假错误 toast。
//   expanded 只对 evict 子树收起（死亡目录不能留在树里）；refresh 路径保留展开并立即
//   回源（"曾加载过或（逐出前）展开"的目录），这是写操作后树保留展开态（IS-2）的核心；
//   其余只丢缓存（下次展开时懒加载）。
// - reveal 用代纪元令牌的状态机：后发 reveal 自增纪元使在途 reveal 逐步作废（superseded）；
//   每步先验项目快照（project_changed 更具体，优先于 superseded 报告），再验纪元；
//   中途失败不回滚已展开的祖先目录（保留用户可见的导航进度）。
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type FsTreeEntry, type FsTreeResponse } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { apiErrorMessage } from "@/i18n/errors";

export interface FileTreeData {
  /** 目录相对路径（"" 为项目根）→ 子条目；缺失 = 尚未加载（null 保留给渲染侧空态语义） */
  children: Map<string, FsTreeEntry[] | null>;
  expanded: Set<string>;
  loading: Set<string>;
}

/** 初始态：根目录（""）直接处于加载中（挂载即加载，避免 effect 内同步 setState） */
export function initialFileTreeData(): FileTreeData {
  return { children: new Map(), expanded: new Set(), loading: new Set([""]) };
}

/** 展开目录；无缓存时置 loading（懒加载由调用方发起请求） */
export function treeExpand(data: FileTreeData, path: string): FileTreeData {
  if (data.expanded.has(path)) return data;
  const expanded = new Set(data.expanded);
  const loading = new Set(data.loading);
  expanded.add(path);
  if (data.children.get(path) == null && !data.loading.has(path)) loading.add(path);
  return { ...data, expanded, loading };
}

export function treeCollapse(data: FileTreeData, path: string): FileTreeData {
  if (!data.expanded.has(path)) return data;
  const expanded = new Set(data.expanded);
  expanded.delete(path);
  return { ...data, expanded };
}

/** 目录加载成功：写入子列表并清 loading */
export function treeLoaded(data: FileTreeData, path: string, entries: FsTreeEntry[]): FileTreeData {
  const children = new Map(data.children);
  const loading = new Set(data.loading);
  children.set(path, entries);
  loading.delete(path);
  return { ...data, children, loading };
}

/** 目录加载失败：收回展开并清 loading（行恢复可重试形态） */
export function treeLoadFailed(data: FileTreeData, path: string): FileTreeData {
  const expanded = new Set(data.expanded);
  const loading = new Set(data.loading);
  expanded.delete(path);
  loading.delete(path);
  return { ...data, expanded, loading };
}

/**
 * 子树逐出（失效矩阵的执行原语）：paths 中每个 p 及其整棵子树（键 p 与 p+"/" 前缀）
 * 从 children/loading 一并移除；expanded 不动——局部刷新必须保留展开态（IS-2），
 * 驱逐子树的收起由 refreshDirs 用 treeCollapseExpanded 单独处理。
 * 与 treeLoadFailed 的"收回重试形态"不同：逐出是"该路径已不存在"的事实落库，
 * 不保留行、不回源。空串按同一规则退化为"移除根条目与以 / 开头的键"（树键不含首
 * 斜杠，即仅根条目本身，不清后代缓存）。
 */
export function treeInvalidate(data: FileTreeData, paths: string[]): FileTreeData {
  let touched = false;
  const children = new Map(data.children);
  const loading = new Set(data.loading);
  for (const p of paths) {
    const prefix = `${p}/`;
    for (const key of children.keys()) {
      if (key === p || key.startsWith(prefix)) {
        children.delete(key);
        touched = true;
      }
    }
    for (const key of loading) {
      if (key === p || key.startsWith(prefix)) {
        loading.delete(key);
        touched = true;
      }
    }
  }
  return touched ? { ...data, children, loading } : data;
}

/**
 * 驱逐子树的展开收起（refreshDirs 专用）：paths 及其子孙的 expanded 条目移除。
 * 与 treeInvalidate 分离的原因：局部刷新必须保留展开态（IS-2），只有已死亡的子树
 * （删除/移动源）才需要收起，避免死目录留在树里；该函数不改 children/loading。
 */
function treeCollapseExpanded(data: FileTreeData, paths: Set<string>): FileTreeData {
  let touched = false;
  const expanded = new Set(data.expanded);
  for (const p of paths) {
    const prefix = `${p}/`;
    for (const key of expanded) {
      if (key === p || key.startsWith(prefix)) {
        expanded.delete(key);
        touched = true;
      }
    }
  }
  return touched ? { ...data, expanded } : data;
}

/** 置 loading 不动 expanded（刷新回源/续载用；与 treeExpand 的展开侧语义分离） */
function treeReload(data: FileTreeData, path: string): FileTreeData {
  if (data.loading.has(path)) return data;
  const loading = new Set(data.loading);
  loading.add(path);
  return { ...data, loading };
}

/**
 * 父目录路径：最后一个 / 之前的部分。parentOf("a")=""（根）、parentOf("a/b/c")="a/b"、
 * parentOf("")=""；尾随 / 视为分隔符后跟空叶名（"a/b/" → "a/b"）。调用方传归一化
 * 路径，畸形输入不报错、只锁定确定性行为（畸形口径在测试中固化）。
 */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

/**
 * fs 写操作计划 → 树失效矩阵。refresh 与 evict 是两个独立集合、各自去重：
 * - create/mkdir：父目录列表新增条目 → 刷新父目录，无需逐出；
 * - delete：父目录列表少一个条目（刷新父目录），被删路径整棵子树已不存在（逐出）；
 * - move：from 与 to 的父目录列表都可能变化（去重后刷新），from 路径已不存在（逐出；
 *   to 处是新条目，由父目录刷新带入，不单独逐出）；
 * - upload：dir 列表新增条目（刷新该目录）。
 */
export type FsOpPlan =
  | { op: "create" | "mkdir" | "delete"; path: string }
  | { op: "move"; from: string; to: string }
  | { op: "upload"; dir: string };

export interface DirsAfterOp {
  /** 操作后必须立即可见新内容的目录（树里已加载过的会立即回源） */
  refresh: string[];
  /** 操作后已不存在的路径：只逐出子树缓存、绝不回源（重取必 404，避免假错误 toast） */
  evict: string[];
}

const dedupePaths = (paths: string[]): string[] => [...new Set(paths)];

export function dirsAfterOp(plan: FsOpPlan): DirsAfterOp {
  switch (plan.op) {
    case "create":
    case "mkdir":
      return { refresh: dedupePaths([parentOf(plan.path)]), evict: [] };
    case "delete":
      return { refresh: dedupePaths([parentOf(plan.path)]), evict: dedupePaths([plan.path]) };
    case "move":
      return {
        refresh: dedupePaths([parentOf(plan.from), parentOf(plan.to)]),
        evict: dedupePaths([plan.from]),
      };
    case "upload":
      return { refresh: dedupePaths([plan.dir]), evict: [] };
  }
}

/** 目录取数器：path 缺省 = 项目根。缺省实现走 api.fsTree（测试注入可编排替身） */
export type TreeFetcher = (path?: string) => Promise<FsTreeResponse>;

export type RevealResult =
  | { kind: "revealed"; path: string }
  | {
      kind: "missing";
      /** 定位中断处：最后确认存在的祖先目录（"" 为根）；invalid_path 恒为 "" */
      at: string;
      reason: "not_found" | "not_directory" | "invalid_path" | "project_changed";
    }
  | { kind: "superseded" };

/** reveal 成功后定位行高亮的自动清除窗口 */
export const HIGHLIGHT_CLEAR_MS = 1500;

export interface FileTreeController {
  data: FileTreeData;
  /** 展开/收起目录；展开且无缓存时懒加载（与既有 FileTree 交互语义一致） */
  toggleDir(path: string): void;
  /** 失效矩阵执行入口：refresh 集中已加载/展开的目录立即回源，evict 集只逐出不回源 */
  refreshDirs(refreshPaths: string[], evictPaths: string[]): void;
  /** 全量刷新：refreshDirs(loadedEver ∪ {""}, []) —— 宿主不自行拼路径集 */
  refreshAll(): void;
  /** 逐段定位到路径（展开途经目录、加载所需层），成功后设置定位与高亮 */
  reveal(path: string): Promise<RevealResult>;
  /** 最近一次成功 reveal 的路径；新 reveal 开始或项目切换时清空 */
  revealTarget: string | null;
  /** 定位高亮行（HIGHLIGHT_CLEAR_MS 后自动清除） */
  highlightPath: string | null;
}

export function useFileTreeController(
  project: string,
  opts?: { fetch?: TreeFetcher },
): FileTreeController {
  const pushGlobalError = useUiStore((s) => s.pushGlobalError);

  const [data, setData] = useState<FileTreeData>(initialFileTreeData);
  // dataRef 为权威最新态：转移函数经它同步推进再推给 setState，保证事件回调与异步
  // 续体（fetch 回包、reveal 步进）读到的永远是最新树，不依赖 React 批处理时机
  const dataRef = useRef(data);
  const apply = useCallback((t: (d: FileTreeData) => FileTreeData) => {
    const next = t(dataRef.current);
    dataRef.current = next;
    setData(next);
  }, []);

  const projectRef = useRef(project);

  /** 曾成功加载过的目录（缓存信任集）：refreshDirs 据此决定哪些目录立即回源 */
  const loadedEverRef = useRef<Set<string>>(new Set());
  /** 每目录代号：代号变更即在途响应作废（见文件头 gen 注释） */
  const genRef = useRef<Map<string, number>>(new Map());
  /** 项目代纪元：project 切换时自增，跨项目的迟到响应全部拦截 */
  const resetRef = useRef(0);
  /** 在途请求表：同目录并发调用共享同一 promise（reveal 步进不重复拉取） */
  const inflightRef = useRef<Map<string, Promise<boolean>>>(new Map());

  const revealEpochRef = useRef(0);
  // 定位/高亮与项目绑定（派生重置）：项目 prop 变化时读侧直接归零，无需 setState；
  // 修改只发生在 reveal 事件链与高亮定时器回调里（函数式更新，不依赖重置时序）
  const [loc, setLoc] = useState<{ project: string; target: string | null; highlight: string | null }>(() => ({
    project,
    target: null,
    highlight: null,
  }));
  const locCurrent = loc.project === project ? loc : { project, target: null, highlight: null };
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 拉取单层目录。返回 true = 新数据已落地；false = 失败（已走全局错误上报与
   * 收回形态）或响应过期被丢弃。同目录在途请求共享同一 promise。
   */
  const loadDir = useCallback(
    (path: string): Promise<boolean> => {
      const existing = inflightRef.current.get(path);
      if (existing) return existing;
      const reset = resetRef.current;
      const myGen = genRef.current.get(path) ?? 0;
      const stale = () => resetRef.current !== reset || (genRef.current.get(path) ?? 0) !== myGen;
      apply((d) => treeReload(d, path));
      const fetcher = opts?.fetch ?? ((p?: string) => api.fsTree(projectRef.current, p || undefined));
      const p: Promise<boolean> = fetcher(path || undefined).then(
        (res) => {
          inflightRef.current.delete(path);
          if (stale()) return false; // 过期响应静默丢弃：不落任何状态
          loadedEverRef.current.add(path);
          apply((d) => treeLoaded(d, path, res.entries));
          return true;
        },
        (err: unknown) => {
          inflightRef.current.delete(path);
          if (stale()) return false;
          apply((d) => treeLoadFailed(d, path));
          pushGlobalError(apiErrorMessage(err, "fileTree.tree.loadFailed"));
          return false;
        },
      );
      inflightRef.current.set(path, p);
      return p;
    },
    [apply, pushGlobalError, opts?.fetch],
  );

  const toggleDir = useCallback(
    (path: string) => {
      if (dataRef.current.expanded.has(path)) {
        apply((d) => treeCollapse(d, path));
        return;
      }
      const needFetch = dataRef.current.children.get(path) == null && !dataRef.current.loading.has(path);
      apply((d) => treeExpand(d, path));
      if (needFetch) void loadDir(path);
    },
    [apply, loadDir],
  );

  const refreshDirs = useCallback(
    (refreshPaths: string[], evictPaths: string[]) => {
      const refresh = dedupePaths(refreshPaths);
      const evictSet = new Set(dedupePaths(evictPaths));
      const all = dedupePaths([...refresh, ...evictPaths]);
      // 快照"曾加载集"与逐出前的展开事实：回源判定用的是失效前的事实
      const snapshotEver = new Set(loadedEverRef.current);
      const snapshotExpanded = new Set(dataRef.current.expanded);
      for (const p of all) {
        genRef.current.set(p, (genRef.current.get(p) ?? 0) + 1);
        inflightRef.current.delete(p); // 旧在途 promise 作废（其回包经 stale 判定丢弃）
      }
      for (const p of evictSet) loadedEverRef.current.delete(p);
      // 缓存逐出（children/loading）+ 仅 evict 子树收起展开（刷新路径保留展开态，IS-2）
      apply((d) => treeCollapseExpanded(treeInvalidate(d, all), evictSet));
      // 只回源 refresh 集中"曾加载过或（逐出前）展开中"的目录；evict 集永不回源
      const toRefetch = refresh.filter(
        (p) => !evictSet.has(p) && (snapshotEver.has(p) || snapshotExpanded.has(p)),
      );
      for (const p of toRefetch) void loadDir(p);
    },
    [apply, loadDir],
  );

  const refreshAll = useCallback(() => {
    refreshDirs([...loadedEverRef.current, ""], []);
  }, [refreshDirs]);

  const flashHighlight = useCallback((path: string) => {
    if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current);
    setLoc((prev) => ({ ...prev, highlight: path }));
    highlightTimerRef.current = setTimeout(() => {
      highlightTimerRef.current = null;
      setLoc((prev) => ({ ...prev, highlight: null }));
    }, HIGHLIGHT_CLEAR_MS);
  }, []);

  const reveal = useCallback(
    async (rawPath: string): Promise<RevealResult> => {
      const epoch = ++revealEpochRef.current; // 后发调用作废在途：新 reveal 开始
      setLoc((prev) => ({ ...prev, target: null })); // 新目标确立前清空旧定位
      const startProject = projectRef.current;
      // 归一化：空段与 "." 过滤；含 ".." 段视为非法（树是项目内相对路径，不允许上跳）
      const segs = rawPath.split("/").filter((s) => s !== "" && s !== ".");
      if (segs.some((s) => s === "..")) return { kind: "missing", at: "", reason: "invalid_path" };
      if (segs.length === 0) {
        // 空路径 = 根定位：无步进可做，直接揭示（根加载由挂载效果负责）
        setLoc((prev) => ({ ...prev, target: "" }));
        flashHighlight("");
        return { kind: "revealed", path: "" };
      }
      const checkEpoch = () => revealEpochRef.current === epoch;
      // 拉取失败/响应过期的归一判定：先看项目快照与纪元（原因更具体），落到 not_found
      const failAt = (at: string): RevealResult => {
        if (projectRef.current !== startProject) return { kind: "missing", at, reason: "project_changed" };
        if (!checkEpoch()) return { kind: "superseded" };
        return { kind: "missing", at, reason: "not_found" };
      };
      const ensureLoaded = async (dir: string): Promise<boolean> => {
        if (dataRef.current.children.get(dir) != null) return true;
        return loadDir(dir);
      };
      let cur = "";
      if (!(await ensureLoaded(""))) return failAt("");
      for (let i = 0; i < segs.length; i++) {
        // 每步先验项目快照（失效原因更具体，优先于 superseded 报告），再验纪元
        if (projectRef.current !== startProject) {
          return { kind: "missing", at: cur, reason: "project_changed" };
        }
        if (!checkEpoch()) return { kind: "superseded" };
        const children = dataRef.current.children.get(cur);
        const entry = children?.find((e) => e.name === segs[i]);
        if (!entry) return { kind: "missing", at: cur, reason: "not_found" };
        const child = cur ? `${cur}/${segs[i]}` : segs[i];
        if (i < segs.length - 1) {
          // 非末段必须是目录（symlink 不下钻）；已展开祖先不回滚，保留导航进度
          if (entry.type !== "directory") return { kind: "missing", at: cur, reason: "not_directory" };
          apply((d) => treeExpand(d, child));
          if (!(await ensureLoaded(child))) return failAt(child);
        }
        cur = child;
      }
      if (projectRef.current !== startProject) {
        return { kind: "missing", at: cur, reason: "project_changed" };
      }
      if (!checkEpoch()) return { kind: "superseded" };
      setLoc((prev) => ({ ...prev, target: cur }));
      flashHighlight(cur);
      return { kind: "revealed", path: cur };
    },
    [apply, flashHighlight, loadDir],
  );

  // 项目切换：清代号/信任集/在途表、reveal 纪元自增作废在途、清高亮定时器、
  // projectRef 对齐、整树经 apply 转移函数归位（定位态由派生归零，无 effect 内 setState）
  useEffect(() => {
    resetRef.current += 1;
    genRef.current = new Map();
    inflightRef.current = new Map();
    loadedEverRef.current = new Set();
    revealEpochRef.current += 1;
    if (highlightTimerRef.current !== null) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    projectRef.current = project;
    apply(() => initialFileTreeData());
  }, [project, apply]);

  // 挂载/项目切换后加载根目录（重置态已含根 loading，此处只发起请求）
  useEffect(() => {
    void loadDir("");
  }, [project, loadDir]);

  // 卸载清理：高亮定时器不再触碰已卸载组件
  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current);
    },
    [],
  );

  return { data, toggleDir, refreshDirs, refreshAll, reveal, revealTarget: locCurrent.target, highlightPath: locCurrent.highlight };
}
