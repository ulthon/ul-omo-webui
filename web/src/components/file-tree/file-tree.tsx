// 懒加载目录树（todo 20）：展开目录时逐级拉取 GET /api/fs/tree（单层），文件行点击上抛选中。
// 性能取舍：单目录条目渲染不做虚拟化——服务端单层分片天然限制单次渲染量，数百行 DOM
// 直渲染无感知卡顿（QA 实测记录）；真实卡顿出现再考虑虚拟化。
import { useCallback, useEffect, useRef } from "react";
import {
  ChevronRight,
  File as FileIcon,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  Package,
} from "lucide-react";
import { useT } from "@/i18n/i18n";
import { type FsTreeEntry } from "@/lib/api";
import { InlineRenameInput } from "@/components/files/inline-rename";
import { TREE_HIDDEN_DIRS, imageMimeOf } from "./file-tree-logic";
import { useFileTreeController, type FileTreeController, type FileTreeData, type TreeFetcher } from "./file-tree-controller";

export type TreeLoadState = "idle" | "loading" | "error";

/** 受控模式的回退 hook 取数器：永不 settle（files-ux-revamp 任务 3）。hooks 规则要求
 * fallback 无条件调用，其挂载/项目切换的 loadDir 会落到这条静默 promise 上——不发出
 * 任何请求（受控模式下回退树的数据本就不被渲染）。模块级常量保证 opts?.fetch 身份
 * 稳定，useFileTreeController 的 loadDir/effect 不因它重入；永不 settle 也意味着回包
 * 回调永不触发，无卸载后 setState、无错误上报 */
const SILENT_TREE_FETCH: TreeFetcher = () => new Promise(() => {});
const SILENT_TREE_FETCH_OPTS = { fetch: SILENT_TREE_FETCH };


function entryIcon(entry: FsTreeEntry, expanded: boolean, size: string) {
  const cls = `${size} shrink-0 text-muted-foreground`;
  if (entry.type === "directory") return expanded ? <FolderOpen className={cls} /> : <Folder className={cls} />;
  if (entry.type === "symlink") return <Link2 className={cls} />;
  if (entry.type === "other") return <Package className={cls} />;
  if (imageMimeOf(entry.name)) return <ImageIcon className={cls} />;
  if (/\.(md|txt|json|ts|tsx|js|jsx|css|html|xml|ya?ml|toml|sh|py|go|rs)$/i.test(entry.name))
    return <FileText className={cls} />;
  return <FileIcon className={cls} />;
}

interface TreeRowProps {
  dirPath: string;
  entry: FsTreeEntry;
  depth: number;
  data: FileTreeData;
  selectedPath: string | null;
  /** reveal 定位高亮：命中该路径的行渲染瞬时高亮（纯视觉，不碰 aria-selected） */
  highlightPath: string | null;
  onSelect: (path: string) => void;
  toggle: (dirPath: string, entry: FsTreeEntry) => void;
  /** 行 DOM 注册表：reveal 滚动定位用（卸载/重渲染时以 null 注销） */
  registerRow: (path: string, el: HTMLElement | null) => void;
  /** 可选（builtin-file-management 任务 2）：目录行被点击时上抛路径（文件管理页左栏
   * 同步中栏列表用）；既有消费方（composer @引用、添加项目弹窗）不传，行为不变 */
  onDirectoryOpen?: (path: string) => void;
  /** 是否渲染噪音目录（files-ux-revamp 任务 6）：false 时不渲染名字命中
   * TREE_HIDDEN_DIRS 的目录行（任意深度）；缓存仍存原始条目，切换即时生效零请求 */
  showHiddenDirs?: boolean;
  /** 行内重命名（files-ux-revamp 任务 9 / IS-6）：命中该路径的行渲染内联输入框
   * （预填原名，Enter 提交 / Esc 与失焦取消）；缺省 null 无行进入编辑态（既有
   * 消费方 file-picker 等不传，行为不变） */
  renamingPath?: string | null;
  /** 行内重命名提交（宿主校验后的合法新名，由宿主发 fsMove）与取消回调 */
  onRenameCommit?: (path: string, newName: string) => void;
  onRenameCancel?: () => void;
  /** 目录-only 选择模式（files-ux-revamp 任务 9 / FsMoveDialog）：文件行渲染为
   * 禁用（保留结构），目录行点击行为不变 */
  directoriesOnly?: boolean;
}

