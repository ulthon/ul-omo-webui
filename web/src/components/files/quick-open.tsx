// 工具栏模糊快速打开（files-ux-revamp 任务 7 / IS-3）：图标钮展开内联输入框，
// 首次展开即后台有界扫描项目路径全集（file-picker 同款 collectProjectPaths；
// 索引与项目绑定，项目变化即作废旧索引待重扫，只活在本组件实例，卸载即弃，
// 无跨挂载缓存）。键入 filterPaths 模糊过滤，
// ↑↓ 移动 active 项，Enter/点击回调 onOpen；Escape/失焦关闭并清词。扫描完成前
// 只能匹配已收集部分（本实现为一次性 promise，完成前显示扫描提示，与 picker 同口径）。
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { baseName, collectProjectPaths, filterPaths } from "@/components/file-tree/file-tree-logic";
import { useT } from "@/i18n/i18n";

export function QuickOpen({
  project,
  testId,
  onOpen,
}: {
  /** 项目路径；空串（页面尚无项目）不渲染入口 */
  project: string;
  testId: string;
  /** 选中命中项回调（宿主负责 setDir/setSelected/openSeq/reveal） */
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 扫描索引与项目绑定：scan.project 落后于组件 project 时视为未扫描（派生 null）。
  // null = 扫描进行中（或待扫描）；[] = 扫描完成且为空
  const [scan, setScan] = useState<{ project: string; paths: string[] | null }>(() => ({ project, paths: null }));
  const allPaths = scan.project === project ? scan.paths : null;
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const t = useT();

  // 展开且当前项目未扫描时后台扫描（有界）；失败静默落空集（输入仍可关闭，不影响宿主）。
  // 项目变化（含展开中切换）经 allPaths 派生为未扫描、cancelled 抛弃旧在途回包，
  // 下次 effect 以新项目重扫（F3b ADV-3：切项目后命中旧项目路径）
  useEffect(() => {
    if (!open || !project || allPaths !== null) return;
    let cancelled = false;
    collectProjectPaths(project)
      .then((paths) => {
        if (!cancelled) setScan({ project, paths });
      })
      .catch(() => {
        if (!cancelled) setScan({ project, paths: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [open, project, allPaths]);

  // 展开即聚焦输入框（键盘流入口）
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const matches = useMemo(() => (open ? filterPaths(allPaths ?? [], query) : []), [open, allPaths, query]);
  const searching = open && query.trim().length > 0;

  const close = () => {
    setOpen(false);
    setQuery("");
    setHighlight(0);
  };

  const pickPath = (path: string) => {
    onOpen(path);
    close();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (!searching || matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickPath(matches[Math.min(highlight, matches.length - 1)]);
    }
  };

  if (!project) return null;

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        data-testid={testId}
        aria-label={t("files.quickOpen.openAria")}
        title={t("files.quickOpen.openAria")}
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" aria-hidden />
      </Button>
    );
  }

  return (
    <div
      data-testid={testId}
      className="relative"
      // 失焦关闭：焦点离开容器（含输入框与下拉）即收起并清词
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) close();
      }}
    >
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        data-testid={`${testId}-input`}
        aria-label={t("files.quickOpen.placeholder")}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        placeholder={t("files.quickOpen.placeholder")}
        className="h-8 w-56 rounded-md border border-input bg-transparent pl-8 pr-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      {searching && (
        <div
          data-testid={`${testId}-dropdown`}
          className="absolute top-full left-0 z-50 mt-1 max-h-72 w-72 max-w-[calc(100vw-2rem)] overflow-auto rounded-lg border bg-popover p-1 shadow-md"
        >
          {matches.length === 0 ? (
            <div data-testid={`${testId}-no-match`} className="flex items-center justify-center gap-2 p-3 text-center text-sm text-muted-foreground">
              {allPaths === null ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" aria-hidden />
                  {t("files.quickOpen.scanning")}
                </>
              ) : (
                t("files.quickOpen.noMatch")
              )}
            </div>
          ) : (
            <ul role="listbox" data-testid={`${testId}-matches`}>
              {matches.map((path, i) => (
                <li key={path} role="option" aria-selected={i === highlight || undefined}>
                  <button
                    type="button"
                    data-testid={`${testId}-match-${i}`}
                    // 阻止 mousedown 抢焦点导致输入框先失焦收起
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickPath(path)}
                    className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted ${
                      i === highlight ? "bg-muted" : ""
                    }`}
                  >
                    <span className="shrink-0 font-medium">{baseName(path)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
