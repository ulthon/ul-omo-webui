// "未提交变更"页签（todo 19）：git status 文件列表 + 按文件 diff 渲染（只读）。
// 数据：GET /api/git/status（porcelain 列表）+ GET /api/git/diff（全量工作区 diff，
// 服务端无按文件参数——前端 parseGitDiff 切分后按选中路径取单文件）。
// 边界：untracked 文件与纯暂存改动不出现在 git diff 中，详情给说明性空态；
// 非 git 目录（409 not_a_git_repo）显示"无 Git 仓库"空态不报错；工作区干净显示空态。
// 手机端两级导航：文件列表 → 点开单文件 diff（返回按钮回列表）；lg 以上列表常驻左栏。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, CircleCheck, FolderGit2, RefreshCw } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import type { FileData } from "react-diff-view";
import { cleanStatusPath, matchDiffFile, parseGitDiff, statusInfo, type StatusInfo } from "./diff-utils";
import { FileDiff } from "./diff-view";

interface ChangeEntry {
  status: string;
  path: string;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "notGit" }
  | { phase: "ready"; entries: ChangeEntry[]; files: FileData[]; truncated: boolean };

const TONE_CLASS: Record<StatusInfo["tone"], string> = {
  add: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  modify: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  delete: "bg-red-500/15 text-red-600 dark:text-red-400",
  rename: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  untracked: "bg-muted text-muted-foreground",
  conflict: "bg-red-500/25 text-red-700 dark:text-red-300",
};

function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      {icon}
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

/** 列表条目在 diff 切分结果中缺席时的说明（untracked / 纯暂存） */
function fileMissingNote(entry: ChangeEntry): string {
  if (entry.status.includes("?")) return "未跟踪文件：尚未纳入 Git 管理，暂无 diff 内容。";
  return "该文件改动已暂存（staged），暂无未暂存的工作区 diff。";
}

function CenteredHint({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

export function ChangesView() {
  const project = useUiStore((s) => s.currentProject);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [viewType, setViewType] = useState<"unified" | "split">("unified");
  const [reloadSeq, setReloadSeq] = useState(0);

  const load = useCallback(async () => {
    if (!project) {
      setState({ phase: "ready", entries: [], files: [], truncated: false });
      return;
    }
    setState({ phase: "loading" });
    try {
      const status = await api.gitStatus(project);
      const entries: ChangeEntry[] = status.entries
        .map((e) => ({
          status: typeof e.status === "string" ? e.status : String(e.status ?? ""),
          path: cleanStatusPath(typeof e.path === "string" ? e.path : String(e.path ?? "")),
        }))
        .filter((e) => e.path.length > 0);
      let files: FileData[] = [];
      let truncated = false;
      try {
        const diff = await api.gitDiff(project);
        files = parseGitDiff(diff.diff);
        truncated = diff.truncated;
      } catch {
        // status 可用但 diff 失败：文件列表仍然展示，详情逐个兜底
      }
      setState({ phase: "ready", entries, files, truncated });
    } catch (err) {
      if (err instanceof ApiError && err.code === "not_a_git_repo") {
        setState({ phase: "notGit" });
      } else {
        setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }, [project]);

  useEffect(() => {
    setSelected(null);
    void load();
  }, [load, reloadSeq]);

  const selectedEntry = state.phase === "ready" && selected ? state.entries.find((e) => e.path === selected) ?? null : null;
  const selectedFile = state.phase === "ready" && selected ? matchDiffFile(state.files, selected) : null;

  const ready = state.phase === "ready";

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changes-view">
      {/* 工具条：计数 + 截断提示 + unified/split 切换 + 刷新 */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="text-sm font-medium">未提交变更</span>
        {ready && <span className="text-xs text-muted-foreground">{state.entries.length} 个文件</span>}
        {ready && state.truncated && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
            diff 过大已截断
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {ready && selected && (
            <div
              role="group"
              aria-label="diff 视图方向"
              className="flex items-center rounded-lg border p-0.5"
            >
              {(["unified", "split"] as const).map((vt) => (
                <button
                  key={vt}
                  type="button"
                  aria-pressed={viewType === vt}
                  onClick={() => setViewType(vt)}
                  className={`min-h-7 rounded-md px-2 text-xs transition-colors ${
                    viewType === vt ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  {vt === "unified" ? "单栏" : "双栏"}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            aria-label="刷新变更"
            onClick={() => setReloadSeq((n) => n + 1)}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      </div>

      {!project ? (
        <CenteredHint text="请先添加项目" />
      ) : state.phase === "loading" ? (
        <CenteredHint text="加载变更…" />
      ) : state.phase === "error" ? (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <p className="text-sm text-muted-foreground">变更加载失败：{state.message}</p>
          <button
            type="button"
            onClick={() => setReloadSeq((n) => n + 1)}
            className="rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            重试
          </button>
        </div>
      ) : state.phase === "notGit" ? (
        <EmptyState
          icon={<FolderGit2 className="size-10 text-muted-foreground/40" />}
          title="无 Git 仓库"
          hint="当前项目目录不是 git 仓库，没有变更可查看"
        />
      ) : state.entries.length === 0 ? (
        <EmptyState
          icon={<CircleCheck className="size-10 text-muted-foreground/40" />}
          title="工作区干净"
          hint="没有未提交的变更"
        />
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
          {/* 文件列表：手机端未选中文件时独占；lg 以上常驻左栏 */}
          <aside
            className={`min-h-0 overflow-y-auto py-1 lg:block lg:border-r ${selected ? "hidden" : ""}`}
            data-testid="changes-file-list"
          >
            {state.entries.map((entry) => {
              const info = statusInfo(entry.status);
              return (
                <button
                  key={`${entry.status}:${entry.path}`}
                  type="button"
                  onClick={() => setSelected(entry.path)}
                  aria-current={selected === entry.path || undefined}
                  className={`flex min-h-11 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-muted/40 ${
                    selected === entry.path ? "bg-muted/60" : ""
                  }`}
                >
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${TONE_CLASS[info.tone]}`}
                    title={info.label}
                  >
                    {info.code}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.path}</span>
                </button>
              );
            })}
          </aside>

          {/* 详情：手机端选中后独占（返回按钮回列表）；lg 以上常驻右栏 */}
          <section
            className={`min-h-0 overflow-y-auto ${selected ? "" : "hidden lg:block"}`}
            data-testid="changes-file-detail"
          >
            {!selected ? (
              <CenteredHint text="从左侧选择文件查看 diff" />
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur">
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    aria-label="返回文件列表"
                    className="flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground lg:hidden"
                  >
                    <ArrowLeft className="size-3.5" />
                    返回
                  </button>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{selected}</span>
                  {selectedEntry && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">{statusInfo(selectedEntry.status).label}</span>
                  )}
                </div>
                <div className="min-h-0 flex-1 p-3">
                  {selectedFile ? (
                    <FileDiff file={selectedFile} viewType={viewType} />
                  ) : (
                    <div className="diff-empty" data-testid="diff-empty">
                      {selectedEntry ? fileMissingNote(selectedEntry) : "该文件暂无 diff 内容"}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