function TreeRow({
  dirPath,
  entry,
  depth,
  data,
  selectedPath,
  highlightPath,
  onSelect,
  toggle,
  onDirectoryOpen,
  showHiddenDirs,
  renamingPath,
  onRenameCommit,
  onRenameCancel,
  directoriesOnly,
  registerRow,
}: TreeRowProps) {
  const path = dirPath ? `${dirPath}/${entry.name}` : entry.name;
  const isDir = entry.type === "directory";
  const expanded = data.expanded.has(path);
  const loading = data.loading.has(path);
  const children = data.children.get(path);
  const selected = selectedPath === path;
  const flash = highlightPath === path;
  const renaming = renamingPath === path;

  return (
    <div>
      {renaming ? (
        <div
          className="pr-1.5"
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
        >
          <InlineRenameInput
            initial={entry.name}
            testId={`tree-rename-input-${path}`}
            className="h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-1.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            onCommit={(name) => onRenameCommit?.(path, name)}
            onCancel={() => onRenameCancel?.()}
          />
        </div>
      ) : (
      <button
        type="button"
        ref={(el) => registerRow(path, el)}
        data-flash={flash || undefined}
        data-testid={`tree-row-${path}`}
        aria-expanded={isDir ? expanded : undefined}
        aria-selected={selected || undefined}
        disabled={directoriesOnly && !isDir}
        aria-disabled={directoriesOnly && !isDir || undefined}
        onClick={() => {
          if (isDir) {
            toggle(dirPath, entry);
            onDirectoryOpen?.(path);
          } else {
            onSelect(path);
          }
        }}
        className={`flex h-11 w-full items-center gap-1 rounded-lg px-1.5 text-left text-sm transition-colors hover:bg-muted ${
          selected ? "bg-muted text-foreground" : ""
        } ${flash ? "ring-1 ring-ring" : ""} ${directoriesOnly && !isDir ? "cursor-not-allowed opacity-50" : ""}`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        {isDir ? (
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            {loading ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <ChevronRight className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
            )}
          </span>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        {entryIcon(entry, expanded, "size-4")}
        <span className="min-w-0 truncate">{entry.name}</span>
      </button>
      )}
      {isDir && expanded &&
        (children ?? [])
          .filter((child) => showHiddenDirs || child.type !== "directory" || !TREE_HIDDEN_DIRS.has(child.name))
          .map((child) => (
          <TreeRow
            key={child.name}
            dirPath={path}
            entry={child}
            depth={depth + 1}
            data={data}
            selectedPath={selectedPath}
            highlightPath={highlightPath}
            onSelect={onSelect}
            toggle={toggle}
            onDirectoryOpen={onDirectoryOpen}
            showHiddenDirs={showHiddenDirs}
            renamingPath={renamingPath}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
            directoriesOnly={directoriesOnly}
            registerRow={registerRow}
          />
        ))}
    </div>
  );
}

export function FileTree({
  project,
  selectedPath,
  onSelect,
  onDirectoryOpen,
  controller,
  showHiddenDirs = false,
  renamingPath = null,
  onRenameCommit,
  onRenameCancel,
  directoriesOnly = false,
}: {
  project: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** 可选（builtin-file-management 任务 2）：目录行点击时上抛路径，见 TreeRowProps 注释 */
  onDirectoryOpen?: (path: string) => void;
  /** 可选（files-ux-revamp 任务 2）：外部受控的 headless controller；缺省时组件内部自控，
   * 行为与既有消费方（file-picker 等）完全一致 */
  controller?: FileTreeController;
  /** files-ux-revamp 任务 6：false（默认）时渲染层隐藏任意深度的噪音目录，见 TreeRowProps 注释 */
  showHiddenDirs?: boolean;
  /** files-ux-revamp 任务 9 / IS-6：行内重命名与目录-only 选择，见 TreeRowProps 注释；
   * 全部可选，既有消费方（file-picker、composer @引用）不传零行为变化 */
  renamingPath?: string | null;
  onRenameCommit?: (path: string, newName: string) => void;
  onRenameCancel?: () => void;
  directoriesOnly?: boolean;
}) {
  const t = useT();
  // 自控模式：内部 hook（挂载/项目切换的根加载、gen 竞态防护都在 controller 内）；
  // 受控模式：hook 仍需无条件调用（hooks 规则），但注入静默取数器使回退树零请求
  const fallback = useFileTreeController(project, controller ? SILENT_TREE_FETCH_OPTS : undefined);
  const ctl = controller ?? fallback;
  const { data, toggleDir, revealTarget, highlightPath } = ctl;

  // 行 DOM 注册表：reveal 命中行滚动到视口中央
  const rowsRef = useRef(new Map<string, HTMLElement>());
  const registerRow = useCallback((path: string, el: HTMLElement | null) => {
    if (el) rowsRef.current.set(path, el);
    else rowsRef.current.delete(path);
  }, []);

  // reveal 定位：目标行渲染进 DOM 后（双 rAF 让位于绘制）滚动到中央；
  // 行仍未出现则重试一次，再不出现静默放弃——revealed 语义由 controller 拥有，渲染层不回滚
  useEffect(() => {
    if (revealTarget == null) return;
    let cancelled = false;
    const doubleRaf = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });
    void (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await doubleRaf();
        if (cancelled) return;
        const el = rowsRef.current.get(revealTarget);
        if (el) {
          el.scrollIntoView({ block: "center" });
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revealTarget]);

  // 点击统一走 controller.toggleDir：内部经 dataRef 读最新树（无闭包时序依赖）
  const toggle = useCallback(
    (dirPath: string, entry: FsTreeEntry) => {
      toggleDir(dirPath ? `${dirPath}/${entry.name}` : entry.name);
    },
    [toggleDir],
  );

  const root = data.children.get("");
  const rootLoading = data.loading.has("");

  return (
    <div data-testid="file-tree" className="min-h-0">
      {root === undefined || rootLoading ? (
        <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
        </div>
      ) : root === null ? (
        <div className="p-3 text-sm text-muted-foreground">{t("fileTree.tree.empty")}</div>
      ) : (
        root
          .filter((entry) => showHiddenDirs || entry.type !== "directory" || !TREE_HIDDEN_DIRS.has(entry.name))
          .map((entry) => (
          <TreeRow
            key={entry.name}
            dirPath=""
            entry={entry}
            depth={0}
            data={data}
            selectedPath={selectedPath}
            highlightPath={highlightPath}
            onSelect={onSelect}
            toggle={toggle}
            onDirectoryOpen={onDirectoryOpen}
            showHiddenDirs={showHiddenDirs}
            renamingPath={renamingPath}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
            directoriesOnly={directoriesOnly}
            registerRow={registerRow}
          />
        ))
      )}
    </div>
  );
}
