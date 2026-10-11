// 目录树（todo 16）：不受 project 约束的独立组件，消费 /api/fs/browse（base=realpath(home)，
// 仅目录），与 fs/tree（项目内相对路径）不同源，故不复用 FileTree 本体。
// 懒加载与状态三件套（children/expanded/loading 同一对象整体替换）沿用 todo 20 FileTree 模式；
// 请求函数可注入（单测）。行点击 = 选中 + 未展开时下钻；chevron 单独承担展开/收起。
// DirectoryPickerDialog：添加项目用的目录选择弹窗，390 移动端全屏（h-dvh 覆盖类同 FilePickerDialog），
// 当前选中路径高亮 + "选择此目录"确认；重开弹窗条件挂载即全新初始态。
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, FolderOpen, LoaderCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, type FsBrowseEntry, type FsBrowseResponse } from "@/lib/api";
import {
  initialDirTree,
  treeCollapse,
  treeExpand,
  treeLoaded,
  treeLoadFailed,
  type DirTreeData,
  type DirTreeKey,
} from "./directory-tree-logic";

export type DirTreeFetcher = (path?: string) => Promise<FsBrowseResponse>;

interface DirRowProps {
  path: DirTreeKey;
  entry: FsBrowseEntry;
  depth: number;
  data: DirTreeData;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  toggle: (path: DirTreeKey) => void;
}

function DirRow({ path, entry, depth, data, selectedPath, onSelect, toggle }: DirRowProps) {
  const expanded = data.expanded.has(path);
  const loading = data.loading.has(path);
  const children = data.children.get(path);
  const selected = selectedPath === path;

  return (
    <div>
      <div
        data-testid={`dir-row-${path}`}
        role="treeitem"
        aria-selected={selected || undefined}
        aria-expanded={expanded}
        className={`flex h-11 items-center gap-0.5 rounded-lg pr-1.5 transition-colors hover:bg-muted ${
          selected ? "bg-muted text-foreground" : ""
        }`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        <button
          type="button"
          data-testid={`dir-toggle-${path}`}
          aria-label={`${expanded ? "收起" : "展开"} ${entry.name}`}
          onClick={() => toggle(path)}
          className="flex w-8 shrink-0 items-center justify-center self-stretch text-muted-foreground transition-colors hover:bg-muted"
        >
          {loading ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <ChevronRight className={`size-4 transition-transform ${expanded ? "rotate-90" : ""}`} />
          )}
        </button>
        <button
          type="button"
          data-testid={`dir-name-${path}`}
          onClick={() => {
            onSelect(path);
            if (!expanded) toggle(path);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded-md text-left text-sm transition-colors"
        >
          {expanded ? (
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate">{entry.name}</span>
        </button>
      </div>
      {expanded &&
        (children ?? []).map((child) => (
          <DirRow
            key={child.path}
            path={child.path}
            entry={child}
            depth={depth + 1}
            data={data}
            selectedPath={selectedPath}
            onSelect={onSelect}
            toggle={toggle}
          />
        ))}
    </div>
  );
}

export function DirectoryTree({
  selectedPath,
  onSelect,
  fetchDir = api.fsBrowse,
}: {
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** 可注入（单测）；缺省走 /api/fs/browse */
  fetchDir?: DirTreeFetcher;
}) {
  // 三件套装同一对象整体替换（todo 20 模式）；根键 "" 初始即在加载中，挂载后由 effect 发起请求
  const [data, setData] = useState<DirTreeData>(initialDirTree);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(
    (path: DirTreeKey) => {
      fetchDir(path === "" ? undefined : path)
        .then((res) => {
          setData((prev) => treeLoaded(prev, path, res.entries));
          setLoadError(null);
        })
        .catch((err: unknown) => {
          setData((prev) => treeLoadFailed(prev, path));
          setLoadError(err instanceof Error ? err.message : "目录加载失败");
        });
    },
    [fetchDir],
  );

  useEffect(() => {
    load("");
  }, [load]);

  const toggle = useCallback(
    (path: DirTreeKey) => {
      setData((prev) => {
        if (prev.expanded.has(path)) return treeCollapse(prev, path);
        return treeExpand(prev, path);
      });
      // 懒加载：展开且无缓存时拉取该层（读取当前快照判断，避免在 setState 内发请求）
      if (!data.expanded.has(path) && data.children.get(path) == null && !data.loading.has(path)) {
        load(path);
      }
    },
    [data.expanded, data.children, data.loading, load],
  );

  const root = data.children.get("");
  const rootLoading = data.loading.has("");

  return (
    <div data-testid="directory-tree" role="tree" aria-label="服务器目录" className="min-h-0">
      {loadError && (
        <p data-testid="dir-tree-error" className="px-2 py-1 text-xs text-destructive">
          {loadError}
        </p>
      )}
      {root === undefined || rootLoading ? (
        <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
        </div>
      ) : !root || root.length === 0 ? (
        <div className="p-3 text-sm text-muted-foreground">目录为空</div>
      ) : (
        root.map((entry) => (
          <DirRow
            key={entry.path}
            path={entry.path}
            entry={entry}
            depth={0}
            data={data}
            selectedPath={selectedPath}
            onSelect={onSelect}
            toggle={toggle}
          />
        ))
      )}
    </div>
  );
}

/** 目录选择弹窗：确认回传所选目录绝对路径；条件挂载 Body，重开即重置选中 */
export function DirectoryPickerDialog({
  open,
  onOpenChange,
  onConfirm,
  fetchDir,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (path: string) => void;
  fetchDir?: DirTreeFetcher;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent
          data-testid="directory-picker"
          className="top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-3 rounded-none p-3 sm:top-1/2 sm:left-1/2 sm:h-[85vh] sm:max-h-[85vh] sm:w-[calc(100%-2rem)] sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
        >
          <PickerBody
            onConfirm={(path) => {
              onConfirm(path);
              onOpenChange(false);
            }}
            onClose={() => onOpenChange(false)}
            fetchDir={fetchDir}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

function PickerBody({
  onConfirm,
  onClose,
  fetchDir,
}: {
  onConfirm: (path: string) => void;
  onClose: () => void;
  fetchDir?: DirTreeFetcher;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <DialogHeader className="shrink-0 gap-1.5">
        <DialogTitle>浏览目录</DialogTitle>
        <DialogDescription className="text-xs">
          从主目录（home）逐级展开选择项目所在目录
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border p-1" data-testid="dir-tree-scroll">
        <DirectoryTree selectedPath={selected} onSelect={setSelected} fetchDir={fetchDir} />
      </div>

      <div className="flex shrink-0 flex-col gap-2">
        <p data-testid="dir-picker-selected" className="truncate font-mono text-xs text-muted-foreground">
          {selected ?? "尚未选择目录"}
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="dir-picker-cancel"
            onClick={onClose}
            className="flex h-11 items-center rounded-lg border px-4 text-sm transition-colors hover:bg-muted"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="dir-picker-confirm"
            disabled={!selected}
            onClick={() => selected && onConfirm(selected)}
            className="flex h-11 items-center rounded-lg bg-primary px-4 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            选择此目录
          </button>
        </div>
      </div>
    </>
  );
}
