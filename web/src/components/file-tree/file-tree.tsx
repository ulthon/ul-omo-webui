// 懒加载目录树（todo 20）：展开目录时逐级拉取 GET /api/fs/tree（单层），文件行点击上抛选中。
// 性能取舍：单目录条目渲染不做虚拟化——服务端单层分片天然限制单次渲染量，数百行 DOM
// 直渲染无感知卡顿（QA 实测记录）；真实卡顿出现再考虑虚拟化。
import { useCallback, useEffect, useState } from "react";
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
import { api, type FsTreeEntry } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { imageMimeOf } from "./file-tree-logic";

export type TreeLoadState = "idle" | "loading" | "error";

interface TreeData {
  /** 目录路径（"" 为根）→ 子条目；null = 尚未加载 */
  children: Map<string, FsTreeEntry[] | null>;
  expanded: Set<string>;
  loading: Set<string>;
}

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
  data: TreeData;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  toggle: (dirPath: string, entry: FsTreeEntry) => void;
}

function TreeRow({ dirPath, entry, depth, data, selectedPath, onSelect, toggle }: TreeRowProps) {
  const path = dirPath ? `${dirPath}/${entry.name}` : entry.name;
  const isDir = entry.type === "directory";
  const expanded = data.expanded.has(path);
  const loading = data.loading.has(path);
  const children = data.children.get(path);
  const selected = selectedPath === path;

  return (
    <div>
      <button
        type="button"
        data-testid={`tree-row-${path}`}
        aria-expanded={isDir ? expanded : undefined}
        aria-selected={selected || undefined}
        onClick={() => (isDir ? toggle(dirPath, entry) : onSelect(path))}
        className={`flex h-11 w-full items-center gap-1 rounded-lg px-1.5 text-left text-sm transition-colors hover:bg-muted ${
          selected ? "bg-muted text-foreground" : ""
        }`}
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
      {isDir && expanded &&
        (children ?? []).map((child) => (
          <TreeRow
            key={child.name}
            dirPath={path}
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

export function FileTree({
  project,
  selectedPath,
  onSelect,
}: {
  project: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  // Map/Set 装在同一个对象里整体替换，保证浅比较触发重渲染；根目录（""）挂载即在加载中
  const [data, setData] = useState<TreeData>(() => ({
    children: new Map(),
    expanded: new Set(),
    loading: new Set([""]),
  }));

  // 发起目录请求（loading 置位由调用方负责：挂载在初始 state、展开在事件处理器）
  const fetchDir = useCallback(
    (path: string) => {
      api
        .fsTree(project, path || undefined)
        .then((res) => {
          setData((prev) => {
            const children = new Map(prev.children);
            const loading = new Set(prev.loading);
            children.set(path, res.entries);
            loading.delete(path);
            return { ...prev, children, loading };
          });
        })
        .catch((err: unknown) => {
          setData((prev) => {
            const expanded = new Set(prev.expanded);
            const loading = new Set(prev.loading);
            expanded.delete(path);
            loading.delete(path);
            return { ...prev, expanded, loading };
          });
          showToast(err instanceof Error ? err.message : "目录加载失败", "error");
        });
    },
    [project, showToast],
  );

  useEffect(() => {
    fetchDir("");
  }, [fetchDir]);

  const toggle = useCallback(
    (dirPath: string, entry: FsTreeEntry) => {
      const path = dirPath ? `${dirPath}/${entry.name}` : entry.name;
      if (data.expanded.has(path)) {
        setData((prev) => {
          const expanded = new Set(prev.expanded);
          expanded.delete(path);
          return { ...prev, expanded };
        });
        return;
      }
      setData((prev) => {
        const expanded = new Set(prev.expanded);
        const loading = new Set(prev.loading);
        expanded.add(path);
        if (prev.children.get(path) == null && !prev.loading.has(path)) loading.add(path);
        return { ...prev, expanded, loading };
      });
      // 懒加载：展开且无缓存时拉取该层
      if (data.children.get(path) == null && !data.loading.has(path)) fetchDir(path);
    },
    [data.expanded, data.children, data.loading, fetchDir],
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
        <div className="p-3 text-sm text-muted-foreground">目录为空</div>
      ) : (
        root.map((entry) => (
          <TreeRow
            key={entry.name}
            dirPath=""
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
