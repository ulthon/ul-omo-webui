// omo todo 工具的结构化清单（todo 23）。数据源：toolCall part 关联的 toolRuns 运行态 +
// 同 toolCallId 的 toolResult entry（details.phases 幂等刷新——entry.id upsert 只换对象引用，
// 本组件按消息引用订阅即随事件更新）。status 四态：pending 空框 / in_progress 高亮 / completed
// 勾选 / abandoned 删除线 + 「已放弃」徽标（回合结束未完成项的终态，P0-3 实证）。
// 多 phase 按组渲染；同一会话多轮 todo 的演进按 parts 结构自然形态保留历史卡片——
// 每个工具调用的卡片展示调用时刻的快照，最新一轮卡片即最新态。
// details 缺失/异形（事件源不可用、非 omo todo 语义）→ 降级通用 ToolCard 通路，不隐藏功能。
import { useMessagesStore } from "@/stores/messages";
import {
  CircleCheck,
  CircleSlash,
  ListTodo,
  Loader2,
  Square,
  CircleX,
} from "lucide-react";
import { ToolCard } from "./tool-card";
import { findToolResultMessage, parseTodoSnapshot, type TodoPhase, type TodoStatus } from "./todo-list-data";
import { t } from "@/i18n/i18n";

function TaskStatusIcon({ status }: { status: TodoStatus }) {
  const className = "mt-0.5 size-3.5 shrink-0";
  switch (status) {
    case "completed":
      return <CircleCheck className={`${className} text-muted-foreground`} />;
    case "in_progress":
      return <Loader2 className={`${className} animate-spin text-primary`} />;
    case "abandoned":
      return <CircleSlash className={`${className} text-muted-foreground/60`} />;
    default:
      return <Square className={`${className} text-muted-foreground/40`} />;
  }
}

function TodoTaskRow({ task }: { task: { content: string; status: TodoStatus } }) {
  const { status, content } = task;
  const done = status === "completed" || status === "abandoned";
  return (
    <li
      data-status={status}
      className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${
        status === "in_progress" ? "bg-primary/10 font-medium text-primary" : "text-foreground"
      }`}
    >
      <TaskStatusIcon status={status} />
      <span
        className={`min-w-0 flex-1 break-words leading-relaxed ${done ? "text-muted-foreground line-through decoration-muted-foreground/50" : ""}`}
      >
        {content}
      </span>
      {status === "in_progress" && <span className="shrink-0 text-[11px] text-primary">{t("chat.todo.inProgress")}</span>}
      {status === "abandoned" && (
        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{t("chat.todo.abandoned")}</span>
      )}
    </li>
  );
}

function TodoPhaseGroup({ phase }: { phase: TodoPhase }) {
  return (
    <section>
      <div className="mb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground/80">{phase.name}</div>
      <ul className="space-y-0.5" aria-label={t("chat.todo.groupLabel", { name: phase.name })}>
        {phase.tasks.map((task, i) => (
          <TodoTaskRow key={i} task={task} />
        ))}
      </ul>
    </section>
  );
}

export function TodoList({
  sessionId,
  toolCallId,
  name,
  args,
  live,
}: {
  sessionId: string;
  toolCallId: string;
  name: string;
  args?: unknown;
  live: boolean;
}) {
  const run = useMessagesStore((s) => s.bySession[sessionId]?.toolRuns[toolCallId]);
  const resultMessage = useMessagesStore((s) => {
    const entries = s.bySession[sessionId]?.entries;
    return entries ? findToolResultMessage(entries, toolCallId) : null;
  });

  const phases = parseTodoSnapshot(resultMessage, run?.result);
  // 结构化快照不可得：降级通用工具卡片（运行态/结果文本通路仍可用，事件源不可用不崩）
  if (!phases) {
    return <ToolCard sessionId={sessionId} toolCallId={toolCallId} name={name} args={args} live={live} />;
  }

  const total = phases.reduce((n, p) => n + p.tasks.length, 0);
  const done = phases.reduce((n, p) => n + p.tasks.filter((t) => t.status === "completed").length, 0);
  const isError = resultMessage?.isError === true;
  // 运行态只在"无任何快照来源"时成立；一旦 toolResult/run.result 就绪即落完成态（与 ToolCard 口径一致）
  const running = !isError && resultMessage == null && run?.result == null && (run?.status === "running" || live);

  return (
    <div
      data-tool-call={toolCallId}
      className={`my-1.5 overflow-hidden rounded-lg border text-sm ${
        isError ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/20"
      }`}
    >
      <div className="flex min-h-11 items-center gap-2 px-3 py-2">
        <ListTodo className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-xs font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {t("chat.todo.progress", { done, total })}
        </span>
        <span
          className={`flex shrink-0 items-center gap-1 text-xs ${
            isError ? "text-destructive" : running ? "animate-pulse text-muted-foreground" : "text-muted-foreground"
          }`}
        >
          {running ? (
            <Loader2 className="size-3 shrink-0 animate-spin" />
          ) : isError ? (
            <CircleX className="size-3 shrink-0" />
          ) : (
            <CircleCheck className="size-3 shrink-0" />
          )}
          {running ? t("chat.todo.statusRunning") : isError ? t("chat.todo.statusFailed") : t("chat.todo.statusDone")}
        </span>
      </div>
      <div className="space-y-2.5 border-t px-3 py-2">
        {phases.map((phase, i) => (
          <TodoPhaseGroup key={i} phase={phase} />
        ))}
      </div>
    </div>
  );
}
