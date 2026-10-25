// 会话第四态「后台运行中」jsonl 解析（docs08-2026-10-23-24-batch 任务 12，GAP-3）。
// 数据源钉死为会话 jsonl 磁盘文件：spawn 回执（toolResult 消息 details.run_in_background
// === true 且 details.status ∈ {running,pending}）且无同 task_id 的完成通知条目
//（custom_message customType="omo-senpi:wake" 且 content 以 "task completion" 开头）
//即派生 background_running。解析口径与 web/src/components/chat/subagent-data.ts
//（collectSubagentCalls 的 dispatched 判定 + lib/task-completion.ts 的通知解析）保持
//一致——服务端独立实现同口径，不跨包 import web 模块。
//
// 与 web 口径的对齐点：
// - 回执取 message.role==="toolResult" 的 details（web parseFinalSnapshot 读 toolResult
//   消息体 details）；同 toolCallId 多条回执后者覆盖（web toolResults Map 同语义）；
// - 完成通知任意到达即终局化（web 不校验通知 status 词表，覆盖回执启动态）；
// - 启动态判定宁漏勿错：details 缺失 / task_id 缺失 / 字段类型不符一律不计入
//   （web 同款字段级窄化），畸形行（非 JSON / 非 Message entry）静默跳过。
import { existsSync, readFileSync, statSync } from "node:fs";

/** 启动态回执的合法 status 词表（与 web subagent-data dispatched 判定一致） */
const STARTUP_STATUSES = new Set(["running", "pending"]);

function obj(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** 结构化 senpi-task.completion 载荷 → taskId（web task-completion.ts parseStructured
 *  的 task_id 深度 ≤4 走查同构；此处的消费只需 taskId——终局化判定与 status 词表无关） */
function structuredTaskId(raw: unknown): string | undefined {
  let found: Record<string, unknown> | null = null;
  const walk = (node: unknown, depth: number): void => {
    if (found || depth > 4) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const o = obj(node);
    if (!o) return;
    const id = str(o.task_id);
    if (id != null) {
      found = o;
      return;
    }
    if (typeof o.details !== "undefined") walk(o.details, depth + 1);
  };
  walk(raw, 0);
  const hit = found as Record<string, unknown> | null;
  return hit ? str(hit.task_id) : undefined;
}

/** 完成通知条目 → taskId（结构化优先，文本 "id:" 兜底——两形态均 web 同构） */
function completionTaskId(entry: Record<string, unknown>): string | undefined {
  const content = typeof entry.content === "string" ? entry.content : "";
  const structured = structuredTaskId(entry.details);
  if (structured) return structured;
  const m = /\bid:(\S+)/.exec(content);
  return m ? m[1] : undefined;
}

/**
 * 会话 jsonl 文本 → 是否存在未终局的后台任务（纯函数，逐行容错）。
 * 口径：任一 toolResult 回执启动态（run_in_background===true 且 status∈{running,pending}
 * 且 task_id 非空）且无同 task_id 完成通知 → true。同 toolCallId 后到回执覆盖先到
 * （重复回执 / 后到的真终态回执都按最后一条计，duplicated-terminal 对抗类）。
 */
export function hasRunningBackgroundTask(jsonlText: string): boolean {
  // toolCallId → 启动态回执的 taskId（后到覆盖；非启动态回执覆盖即清除）
  const startupByCall = new Map<string, string>();
  const completions = new Set<string>();
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // 垃圾行 / 撕裂尾行：与 web entries 消费同款静默容错
    }
    const e = obj(entry);
    if (!e) continue;
    if (e.customType === "omo-senpi:wake") {
      const content = typeof e.content === "string" ? e.content : "";
      if (!content.startsWith("task completion")) continue;
      const taskId = completionTaskId(e);
      if (taskId) completions.add(taskId);
      continue;
    }
    const msg = obj(e.message);
    if (!msg || msg.role !== "toolResult" || typeof msg.toolCallId !== "string" || msg.toolCallId === "") {
      continue;
    }
    const details = obj(msg.details);
    if (!details) {
      startupByCall.delete(msg.toolCallId);
      continue;
    }
    const bg = details.run_in_background === true;
    const status = str(details.status);
    const taskId = str(details.task_id);
    if (bg && status != null && STARTUP_STATUSES.has(status) && taskId != null) {
      startupByCall.set(msg.toolCallId, taskId);
    } else {
      startupByCall.delete(msg.toolCallId);
    }
  }
  for (const taskId of startupByCall.values()) {
    if (!completions.has(taskId)) return true;
  }
  return false;
}

/** 磁盘缓存项：mtime+size 未变不重读（列表每次刷新都过一遍所有会话行，jsonl 全量
 *  解析代价须摊销；服务重启后缓存为空自然重读——第四态恢复不依赖内存态）。 */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  value: boolean;
}

const cache = new Map<string, CacheEntry>();

/** 单会话 jsonl → 是否后台运行中（文件缺失/读失败/超时外的任何异常 → false，绝不炸列表）。 */
export function sessionBackgroundRunning(sessionPath: string): boolean {
  try {
    if (!existsSync(sessionPath)) return false;
    const st = statSync(sessionPath);
    const hit = cache.get(sessionPath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const value = hasRunningBackgroundTask(readFileSync(sessionPath, "utf8"));
    cache.set(sessionPath, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return false;
  }
}

/** 清空磁盘缓存（服务重启模拟 / 单测隔离用） */
export function clearBackgroundStateCache(): void {
  cache.clear();
}
