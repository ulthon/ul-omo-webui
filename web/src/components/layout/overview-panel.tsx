// 右栏「总览」页签（r9 w2-t8）：聚合计划 / 引擎 / 任务 / 笔记 / 统计 / 子代理六块的一屏速览。
// 计划/任务/统计/子代理只读复用各页签既有数据源，不复制数据逻辑：计划走 GET /api/sessions/:id/plan-progress
//（r10 todo 12，会话绑定 goal 的计划勾选态，无绑定整块隐藏），引擎走 GET /api/engines/metrics
//（engine-ux-visibility 任务 3，当前会话绑定引擎状态速览+停止，overview-engine.tsx），任务走 todo-panel 导出的
// extractLatestTodoPhases（messages store 反向扫描），子代理走 subagent-data 的
// collectSubagentCalls（entries + toolRuns 双路合并），统计走 stat-panel 同款
// GET /api/usage 快照（status-bar-data 容错解析），笔记走 notes-api。
// 不新建后端接口。笔记块（r11 直接编辑改造）复用笔记 tab 同款 NoteInlineEditor：
// 条目点击就地展开编辑器，收起/点外部自动保存；其余四块各自限高（max-h-64）内部滚动、
// 独立空态文案（zh/en 词条在 login.rightRail.overview），块间 border-b 分隔。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { useTasksStore, type BackgroundTask } from "@/stores/tasks";
import { MAX_OVERVIEW_NOTES_COUNT, OVERVIEW_NOTES_COUNT_KV, useUiStore } from "@/stores/ui";
import { useActiveProject } from "@/stores/sessions";
import { useT } from "@/i18n/i18n";
import { extractLatestTodoPhases } from "@/components/chat/todo-panel";
import { collectSubagentCalls, summaryOfCall } from "@/components/chat/subagent-data";
import { toUsageStats, type UsageStats } from "@/components/chat/status-bar-data";
import { notesApi, type NoteListItem } from "@/components/notes/notes-api";
import { NoteInlineEditor } from "@/components/notes/note-inline-editor";
import { NoteFlatCard } from "@/components/notes/note-flat-card";
import { OverviewPlan } from "@/components/layout/overview-plan";
import { OverviewEngine } from "@/components/layout/overview-engine";
import { EngineDiagnosticsFold } from "@/components/engines/engine-diagnostics-fold";

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

// —— 后台任务块：omo.task.updated 全量快照（tasks store，与活动条同源），进行中/已完成
//    分组全量展示；状态文案复用 chat.activity 词条，时间取 wire updated_at（本地时分） ——
/** 行尾时间列：ISO 串转本地 HH:mm，缺席/畸形落 "—"（不引入日期依赖） */
function formatBgTaskTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function BgTaskRow({ task }: { task: BackgroundTask }) {
  const t = useT();
  const running = task.status === "running";
  return (
    <li
      data-testid="overview-bg-task"
      className="flex min-w-0 items-baseline gap-2 text-sm leading-relaxed"
    >
      <span
        className={`shrink-0 text-xs ${running ? "font-medium text-primary" : "text-muted-foreground"}`}
      >
        {running ? t("chat.activity.statusRunning") : t("chat.activity.statusDone")}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground" title={task.label}>
        {task.label}
      </span>
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
        {formatBgTaskTime(task.updatedAt)}
      </span>
    </li>
  );
}

