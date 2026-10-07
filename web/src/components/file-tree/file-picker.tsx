// @ 文件选择器弹窗（todo 20）：懒加载树导航 + 模糊过滤命中列表 + 只读预览 + 插入引用。
// 桌面居中弹窗双栏（树 | 预览）；390x844 移动端全屏化（选中文件即预览整屏，返回回树）。
// 模糊过滤数据源：打开时后台做一次有界全量路径扫描（file-tree-logic.collectProjectPaths，
// 深度/条目上限防大仓库拖垮）；扫描完成前搜索只匹配已加载部分，树导航始终逐级懒加载。
import { useEffect, useMemo, useRef, useState } from "react";
import { AtSign, CornerDownLeft, LoaderCircle, Search, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileTree } from "./file-tree";
import { FilePreview } from "./file-preview";
import { baseName, collectProjectPaths, filterPaths } from "./file-tree-logic";

export function FilePickerDialog({
  open,
  onOpenChange,
  project,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: string;
  /** 选中引用（插入 @path 后由调用方关闭弹窗） */
  onPick: (path: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent
          data-testid="file-picker"
          className="top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-3 rounded-none p-3 sm:top-1/2 sm:left-1/2 sm:h-[85vh] sm:max-h-[85vh] sm:w-[calc(100%-2rem)] sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
        >
          {/* 条件挂载：每次打开即全新初始态（搜索/选中/索引重置随挂载自然发生） */}
          <PickerBody project={project} onPick={onPick} onClose={() => onOpenChange(false)} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function PickerBody({
  project,
  onPick,
  onClose,
}: {
  project: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [allPaths, setAllPaths] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // 挂载即后台扫描路径全集（有界）；失败静默（树导航不受影响）
  useEffect(() => {
    const timer = setTimeout(() => searchRef.current?.focus(), 50);
    let cancelled = false;
    collectProjectPaths(project)
      .then((paths) => {
        if (!cancelled) setAllPaths(paths);
      })
      .catch(() => {
        if (!cancelled) setAllPaths([]);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [project]);

  const matches = useMemo(() => filterPaths(allPaths ?? [], query), [allPaths, query]);
  const searching = query.trim().length > 0;

  const pick = (path: string) => {
    onPick(path);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!searching || matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(matches[Math.min(highlight, matches.length - 1)]);
    }
  };

  return (
    <>
        <DialogHeader className="shrink-0 gap-1.5">
          <DialogTitle className="flex items-center gap-1.5 text-sm">
            <AtSign className="size-4 text-muted-foreground" />
            引用文件
          </DialogTitle>
          <DialogDescription className="text-xs">选择文件插入 @ 路径引用（只读预览）</DialogDescription>
        </DialogHeader>

        <div className="relative shrink-0">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            data-testid="file-picker-search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="模糊搜索文件名或路径…"
            className="h-11 w-full rounded-lg border border-input bg-transparent pr-9 pl-9 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          {searching && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        <div className="flex min-h-0 flex-1 gap-3">
          {/* 树 / 命中列表：移动端选中后让位给预览（lg 起双栏常驻） */}
          <div
            className={`min-h-0 flex-1 overflow-auto rounded-lg border p-1 lg:block lg:w-60 lg:flex-none ${
              selected ? "hidden" : "block"
            }`}
          >
            {searching ? (
              matches.length === 0 ? (
                <div data-testid="file-picker-no-match" className="p-4 text-center text-sm text-muted-foreground">
                  {allPaths === null ? (
                    <span className="flex items-center justify-center gap-2">
                      <LoaderCircle className="size-4 animate-spin" />
                      正在索引文件…
                    </span>
                  ) : (
                    "无匹配文件"
                  )}
                </div>
              ) : (
                <ul data-testid="file-picker-matches">
                  {matches.map((path, i) => (
                    <li key={path}>
                      <button
                        type="button"
                        data-testid={`file-match-${i}`}
                        aria-selected={i === highlight || undefined}
                        onClick={() => setSelected(path)}
                        onDoubleClick={() => pick(path)}
                        className={`flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors hover:bg-muted ${
                          i === highlight ? "bg-muted" : ""
                        } ${selected === path ? "ring-1 ring-ring" : ""}`}
                      >
                        <span className="min-w-0 flex-1 truncate">{baseName(path)}</span>
                        <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline sm:max-w-40 sm:truncate">
                          {path}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <FileTree
                project={project}
                selectedPath={selected}
                onSelect={(path) => setSelected(path)}
              />
            )}
          </div>

          {/* 预览：桌面右栏常驻；移动端选中即全屏（含返回） */}
          <div
            className={`min-h-0 flex-1 overflow-auto rounded-lg border p-3 lg:block ${selected ? "block" : "hidden"}`}
          >
            {selected ? (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <button
                  type="button"
                  data-testid="preview-back"
                  onClick={() => setSelected(null)}
                  className="flex h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg border text-sm transition-colors hover:bg-muted lg:hidden"
                >
                  <X className="size-4" />
                  返回文件列表
                </button>
                <div className="min-h-0 flex-1 lg:max-h-none">
                  <FilePreview key={selected} project={project} path={selected} onInsert={pick} />
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
                选择文件查看只读预览
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            {allPaths === null ? (
              <>
                <LoaderCircle className="size-3 animate-spin" />
                索引中（搜索渐进可用）
              </>
            ) : (
              `已索引 ${allPaths.length} 项`
            )}
          </span>
          <span className="hidden items-center gap-1 sm:flex">
            <CornerDownLeft className="size-3" />
            搜索时 Enter 插入首个命中
          </span>
          <button
            type="button"
            data-testid="file-picker-cancel"
            onClick={onClose}
            className="flex h-11 items-center rounded-lg border px-3 transition-colors hover:bg-muted"
          >
            取消
          </button>
        </div>
    </>
  );
}
