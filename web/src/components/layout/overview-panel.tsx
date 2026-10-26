// 右栏「总览」页签（r9 w2-t8）：聚合任务 / 笔记 / 统计 / 子代理四块的一屏速览。
// 只读复用各页签既有数据源，不复制数据逻辑：任务走 todo-panel 导出的
// extractLatestTodoPhases（messages store 反向扫描），子代理走 subagent-data 的
// collectSubagentCalls（entries + toolRuns 双路合并），统计走 stat-panel 同款
// GET /api/usage 快照（status-bar-data 容错解析），笔记走 notes-api 列表接口。
// 不修改 todo-panel/notes-view/stat-panel/subagent-panel 本体（零改动复用），
// 不新建后端接口。四块各自限高（max-h-64）内部滚动、独立空态文案（zh/en 词条
// 在 login.rightRail.overview），块间 border-b 分隔。
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { useUiStore } from "@/stores/ui";
import { useT } from "@/i18n/i18n";
import { extractLatestTodoPhases } from "@/components/chat/todo-panel";
import { collectSubagentCalls, summaryOfCall } from "@/components/chat/subagent-data";
import { toUsageStats, type UsageStats } from "@/components/chat/status-bar-data";
import { notesApi, type NoteListItem } from "@/components/notes/notes-api";

const OVERVIEW_SECTION_CLASS = "border-b px-3 py-2.5 last:border-b-0";
const OVERVIEW_TITLE_CLASS = "mb-1.5 text-xs font-medium text-muted-foreground";
// 单块限高内部滚动（任务口径 max-h-64）；块内子项溢出在块内消化，不撑开总览整页
const OVERVIEW_BODY_CLASS = "max-h-64 overflow-y-auto";

/** 通用空态行：与 stat-panel 的 loading 行同视觉档（text-xs text-muted-foreground） */
function OverviewEmpty({ text }: { text: string }) {
  return <p className="text-xs text-muted-foreground">{text}</p>;
}

