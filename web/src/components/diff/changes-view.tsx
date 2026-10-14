// "未提交变更"页签（todo 19；C15-b 右栏窄栏适配）：git status 文件列表 + 按文件折叠展开 diff（只读）。
// 数据：GET /api/git/status（porcelain 列表）+ GET /api/git/diff（全量工作区 diff，
// 服务端无按文件参数——前端 parseGitDiff 切分后按展开路径取单文件）。
// 布局：右栏 320-560（默认 384）窄容器单列折叠列表——每行一枚文件，点击就地展开/收起该文件
// hunk（各行展开态独立，可多文件同时展开对照）；手机抽屉与桌面右栏共用同一形态。
// 长代码行：diff 表格在展开区作用域内改为块级 + overflow-x-auto，代码行 white-space:pre
// 不换行不截断、超出宽度横向滚动（覆写规则在 diff.css 的 .changes-detail 作用域——
// Tailwind utilities 位于 @layer 内压不过未分层的 react-diff-view 官方样式表）。
// 双栏 diff 在 384 级宽度不可读，右栏版固定 unified 单栏（FileDiff 接口不变）。
// 边界：untracked 文件与纯暂存改动不出现在 git diff 中，展开给说明性空态；
// 非 git 目录（409 not_a_git_repo）显示"无 Git 仓库"空态不报错；工作区干净显示空态。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronRight, CircleCheck, FolderGit2, RefreshCw } from "lucide-react";
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

/** 展开行在 diff 切分结果中缺席时的说明（untracked / 纯暂存） */
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

/** 单文件折叠行：展开态独立持有（key 随项目容器重挂自然复位），点击就地展开/收起 hunk */
function ChangeRow({ entry, file }: { entry: ChangeEntry; file: FileData | null }) {
  const [open, setOpen] = useState(false);
  const info = statusInfo(entry.status);
  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="changes-file-row"
        className="flex min-h-11 w-full items-center gap-1.5 px-3 text-left transition-colors hover:bg-muted/40"
      >
        <ChevronRight
          aria-hidden
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${TONE_CLASS[info.tone]}`}
          title={info.label}
        >
          {info.code}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={entry.path}>
          {entry.path}
        </span>
      </button>
      {open && (
        <div
          data-testid="changes-file-detail"
          className="changes-detail border-t bg-muted/20 px-2.5 py-2"
        >
          {file ? (
            <FileDiff file={file} viewType="unified" />
          ) : (
            <div className="diff-empty" data-testid="diff-empty">
              {fileMissingNote(entry)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ChangesView() {
  const project = useUiStore((s) => s.currentProject);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
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
    void load();
  }, [load, reloadSeq]);

  const ready = state.phase === "ready";

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changes-view">
      {/* 工具条：标题 + 计数 + 截断提示 + 刷新（320-560 全档单行放得下；计数可截断保刷新钮不挤出去） */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="shrink-0 text-sm font-medium">未提交变更</span>
        {ready && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{state.entries.length} 个文件</span>
        )}
        {ready && state.truncated && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
            diff 过大已截断
          </span>
        )}
        <button
          type="button"
          aria-label="刷新变更"
          onClick={() => setReloadSeq((n) => n + 1)}
          className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </button>
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
        // key 随项目重挂：切换项目后各行展开态整体复位，不残留上一项目的展开键
        <div key={project} className="min-h-0 flex-1 overflow-y-auto" data-testid="changes-file-list">
          {state.entries.map((entry) => (
            <ChangeRow
              key={`${entry.status}:${entry.path}`}
              entry={entry}
              file={matchDiffFile(state.files, entry.path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
