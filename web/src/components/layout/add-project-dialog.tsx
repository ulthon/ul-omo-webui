// 添加项目弹窗（todo 16 增强）：手动输入优先可见 + 路径自动补全 + "浏览…"目录树选择。
// 补全：输入停顿 300ms 且目录部分（最后一个 / 及之前）相对上次已取目录有新增时，
// 调 GET /api/fs/browse 拉子目录建议；非法路径（非 / 开头、含 ..）与越界 403 一律静默不建议。
// 回填只改输入框值，提交仍走 POST /api/projects 服务端校验（存在性/合法性唯一裁决方）。
// 从 topbar.tsx 移出独立成文件：弹窗体条件挂载（每次打开全新初始态，同 FilePickerDialog 模式）。
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Folder } from "lucide-react";
import { api, ApiError, type FsBrowseEntry } from "@/lib/api";
import { openProject } from "@/lib/bootstrap";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DirectoryPickerDialog } from "@/components/file-tree/directory-tree";
import {
  SUGGEST_DEBOUNCE_MS,
  browsePathOf,
  nextSuggestDir,
  pickSuggestions,
  suggestionBackfill,
  suggestDirOf,
} from "@/components/file-tree/directory-tree-logic";

/** 目录建议状态：记录取数时的目录部分，用于过滤陈旧结果（输入已跨目录段时不展示） */
interface SuggestState {
  dir: string;
  entries: FsBrowseEntry[];
}

export function AddProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 条件挂载：每次打开全新初始态（路径/建议/错误随卸载重置），重开不带残留建议 */}
      {open && <AddProjectForm onOpenChange={onOpenChange} />}
    </Dialog>
  );
}

function AddProjectForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [suggest, setSuggest] = useState<SuggestState | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 浏览器选目录回填后抑制补全（不弹同级建议，直至用户再键入） */
  const [suppress, setSuppress] = useState(false);
  const lastDirRef = useRef<string | null>(null);
  /** 建议下拉开合镜像（供 radix onEscapeKeyDown 判定：下拉开着时 Escape 只收下拉不关弹窗） */
  const suggestOpenRef = useRef(false);
  useEffect(() => {
    suggestOpenRef.current = suggest !== null && suggestDirOf(path) !== null;
  }, [suggest, path]);

  // 防抖补全：停顿 300ms 后判定目录部分是否有新增；同步 setState 只出现在定时器/承诺回调内
  useEffect(() => {
    const timer = setTimeout(() => {
      if (suppress) return;
      const next = nextSuggestDir(path, lastDirRef.current);
      if (next === null) {
        if (suggestDirOf(path) === null) {
          // 目录部分失效（清空/非绝对/含 ..）：清建议与已取记录
          lastDirRef.current = null;
          setSuggest(null);
        }
        return;
      }
      lastDirRef.current = next;
      api
        .fsBrowse(browsePathOf(next))
        .then((res) => setSuggest({ dir: next, entries: res.entries }))
        .catch(() => setSuggest(null)); // 越界 403/网络错误静默不建议
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [path, suppress]);

  const suggestions = useMemo(() => {
    if (!suggest) return [];
    const dir = suggestDirOf(path);
    if (dir === null || dir !== suggest.dir) return [];
    return pickSuggestions(path, suggest.entries);
  }, [path, suggest]);

  const choose = (entry: FsBrowseEntry) => {
    setPath(suggestionBackfill(entry));
    setHighlight(0);
  };

  // 补全下拉打开时接管 ↑↓/Enter；Escape 只收下拉（关弹窗交给 radix onEscapeKeyDown 门卫判定）
  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(suggestions[Math.min(highlight, suggestions.length - 1)]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setSuppress(true);
      setSuggest(null);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!path.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.addProject(path.trim());
      const { projects } = await api.listProjects();
      useUiStore.getState().setProjects(projects);
      onOpenChange(false);
      await openProject(path.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "添加失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogContent
      className="sm:max-w-md"
      onEscapeKeyDown={(e) => {
        // 建议下拉开着时 Escape 语义 = 收下拉（input keydown 已置 suppress+清建议），不关弹窗
        if (suggestOpenRef.current) e.preventDefault();
      }}
    >
      <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>添加项目</DialogTitle>
        <DialogDescription>
          输入服务器上的项目目录绝对路径，服务端校验存在性与合法性。输入 / 开头路径可自动补全目录。
        </DialogDescription>
      </DialogHeader>
      <div className="mt-4 space-y-2">
        <div className="flex items-stretch gap-2">
          <div className="relative min-w-0 flex-1">
            <Input
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setSuppress(false);
                setHighlight(0);
              }}
              onKeyDown={onInputKeyDown}
              placeholder="/home/user/my-project"
              className="h-11"
              data-testid="add-project-input"
              autoFocus
              autoComplete="off"
            />
            {suggestions.length > 0 && (
              <ul
                data-testid="path-suggestions"
                role="listbox"
                aria-label="目录建议"
                className="absolute inset-x-0 top-full z-50 mt-1 max-h-60 overflow-auto rounded-lg border bg-popover p-1 shadow-md"
              >
                {suggestions.map((entry, i) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === highlight || undefined}
                      data-testid={`path-suggestion-${i}`}
                      onMouseDown={(e) => {
                        e.preventDefault(); // 保住输入框焦点，滚动态不闪
                        choose(entry);
                      }}
                      className={`flex h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted ${
                        i === highlight ? "bg-muted" : ""
                      }`}
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">{entry.name}</span>
                      <span className="ml-auto hidden min-w-0 max-w-[45%] truncate font-mono text-xs text-muted-foreground sm:block">
                        {entry.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-11 shrink-0"
            data-testid="browse-dir-btn"
            onClick={() => setPickerOpen(true)}
          >
            浏览…
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button type="submit" disabled={submitting || !path.trim()}>
          {submitting ? "添加中…" : "添加"}
        </Button>
      </DialogFooter>
      <DirectoryPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onConfirm={(picked) => {
          setPath(picked);
          setSuppress(true);
          setHighlight(0);
        }}
      />
      </form>
    </DialogContent>
  );
}