// —— 任务块：todo-panel 同源（extractLatestTodoPhases），分组标题 + 任务行 ——
function OverviewTasks({ sessionId }: { sessionId: string | null }) {
  const t = useT();
  const entries = useMessagesStore((s) => (sessionId ? s.bySession[sessionId]?.entries : undefined));
  const phases = useMemo(() => (entries ? extractLatestTodoPhases(entries) : null), [entries]);
  return (
    <section data-testid="overview-tasks" className={OVERVIEW_SECTION_CLASS}>
      <h3 className={OVERVIEW_TITLE_CLASS}>{t("login.rightRail.overview.tasksTitle")}</h3>
      <div className={OVERVIEW_BODY_CLASS}>
        {phases ? (
          <div className="space-y-1.5">
            {phases.map((phase, i) => (
              <div key={i}>
                <div className="text-[11px] font-medium tracking-wide text-muted-foreground/80">{phase.name}</div>
                <ul>
                  {phase.tasks.map((task, j) => {
                    const done = task.status === "completed" || task.status === "abandoned";
                    return (
                      <li
                        key={j}
                        className={`truncate text-sm leading-relaxed ${
                          task.status === "in_progress" ? "font-medium text-primary" : done ? "text-muted-foreground line-through" : "text-foreground"
                        }`}
                      >
                        {task.content}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <OverviewEmpty text={sessionId == null ? t("login.rightRail.overview.tasksNoSession") : t("login.rightRail.overview.tasksEmpty")} />
        )}
      </div>
    </section>
  );
}

// —— 笔记块：notes-api 列表摘要（计数 + 前 5 条标题），项目维度与会话无关 ——
function OverviewNotes() {
  const t = useT();
  const project = useUiStore((s) => s.currentProject);
  const [notes, setNotes] = useState<NoteListItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!project) return;
    let stale = false;
    notesApi
      .list(project)
      .then((r) => {
        if (!stale) setNotes(r.notes);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [project]);

  return (
    <section data-testid="overview-notes" className={OVERVIEW_SECTION_CLASS}>
      <h3 className={OVERVIEW_TITLE_CLASS}>{t("login.rightRail.overview.notesTitle")}</h3>
      <div className={OVERVIEW_BODY_CLASS}>
        {!project || failed || notes === null ? (
          <OverviewEmpty
            text={
              !project
                ? t("login.rightRail.overview.notesNoProject")
                : failed || notes === null
                  ? t("login.rightRail.overview.notesEmpty")
                  : ""
            }
          />
        ) : notes.length === 0 ? (
          <OverviewEmpty text={t("login.rightRail.overview.notesEmpty")} />
        ) : (
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">{t("login.rightRail.overview.notesCount", { n: notes.length })}</p>
            <ul>
              {notes.slice(0, 5).map((note) => (
                <li key={note.id} className="truncate text-sm leading-relaxed text-foreground">
                  {note.title}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

// —— 统计块：GET /api/usage 快照摘要（总 tokens / 上下文水位 / 累计成本） ——
function OverviewStats({ sessionId }: { sessionId: string | null }) {
  const t = useT();
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    api
      .getUsage(sessionId)
      .then((r) => {
        if (cancelled) return;
        setStats(toUsageStats(r.usage));
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <section data-testid="overview-stats" className={OVERVIEW_SECTION_CLASS}>
      <h3 className={OVERVIEW_TITLE_CLASS}>{t("login.rightRail.overview.statsTitle")}</h3>
      <div className={OVERVIEW_BODY_CLASS}>
        {sessionId == null || failed || !stats || !stats.tokens ? (
          <OverviewEmpty
            text={
              sessionId == null
                ? t("login.rightRail.overview.statsNoSession")
                : failed || !stats
                  ? t("login.rightRail.overview.statsUnavailable")
                  : t("login.rightRail.overview.statsEmpty")
            }
          />
        ) : (
          <ul className="space-y-0.5 text-sm">
            <li data-testid="overview-stats-tokens" className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground">{t("login.rightRail.overview.statsTokens")}</span>
              <span className="tabular-nums">{stats.tokens.total.toLocaleString()}</span>
            </li>
            <li data-testid="overview-stats-context" className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground">{t("login.rightRail.overview.statsContext")}</span>
              <span className="tabular-nums">
                {stats.context ? `${Math.round(stats.context.percent)}%` : "—"}
              </span>
            </li>
            <li data-testid="overview-stats-cost" className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground">{t("login.rightRail.overview.statsCost")}</span>
              <span className="tabular-nums">${stats.cost.toFixed(4)}</span>
            </li>
          </ul>
        )}
      </div>
    </section>
  );
}

// —— 子代理块：subagent-data 双路聚合，状态 + 摘要一行（最新在前） ——
function OverviewAgents({ sessionId }: { sessionId: string | null }) {
  const t = useT();
  const entries = useMessagesStore((s) => (sessionId ? s.bySession[sessionId]?.entries : undefined));
  const toolRuns = useMessagesStore((s) => (sessionId ? s.bySession[sessionId]?.toolRuns : undefined));
  const calls = useMemo(
    () => (sessionId ? collectSubagentCalls(entries ?? [], toolRuns ?? {}) : []),
    [sessionId, entries, toolRuns],
  );

  return (
    <section data-testid="overview-agents" className={OVERVIEW_SECTION_CLASS}>
      <h3 className={OVERVIEW_TITLE_CLASS}>{t("login.rightRail.overview.agentsTitle")}</h3>
      <div className={OVERVIEW_BODY_CLASS}>
        {sessionId == null || calls.length === 0 ? (
          <OverviewEmpty
            text={
              sessionId == null
                ? t("login.rightRail.overview.agentsNoSession")
                : t("login.rightRail.overview.agentsEmpty")
            }
          />
        ) : (
          <ul>
            {[...calls].reverse().map((call) => (
              <li key={call.toolCallId} data-testid="overview-agent-item" className="flex min-w-0 items-baseline gap-2 text-sm leading-relaxed">
                <span
                  className={`shrink-0 text-xs ${call.running || call.dispatched ? "font-medium text-primary" : "text-muted-foreground"}`}
                >
                  {call.running
                    ? t("chat.subagentPanel.statusRunning")
                    : call.dispatched
                      ? t("chat.subagentPanel.statusDispatched")
                      : t("chat.subagentPanel.statusDone")}
                </span>
                <span className="min-w-0 truncate text-foreground" title={summaryOfCall(call).primary}>
                  {summaryOfCall(call).primary || call.toolCallId}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** 总览面板：四块纵排，块间分隔线；整页不滚动（各块内部滚动），外层 p-0 贴齐页签体系 */
export function OverviewPanel({ sessionId }: { sessionId: string | null }) {
  return (
    <div data-testid="overview-panel" className="h-full overflow-y-auto">
      <OverviewTasks sessionId={sessionId} />
      <OverviewNotes />
      <OverviewStats sessionId={sessionId} />
      <OverviewAgents sessionId={sessionId} />
    </div>
  );
}
