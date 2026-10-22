// 子代理后台完成通知帧解析（docs08-2026-10-22 批次任务 26，GAP-16）。
// 引擎后台 task 完成时经父会话 entry_appended 携 customType "omo-senpi:wake" 的
// task completion 条目到达（JSONL 顶层 {type:"custom_message", id, customType, content,
// display, details}，历史 GET messages 同形同构——2026-10-22 全库 234 条实录 + 隔离实例
// 真实后台子代理全链路实录，见 .omo/evidence/docs08-2026-10-22-batch/task-26/spike.md）。
// 两层形态（spike 定案，结构化优先、文本兜底）：
//   1. 结构化（隔离实例实测）：details 为数组，元素 customType "senpi-task.completion"，
//      其 details[0] 含 task_id/status/category/model/duration_ms/run_stats(全键结构化，
//      同 end 帧 run_stats 形态)/final_response/continuation_hint；
//   2. 文本兜底（历史会话库 2026-10-17 形态）：content 文本
//      "task completion name:st_x id:st_x agent:... status:completed duration:3m 52s
//       tokens:447558 tools:43 tps:90\nresult:\"...\"[\nnext:...]"——无结构化 details。
// 本模块为纯函数；messages store（entry_appended 放行门）与 subagent-data（消费聚合）
// 共用同一判定，单一真相源。

/** 完成通知解析结果（全部字段条件出现，尽力而为语义） */
export interface TaskCompletion {
  /** 引擎任务 id（结构化 task_id / 文本 "id:" 键；与 spawn 回执 details.task_id 同空间） */
  taskId: string;
  /** 引擎终态值（实录 "completed" / "error"；未知值原样透传，消费侧按词表映射） */
  status: string;
  /** 结构化 duration_ms / run_stats.runtime_ms / 文本 duration 折算（毫秒） */
  runtimeMs?: number;
  totalTokens?: number;
  outputTokens?: number;
  inputTokens?: number;
  toolCalls?: number;
  turns?: number;
  tokensPerSecond?: number;
  costUsd?: number;
  /** 结构化 resolved_model.display */
  modelDisplay?: string;
  /** 结构化 final_response / 文本 result:"..."（不含 next: 续接段） */
  responseText?: string;
}

/** duration 文本 → 毫秒（"3m 52s"→232000、"14.92s"→14920；无法解析 → undefined） */
export function parseDurationMs(text: string): number | undefined {
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = Number(m[1]);
    if (!Number.isFinite(v)) continue;
    matched = true;
    total += m[2] === "ms" ? v : m[2] === "s" ? v * 1000 : m[2] === "m" ? v * 60_000 : v * 3_600_000;
  }
  return matched ? Math.round(total) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** 结构化 senpi-task.completion 载荷 → TaskCompletion（details 数组两层嵌套实测形态） */
function parseStructured(raw: unknown): TaskCompletion | null {
  if (raw == null || typeof raw !== "object") return null;
  const arr = Array.isArray(raw) ? raw : [raw];
  let found: Record<string, unknown> | null = null;
  const walk = (node: unknown, depth: number): void => {
    if (found || depth > 4) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (node != null && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (str(o.task_id) != null) {
        found = o;
        return;
      }
      if (typeof o.details !== "undefined") walk(o.details, depth + 1);
    }
  };
  walk(arr, 0);
  if (!found) return null;
  const f = found as Record<string, unknown>;
  const taskId = str(f.task_id);
  const status = str(f.status);
  if (!taskId || !status) return null;
  const rs = f.run_stats != null && typeof f.run_stats === "object" ? (f.run_stats as Record<string, unknown>) : null;
  const rm = f.resolved_model != null && typeof f.resolved_model === "object" ? (f.resolved_model as Record<string, unknown>) : null;
  return {
    taskId,
    status,
    runtimeMs: num(f.duration_ms) ?? (rs ? num(rs.runtime_ms) : undefined),
    totalTokens: rs ? num(rs.total_tokens) : num(f.tokens),
    outputTokens: rs ? num(rs.output_tokens) : undefined,
    inputTokens: rs ? num(rs.input_tokens) : undefined,
    toolCalls: rs ? num(rs.tool_calls) : undefined,
    turns: rs ? num(rs.turns) : undefined,
    tokensPerSecond: rs ? num(rs.tokens_per_second) : undefined,
    costUsd: rs ? num(rs.cost_usd) : undefined,
    modelDisplay: rm ? str(rm.display) : undefined,
    responseText: str(f.final_response),
  };
}

/** 文本形态 result:"..." 提取：截到串尾或下一个 "\n键:" 段（next: 续接提示不混入） */
function resultTextOf(content: string): string | undefined {
  const idx = content.indexOf('\nresult:"');
  if (idx === -1) return undefined;
  const rest = content.slice(idx + '\nresult:"'.length);
  const end = /"\s*$|"\n[a-z][\w.-]*:/.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

/** 判定 + 解析：非 omo-senpi:wake 载荷、非 "task completion" 前缀（ulw 续跑引导等
 *  同通道噪音）或缺 id/status 一律 null——放行门与消费侧共用，宁漏勿错。 */
export function parseTaskCompletionEntry(entry: unknown): TaskCompletion | null {
  if (entry == null || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (e.customType !== "omo-senpi:wake") return null;
  const content = typeof e.content === "string" ? e.content : "";
  if (!content.startsWith("task completion")) return null;
  // 结构化优先（2026-10-22 隔离实例实录形态）
  const structured = parseStructured(e.details);
  if (structured) return structured;
  // 文本兜底（历史会话库实录形态）
  const id = /\bid:(\S+)/.exec(content);
  const status = /\bstatus:(\S+)/.exec(content);
  if (!id || !status) return null;
  const tokens = /\btokens:(\d+)/.exec(content);
  const tools = /\btools:(\d+)/.exec(content);
  const tps = /\btps:(\d+(?:\.\d+)?)/.exec(content);
  const duration = /\bduration:(.+?)\s+tokens:|\bduration:(.+?)\s*$/.exec(content);
  return {
    taskId: id[1],
    status: status[1],
    runtimeMs: duration ? parseDurationMs(duration[1] ?? duration[2] ?? "") : undefined,
    totalTokens: tokens ? Number(tokens[1]) : undefined,
    toolCalls: tools ? Number(tools[1]) : undefined,
    tokensPerSecond: tps ? Number(tps[1]) : undefined,
    responseText: resultTextOf(content),
  };
}
