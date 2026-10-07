// todo 渲染数据助手（todo 23）：从 toolResult 消息的 details.phases 提取结构化清单快照。
// 数据源契约（P0-3 实证，docs/verification/03）：toolResult.details 才是结构化源，
// content[0].text 是给模型的文本视图；widget 通道在 RPC 丢 component factory，不作数据源。
// status 四态：pending / in_progress / completed / abandoned（回合结束未完成项的终态）。
// 独立成文件是为 react-refresh 约束（组件文件只导出组件）；findToolResultMessage 与
// tool-card.tsx 内部逻辑一致（该文件为 todo 17 领地只读，不导入其私有函数）。
import type { WireMessage } from "@/lib/api";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoTask {
  content: string;
  status: TodoStatus;
}

export interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "abandoned"]);

/** 未知/缺失状态归 pending（渲染层不为异形数据崩） */
function normalizeStatus(value: unknown): TodoStatus {
  return typeof value === "string" && KNOWN_STATUSES.has(value) ? (value as TodoStatus) : "pending";
}

/** phases 原始数据 → 规范化列表；无任何可渲染任务时返回 null（调用方降级） */
function parsePhases(raw: unknown): TodoPhase[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const phases: TodoPhase[] = [];
  for (const phase of raw) {
    if (phase == null || typeof phase !== "object") return null;
    const record = phase as Record<string, unknown>;
    const name = typeof record.name === "string" && record.name ? record.name : "清单";
    const tasks: TodoTask[] = [];
    if (Array.isArray(record.tasks)) {
      for (const task of record.tasks) {
        if (task == null || typeof task !== "object") continue;
        const taskRecord = task as Record<string, unknown>;
        const content = typeof taskRecord.content === "string" ? taskRecord.content : "";
        if (!content) continue;
        tasks.push({ content, status: normalizeStatus(taskRecord.status) });
      }
    }
    phases.push({ name, tasks });
  }
  if (!phases.some((p) => p.tasks.length > 0)) return null;
  return phases;
}

function phasesFromDetails(details: unknown): TodoPhase[] | null {
  if (details == null || typeof details !== "object") return null;
  return parsePhases((details as Record<string, unknown>).phases);
}

/** todo 快照提取：toolResult 消息 details 优先，tool_execution_end 的 run.result 兜底（同构 {details:{phases}}）；
 *  结构不完整返回 null——调用方降级通用 ToolCard 通路（todo 事件源不可用时其余功能不受影响） */
export function parseTodoSnapshot(message: WireMessage | null, runResult: unknown): TodoPhase[] | null {
  if (message) {
    const phases = phasesFromDetails((message as Record<string, unknown>).details);
    if (phases) return phases;
  }
  if (runResult != null && typeof runResult === "object") {
    const container = runResult as Record<string, unknown>;
    const phases = phasesFromDetails(container.details !== undefined ? container.details : container);
    if (phases) return phases;
  }
  return null;
}

/** entries 中按 toolCallId 反向找配对的 toolResult 消息（引用稳定：命中返回消息对象本身）。
 *  entry.type 双形态：GET messages 定格条目 "message"，SSE 实时入列 wire 原样 "message_start"/"message_end"。 */
export function findToolResultMessage(
  entries: { type: string; message?: unknown }[],
  toolCallId: string,
): WireMessage | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" && entry.type !== "message_start" && entry.type !== "message_end") continue;
    const msg = entry.message as WireMessage | undefined;
    if (msg && msg.role === "toolResult" && msg.toolCallId === toolCallId) return msg;
  }
  return null;
}
