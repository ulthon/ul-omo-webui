// 右栏"记忆"页签（docs08-r4 任务 12，只读）：项目记忆库浏览。
// 项目口径（钉死）：选中会话经 byProject 反查所属项目（sessions store 先例，与右栏
// 标题反查同款）；无选中会话回退 ui store currentProject；两者皆无显示空态。
// 跨项目选中（会话项目≠当前项目）天然以会话所属项目为准——头部恒显示当前浏览项目名。
// 数据源 GET /api/memory/facts（服务端只读库文件，绝不写库）；手动刷新钮，不订阅
// 文件变更；库缺失/零条目各有诚实空态（文案按 spike 共库结论：与同目录 CLI 共用）。
// 布局按右栏窄容器（320-560px）自适应：单列分区卡片，月份组默认全展开、条目全文。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { api, type MemoryFactsGroup, type MemoryFactsResponse, type MemorySystemDoc } from "@/lib/api";
import type { SessionListItem } from "@/lib/api";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

/** 路径末段（项目显示名；根路径 "/" 的空末段回退全路径） */
function projectLabel(project: string): string {
  const idx = project.lastIndexOf("/");
  const last = idx >= 0 ? project.slice(idx + 1) : project;
  return last === "" ? project : last;
}

/** 选中会话 → 所属项目反查（byProject 线性扫描；会话列表体量小，无索引必要） */
function projectOfSession(byProject: Record<string, SessionListItem[]>, sessionId: string): string | null {
  for (const [project, list] of Object.entries(byProject)) {
    if (list.some((s) => s.id === sessionId)) return project;
  }
  return null;
}

function PanelMessage({
  title,
  hint,
  testid,
  footer,
}: {
  title: string;
  hint?: string;
  testid?: string;
  footer?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center" data-testid={testid}>
      <p className="text-sm text-muted-foreground">{title}</p>
      {hint ? <p className="text-xs text-muted-foreground/70">{hint}</p> : null}
      {footer ?? null}
    </div>
  );
}

/** 库路径说明行（空态共享：诚实告知分库位置） */
function LibraryHint({ libraryPath }: { libraryPath: string }) {
  return <p className="break-all text-xs tabular-nums text-muted-foreground/70">库路径：{libraryPath}</p>;
}

function FactsGroup({ group }: { group: MemoryFactsGroup }) {
  return (
    <section data-testid="memory-fact-group" className="rounded-lg border p-3">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{group.file}</h3>
      {group.description ? <p className="mb-2 text-xs text-muted-foreground/70">{group.description}</p> : null}
      {group.entries.length > 0 ? (
        <ul className="list-disc space-y-1.5 pl-4">
          {group.entries.map((entry, i) => (
            <li key={i} data-testid="memory-fact-entry" className="whitespace-pre-wrap text-sm">
              {entry}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">（该文件暂无条目）</p>
      )}
    </section>
  );
}

function SystemDoc({ doc }: { doc: MemorySystemDoc }) {
  return (
    <section data-testid="memory-system-doc" className="rounded-lg border p-3">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">system/{doc.file}</h3>
      {doc.body ? (
        <p className="whitespace-pre-wrap text-sm">{doc.body}</p>
      ) : (
        <p className="text-xs text-muted-foreground">（空文件）</p>
      )}
    </section>
  );
}

export function MemoryPanel({ sessionId }: { sessionId: string | null }) {
  const byProject = useSessionsStore((s) => s.byProject);
  const currentProject = useUiStore((s) => s.currentProject);
  // 项目口径：选中会话反查优先，回退 currentProject（两者皆无 → 空态）
  const project = useMemo(() => {
    if (sessionId) {
      const fromSession = projectOfSession(byProject, sessionId);
      if (fromSession) return fromSession;
    }
    return currentProject;
  }, [sessionId, byProject, currentProject]);

  const [data, setData] = useState<MemoryFactsResponse | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // 拉取：项目切换 / 手动刷新 / 页签重挂时生效；不订阅文件变更（手动刷新语义）。
  // 失败按项目记忆（failedFor），加载/陈旧态在渲染层派生（data.project ≠ 当前项目），
  // 不在 effect 内同步 setState（oxlint set-state-in-effect）。
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    api
      .getMemoryFacts(project)
      .then((r) => {
        if (cancelled) return;
        setData(r);
        setFailedFor(null);
      })
      .catch(() => {
        if (!cancelled) setFailedFor(project);
      });
    return () => {
      cancelled = true;
    };
  }, [project, reloadTick]);

  const failed = project !== null && failedFor === project;
  const stale = project === null || data === null || data.project !== project;

  if (!project) return <PanelMessage title="未选择会话" hint="选择会话或项目后浏览其记忆库" />;

  let body: ReactNode;
  if (failed) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <p className="text-sm text-muted-foreground">记忆不可用</p>
        <button
          type="button"
          onClick={() => setReloadTick((t) => t + 1)}
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          重试
        </button>
      </div>
    );
  } else if (stale) {
    body = <div className="flex h-full items-center justify-center text-sm text-muted-foreground">加载记忆…</div>;
  } else if (!data.exists) {
    body = (
      <PanelMessage
        testid="memory-empty-library"
        title="该项目尚无记忆库"
        hint="记忆按项目目录分库，与同目录 CLI 共用；同目录会话产生记忆后自动建库。"
        footer={<LibraryHint libraryPath={data.libraryPath} />}
      />
    );
  } else if (data.facts.length === 0 && data.system.length === 0) {
    body = (
      <PanelMessage
        testid="memory-empty-entries"
        title="该目录暂无记忆条目"
        hint="记忆按项目目录分库，与同目录 CLI 共用。"
        footer={<LibraryHint libraryPath={data.libraryPath} />}
      />
    );
  } else {
    body = (
      <div className="space-y-3">
        {data.facts.map((group) => (
          <FactsGroup key={group.file} group={group} />
        ))}
        {data.system.map((doc) => (
          <SystemDoc key={doc.file} doc={doc} />
        ))}
      </div>
    );
  }

  return (
    <div data-testid="memory-panel" className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <span
          data-testid="memory-panel-project"
          className="min-w-0 truncate text-xs text-muted-foreground"
          title={project}
        >
          浏览项目：{projectLabel(project)}
        </span>
        <button
          type="button"
          data-testid="memory-refresh"
          aria-label="刷新记忆"
          title="刷新记忆"
          onClick={() => setReloadTick((t) => t + 1)}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <RefreshCw className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{body}</div>
    </div>
  );
}
