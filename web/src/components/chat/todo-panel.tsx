// todo 可折叠右栏内容组件（W5-15）：当前会话最新 todo 快照，桌面常驻 aside 与手机抽屉共用。
// 提取机制（计划 Scope 决策 12 / Oracle 中-3，逐字钉死）：反向扫描 entries 中 assistant
// 消息的 content[] parts → 最后一个 {type:"toolCall", name:"todo"} part 的 id →
// findToolResultMessage（role=toolResult 按 toolCallId 关联；工具名只在 toolCall part 上，
// toolResult 消息本体无 name）→ parseTodoSnapshot。最新一次调用回合中尚未落定（无 toolResult）
// 时向前回退上一轮快照；流式期间 toolCall part 随 assistant 消息定格才入 entries，
// 新快照在回合落定（message_end/turn_end 入列）后自动跟随。
// 纯助手就地导出说明：组件/纯助手分文件是 react-refresh 惯例（todo-list-data 模式），
// 但本任务文件白名单只允许 shell.tsx + todo-panel.tsx + 测试文件，故提取与折叠记忆
// 助手留在本文件，并以文件级 oxlint disable 显式豁免 only-export-components。
// oxlint-disable react/only-export-components
import { useMemo } from "react";
import { CircleCheck, CircleSlash, ListTodo, Loader2, Square, X } from "lucide-react";
import { useMessagesStore } from "@/stores/messages";
import { findToolResultMessage, parseTodoSnapshot, type TodoPhase, type TodoStatus } from "./todo-list-data";
import { useT } from "@/i18n/i18n";

/** 折叠记忆 localStorage 键（"1"=开 / "0"=关；无记录=未交互过，由调用方按视口取默认值） */
const PANEL_PREF_KEY = "ul-omo-webui:todo-panel-open";

/** 折叠记忆读取：无记录或 storage 不可用（隐私模式 / 非浏览器环境）返回 null */
export function readPanelOpenPreference(): boolean | null {
  try {
    const value = window.localStorage.getItem(PANEL_PREF_KEY);
    if (value === "1") return true;
    if (value === "0") return false;
    return null;
  } catch {
    return null;
  }
}

/** 折叠记忆写入：仅在用户交互路径调用；storage 不可用静默降级（页面生命周期内 state 仍生效） */
export function writePanelOpenPreference(open: boolean): void {
  try {
    window.localStorage.setItem(PANEL_PREF_KEY, open ? "1" : "0");
  } catch {
    // storage 不可用：忽略
  }
}

const MESSAGE_ENTRY_TYPES: ReadonlySet<string> = new Set(["message", "message_start", "message_end"]);

/** entries 反向扫描最新可渲染 todo 快照（多轮演进取最后；最新调用未落定时回退上一轮）。
 *  入参形状与 findToolResultMessage 一致（entry 三形态 + message 载荷）。 */
export function extractLatestTodoPhases(entries: { type: string; message?: unknown }[]): TodoPhase[] | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!MESSAGE_ENTRY_TYPES.has(entry.type)) continue;
    const msg = entry.message as { role?: unknown; content?: unknown } | undefined;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const content = msg.content as { type?: unknown; name?: unknown; id?: unknown }[];
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (!part || part.type !== "toolCall" || part.name !== "todo" || typeof part.id !== "string") continue;
      const phases = parseTodoSnapshot(findToolResultMessage(entries, part.id), undefined);
      if (phases) return phases;
    }
  }
  return null;
}

/** 状态图标（与消息流内 todo-list.tsx 同款视觉；该文件为本任务禁改领地，就地实现） */
function PanelStatusIcon({ status }: { status: TodoStatus }) {
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

function PanelPhaseGroup({ phase }: { phase: TodoPhase }) {
  const t = useT();
  return (
    <section>
      <div className="mb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground/80">{phase.name}</div>
      <ul className="space-y-0.5" aria-label={t("chat.todo.groupLabel", { name: phase.name })}>
        {phase.tasks.map((task, i) => {
          const done = task.status === "completed" || task.status === "abandoned";
          return (
            <li
              key={i}
              data-status={task.status}
              className={`flex items-start gap-2 rounded-md px-1 py-1 ${
                task.status === "in_progress" ? "bg-primary/10 font-medium text-primary" : "text-foreground"
              }`}
            >
              <PanelStatusIcon status={task.status} />
              <span
                className={`min-w-0 flex-1 break-words leading-relaxed ${
                  done ? "text-muted-foreground line-through decoration-muted-foreground/50" : ""
                }`}
              >
                {task.content}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PanelEmpty({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <ListTodo className="size-8 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

/** 右栏内容：头（标题 + 进度 x/y + 可选收起钮）+ 清单体（内部滚动）。
 *  onClose 由宿主按形态传：手机抽屉关抽屉、桌面常驻折叠收条；不传则不渲染收起钮。 */
export function TodoPanel({ sessionId, onClose }: { sessionId: string | null; onClose?: () => void }) {
  const entries = useMessagesStore((s) => (sessionId ? s.bySession[sessionId]?.entries : undefined));
  const phases = useMemo(() => (entries ? extractLatestTodoPhases(entries) : null), [entries]);
  const t = useT();
  const total = phases ? phases.reduce((n, p) => n + p.tasks.length, 0) : 0;
  const done = phases ? phases.reduce((n, p) => n + p.tasks.filter((t) => t.status === "completed").length, 0) : 0;

  return (
    <div data-testid="todo-panel" className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b px-3 py-1">
        <ListTodo className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{t("chat.todo.panelTitle")}</span>
        {phases && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t("chat.todo.progress", { done, total })}
          </span>
        )}
        {onClose && (
          <button
            type="button"
            aria-label={t("chat.todo.collapse")}
            data-testid="todo-panel-close"
            title={t("chat.todo.collapse")}
            onClick={onClose}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground lg:size-9"
          >
            <X className="size-4" />
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {phases ? (
          <div className="space-y-3">
            {phases.map((phase, i) => (
              <PanelPhaseGroup key={i} phase={phase} />
            ))}
          </div>
        ) : sessionId == null ? (
          <PanelEmpty text={t("chat.todo.noSession")} />
        ) : (
          <PanelEmpty text={t("chat.todo.empty")} />
        )}
      </div>
    </div>
  );
}