function OverviewBackgroundTasks({ sessionId }: { sessionId: string | null }) {
  const t = useT();
  const tasks = useTasksStore((s) => (sessionId ? s.bySession[sessionId] : undefined));
  const list = tasks ?? [];
  const runningList = list.filter((task) => task.status === "running");
  const doneList = list.filter((task) => task.status !== "running");
  return (
    <section data-testid="overview-bg-tasks" className={OVERVIEW_SECTION_CLASS}>
      <h3 className={OVERVIEW_TITLE_CLASS}>{t("login.rightRail.overview.bgTasksTitle")}</h3>
      <div className={OVERVIEW_BODY_CLASS}>
        {list.length === 0 ? (
          <OverviewEmpty text={sessionId == null ? t("login.rightRail.overview.bgTasksNoSession") : t("login.rightRail.overview.bgTasksEmpty")} />
        ) : (
          <div className="space-y-1.5">
            {runningList.length > 0 && (
              <div>
                <div className="text-[11px] font-medium tracking-wide text-muted-foreground/80">
                  {t("login.rightRail.overview.bgTasksRunning", { n: runningList.length })}
                </div>
                <ul>
                  {runningList.map((task) => (
                    <BgTaskRow key={task.id} task={task} />
                  ))}
                </ul>
              </div>
            )}
            {doneList.length > 0 && (
              <div>
                <div className="text-[11px] font-medium tracking-wide text-muted-foreground/80">
                  {t("login.rightRail.overview.bgTasksDone", { n: doneList.length })}
                </div>
                <ul>
                  {doneList.map((task) => (
                    <BgTaskRow key={task.id} task={task} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// —— 笔记块：notes-api 列表 + 条目点击就地直接编辑（r11 复用笔记 tab 同款
// NoteInlineEditor，含 composition 安全保存），项目源为选中会话派生（W1 t3）——
function OverviewNotes() {
  const t = useT();
  // 未选中会话时派生为 null，块内展示「请先添加项目」空态（过渡期语义不变）
  const project = useActiveProject();
  const [notes, setNotes] = useState<NoteListItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  // 就地展开的条目 id；保存/取消后收起并重取列表。dirtyRef 仅满足编辑器契约
  //（总览块不参与右栏切页签确认，切走时编辑器卸载、点外部收起已先触发保存）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const dirtyRef = useRef(false);
  // 显示条数（2026-11-07 平铺直编批）：kv ui.overviewNotesCount 全局持久，块内步进器就地调节
  const count = useUiStore((s) => s.overviewNotesCount);
  const setOverviewNotesCount = useUiStore((s) => s.setOverviewNotesCount);
  const showToast = useUiStore((s) => s.showToast);
  const pushGlobalError = useUiStore((s) => s.pushGlobalError);
  const changeCount = (dir: 1 | -1) => {
    const next = Math.min(Math.max(count + dir, 1), MAX_OVERVIEW_NOTES_COUNT);
    if (next === count) return;
    setOverviewNotesCount(next);
    api
      .putSettings({ [OVERVIEW_NOTES_COUNT_KV]: String(next) })
      .catch(() => pushGlobalError(t("login.rightRail.overview.notesCountSaveFailed")));
  };

  useEffect(() => {
    if (!project) return;
    let stale = false;
    notesApi
      .list(project)
      .then((r) => {
        if (!stale) {
          setNotes(r.notes);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [project, reloadSeq]);

  const onChanged = useCallback(() => setReloadSeq((n) => n + 1), []);

  return (
    <section data-testid="overview-notes" className={OVERVIEW_SECTION_CLASS}>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className={OVERVIEW_TITLE_CLASS}>{t("login.rightRail.overview.notesTitle")}</h3>
        <span className="flex items-center gap-0.5">
          {/* #32：新增入口（照搬右栏 draft 顶插空行编辑器）；软删可恢复放回收站 */}
          <button
            type="button"
            onClick={() => setEditingId("draft")}
            disabled={!project || failed || notes === null || editingId !== null}
            aria-label={t("login.rightRail.overview.notesAddAria")}
            title={t("login.rightRail.overview.notesAddTitle")}
            data-testid="overview-notes-add"
            className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
          >
            <Plus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => changeCount(-1)}
            disabled={count <= 1}
            aria-label={t("login.rightRail.overview.notesCountDec")}
            data-testid="overview-notes-count-dec"
            className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
          >
            <Minus className="size-3.5" />
          </button>
          <span className="min-w-4 text-center text-xs tabular-nums text-muted-foreground" data-testid="overview-notes-count">
            {count}
          </span>
          <button
            type="button"
            onClick={() => changeCount(1)}
            disabled={count >= MAX_OVERVIEW_NOTES_COUNT}
            aria-label={t("login.rightRail.overview.notesCountInc")}
            data-testid="overview-notes-count-inc"
            className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
          >
            <Plus className="size-3.5" />
          </button>
        </span>
      </div>
      <div>
        {/* #32：去单块限高（不限高不内部滚动，随面板整页滚动） */}
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
            <p className="text-xs text-muted-foreground">
              {t("login.rightRail.overview.notesCount", { n: notes.length })}
              <span className="mx-1">·</span>
              {t("login.rightRail.overview.notesEditHint")}
            </p>
            {editingId === "draft" && (
              <NoteInlineEditor
                noteId={null}
                project={project}
                dirtyRef={dirtyRef}
                onSaved={() => {
                  setEditingId(null);
                  onChanged();
                }}
                onCancel={() => setEditingId(null)}
                onDeleted={() => {
                  setEditingId(null);
                  onChanged();
                }}
              />
            )}
            <ul className="space-y-1.5">
              {notes.slice(0, count).map((note) =>
                editingId === note.id ? (
                  <li key={note.id}>
                    <NoteInlineEditor
                      noteId={note.id}
                      project={project}
                      dirtyRef={dirtyRef}
                      initial={{
                        id: note.id,
                        project,
                        title: note.title,
                        content: note.content,
                        tags: note.tags,
                        deletedAt: note.deletedAt,
                        createdAt: null,
                        updatedAt: note.updatedAt,
                      }}
                      onSaved={() => {
                        setEditingId(null);
                        onChanged();
                      }}
                      onCancel={() => setEditingId(null)}
                      onDeleted={() => {
                        setEditingId(null);
                        onChanged();
                      }}
                    />
                  </li>
                ) : (
                  <li key={note.id}>
                    <NoteFlatCard
                      note={note}
                      testid="overview-note-item"
                      onClick={() => setEditingId(note.id)}
                      footerExtra={
                        <button
                          type="button"
                          aria-label={t("login.rightRail.overview.notesDeleteAria")}
                          title={t("login.rightRail.overview.notesDeleteAria")}
                          data-testid={`overview-note-delete-${note.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void notesApi
                              .remove(note.id)
                              .then(() => onChanged())
                              .catch((err: unknown) =>
                                showToast(
                                  err instanceof Error && err.message ? err.message : t("login.rightRail.overview.notesDeleteFailed"),
                                  "error",
                                ),
                              );
                          }}
                          className="flex size-6 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      }
                    />
                  </li>
                ),
              )}
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
  // 专属提示词提示行（2026-11-03 用户定版：从 composer 迁来）——当前选中模型命中
  // prompt-preset 时显示，未命中不占行
  const models = useUiStore((s) => s.models);
  const promptPresets = useUiStore((s) => s.promptPresets);
  const selectedModel = useUiStore((s) => s.selectedModel);
  const fullModel = selectedModel ?? (models.length > 0 ? `${models[0]!.provider}/${models[0]!.id}` : null);
  const preset = fullModel !== null ? (promptPresets[fullModel] ?? null) : null;

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
            {preset !== null && (
              <li data-testid="overview-preset" className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground">{t("login.rightRail.overview.promptPreset")}</span>
                <span className="truncate">{preset}</span>
              </li>
            )}
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

/** 总览面板：计划（r10 todo 12，无绑定 goal 整块隐藏）+ 引擎/任务/后台任务/笔记/统计/子代理纵排，
 *  块间分隔线；整页不滚动（各块内部滚动），外层 p-0 贴齐页签体系 */
export function OverviewPanel({ sessionId }: { sessionId: string | null }) {
  return (
    <div data-testid="overview-panel" className="h-full overflow-y-auto">
      <OverviewPlan sessionId={sessionId} />
      <OverviewTasks sessionId={sessionId} />
      <OverviewBackgroundTasks sessionId={sessionId} />
      <OverviewNotes />
      <OverviewStats sessionId={sessionId} />
      <OverviewAgents sessionId={sessionId} />
      {/* #30：引擎状态/引擎诊断两块下移至面板尾部（用户定调不置顶；业务区块在前） */}
      <OverviewEngine sessionId={sessionId} />
      <EngineDiagnosticsFold />
    </div>
  );
}
