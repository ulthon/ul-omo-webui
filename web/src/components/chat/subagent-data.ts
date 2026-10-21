// 子代理页签数据助手（docs08-r6 任务 17，GAP-8）：右栏「子代理」页签的 task 工具调用
// 聚合卡数据模型。纯函数模块（react-refresh 约束：组件文件只导出组件，tool-card-data 同款）。
// 数据源双路合并（同一 toolCallId，帧值优先）：
//   1. toolRuns（事件驱动，messages store 基建）——运行中实时态唯一来源：
//      start 帧 args / update 帧最新 partialResult 快照（LIVE）/ end 帧 result（终态）+ isError；
//   2. entries（REST 落库）——历史终态：assistant 消息 content 的 toolCall part
//      （name==="task"，参数在 part.arguments）+ role="toolResult" 配对消息
//      （content[].text 正文 + details 终态键）。流式回合中 part 尚未定格，实时态全靠
//      toolRuns；刷新后历史终态卡靠 entries——两路互补，缺一路各自可渲染。
// 字段口径（任务 4 spike，.omo/evidence/docs08-r6/task-4-spike.md §四/§六）：
//   LIVE partialResult.details：progress.activity（引擎拼好 摘要·模型·turn·费用·速率
//   一行文案）、resolved_model.display、turns/toolCalls/tokens/outputTokens/
//   tokensPerSecond、lastAssistantLine（turn 后条件出现）——节流 ~250ms + 队列合并保最新，
//   最新快照尽力而为语义；快任务可能零中间帧（start 后直达 end），消费侧必须容忍 live=null。
//   FINAL result.details：task_id/status/task_summary/category/resolved_model/model/run_stats；
//   终态正文在 result.content[0].text，尾部带 "[task_id: … - continue with task_send(…)]"
//   尾注需剥离；details 无 final_response 键（first-class 字段仅 omo.task.updated 扩展帧，
//   D3 纪律：不作依据、绝不等待一个不存在的字段）。
import type { ToolRun } from "@/stores/messages";
import type { WireEntry, WirePart } from "@/lib/api";

/** 有限数值窄化（NaN/Infinity/非数值 → undefined） */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 非空字符串窄化（空串/非字符串 → undefined） */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** 普通对象窄化（null/数组/原始值 → null） */
function obj(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** content[] 的文本部分拼接（tool-card-data.textsOfContent 同构，未导出故本地实现） */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    const p = part as WirePart;
    if (p && p.type === "text" && typeof p.text === "string") texts.push(p.text);
  }
  return texts.join("\n");
}

/** LIVE 快照（tool_execution_update 的 partialResult.details 最新值；字段全部条件出现） */
export interface SubagentLive {
  taskId?: string;
  taskSummary?: string;
  category?: string;
  /** resolved_model.display（如 "GLM-5.3 Flash"） */
  modelDisplay?: string;
  /** 引擎拼好的进度一行文案（含 turn/费用/速率） */
  activity?: string;
  /** progress.startedAt（ISO） */
  startedAt?: string;
  /** 子代理最近一行输出（turn 完成后出现） */
  lastAssistantLine?: string;
  turns?: number;
  toolCalls?: number;
  tokens?: number;
  outputTokens?: number;
  tokensPerSecond?: number;
}

/** 终态用量（end result.details.run_stats，snake_case 实测键，全部条件出现） */
export interface SubagentRunStats {
  runtimeMs?: number;
  turns?: number;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  tokensPerSecond?: number;
  costUsd?: number;
  cacheHitRateRun?: number;
}

/** 终态快照（tool_execution_end 的 result / toolResult 配对消息，同构） */
export interface SubagentFinal {
  taskId?: string;
  /** 终态值（spike 实测 "completed"；失败族由消费侧按词表映射） */
  status?: string;
  taskSummary?: string;
  category?: string;
  modelDisplay?: string;
  /** details.model（"provider/model" 串） */
  modelId?: string;
  runStats?: SubagentRunStats;
  /** 终态正文（content[].text 已剥 [task_id] 尾注；无文本部分为 undefined） */
  responseText?: string;
}

/** 聚合卡渲染模型（collectSubagentCalls 产出，组件只读） */
export interface SubagentCall {
  toolCallId: string;
  /** start 帧事件确认值优先，回落 toolCall part.arguments */
  args: unknown;
  /** 运行中实时态（无终态且有 running run；零中间帧时 live=null 仍算运行中） */
  running: boolean;
  /** LIVE 最新快照（update 帧合并保最新；无中间帧为 null——降级为摘要行） */
  live: SubagentLive | null;
  /** 终态快照（end 帧结果优先，toolResult 消息兜底；均无为 null） */
  final: SubagentFinal | null;
  isError: boolean;
  /** 首见序（entries 时间序 + 事件后到追加），组件按此反序（最新在前） */
  order: number;
}

/** 剥离引擎终态正文尾部的 [task_id: …] 续接尾注（spike 形态
 *  `[task_id: st_xxx - continue with task_send(…)]`，恒为正文末段）。
 *  取最后一个 "[task_id:" 到串尾 "]"；正文自身含更早的同形字样不受影响；
 *  无尾注原样返回（仅去首尾空白）；整串即尾注返回空串（空正文）。 */
export function stripTaskIdTail(text: string): string {
  const trimmed = text.trim();
  const idx = trimmed.lastIndexOf("[task_id:");
  if (idx === -1 || !trimmed.endsWith("]")) return trimmed;
  return trimmed.slice(0, idx).trim();
}

/** partialResult → LIVE 快照（details 缺失/非对象 → null；字段级窄化缺者 undefined） */
export function parseLiveSnapshot(partialResult: unknown): SubagentLive | null {
  const pr = obj(partialResult);
  if (!pr) return null;
  const details = obj(pr.details);
  if (!details) return null;
  const progress = obj(details.progress);
  const resolvedModel = obj(details.resolved_model);
  return {
    taskId: str(details.task_id),
    taskSummary: str(details.task_summary),
    category: str(details.category),
    modelDisplay: resolvedModel ? str(resolvedModel.display) : undefined,
    activity: progress ? str(progress.activity) : undefined,
    startedAt: progress ? str(progress.startedAt) : undefined,
    lastAssistantLine: str(details.lastAssistantLine),
    turns: num(details.turns),
    toolCalls: num(details.toolCalls),
    tokens: num(details.tokens),
    outputTokens: num(details.outputTokens),
    tokensPerSecond: num(details.tokensPerSecond),
  };
}

/** run_stats（snake_case）→ 终态用量（全键条件窄化） */
function parseRunStats(raw: unknown): SubagentRunStats | undefined {
  const rs = obj(raw);
  if (!rs) return undefined;
  return {
    runtimeMs: num(rs.runtime_ms),
    turns: num(rs.turns),
    toolCalls: num(rs.tool_calls),
    inputTokens: num(rs.input_tokens),
    outputTokens: num(rs.output_tokens),
    totalTokens: num(rs.total_tokens),
    tokensPerSecond: num(rs.tokens_per_second),
    costUsd: num(rs.cost_usd),
    cacheHitRateRun: num(rs.cache_hit_rate_run),
  };
}

/** end result / toolResult 消息载荷 → 终态快照（details 与 content 文本任一存在即有效；
 *  details 缺失的老形态仍能取正文，保证状态机在 end 帧到达时必落终态） */
export function parseFinalSnapshot(result: unknown): SubagentFinal | null {
  const r = obj(result);
  if (!r) return null;
  const details = obj(r.details);
  const text = textOfContent(r.content);
  if (!details && !text) return null;
  const resolvedModel = details ? obj(details.resolved_model) : null;
  return {
    taskId: details ? str(details.task_id) : undefined,
    status: details ? str(details.status) : undefined,
    taskSummary: details ? str(details.task_summary) : undefined,
    category: details ? str(details.category) : undefined,
    modelDisplay: resolvedModel ? str(resolvedModel.display) : undefined,
    modelId: details ? str(details.model) : undefined,
    runStats: details ? parseRunStats(details.run_stats) : undefined,
    responseText: text ? stripTaskIdTail(text) : undefined,
  };
}

/** 卡片头部摘要（终态/实时 task_summary 优先，回落 args.task_summary，再回落 prompt 首行） */
export function summaryOfCall(call: SubagentCall): { primary: string; category: string | null; prompt: string | null } {
  const a = obj(call.args);
  const fromArgs = a ? str(a.task_summary) : undefined;
  const prompt = a ? str(a.prompt) : undefined;
  const fallback = fromArgs ?? (prompt ? (prompt.split("\n", 1)[0] ?? "").trim().slice(0, 80) : undefined);
  const primary = call.final?.taskSummary ?? call.live?.taskSummary ?? fallback ?? "";
  const category = call.final?.category ?? call.live?.category ?? (a ? str(a.category) : null) ?? null;
  return { primary, category, prompt: prompt ?? null };
}

/**
 * 会话级聚合：entries（历史/落库终态）+ toolRuns（事件实时态/终态）按 toolCallId 合并。
 * - entries 先扫：task toolCall part 建卡（历史时间序）；toolResult 消息先按 toolCallId
 *   收集、后回填（防裸 toolResult 误入——工具名只在 part 上，todo-panel 同口径）；
 * - toolRuns 后并（toolName==="task"）：帧值优先覆盖 args/isError，补实时快照与终态，
 *   无 part 的在途调用（流式中 part 未定格）新建卡追加序尾；
 * - running = 无终态快照且 run.status==="running"（终帧/配对消息任一到达即转终态，
 *   状态机不卡死；历史无 run 无结果按终态未知渲染，不虚标运行中）。
 */
export function collectSubagentCalls(entries: WireEntry[], toolRuns: Record<string, ToolRun>): SubagentCall[] {
  const byId = new Map<string, SubagentCall>();
  const toolResults = new Map<string, Record<string, unknown>>();
  let order = 0;

  for (const entry of entries) {
    const msg = obj(entry.message);
    if (!msg) continue;
    if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const part of content) {
        const p = part as WirePart;
        if (p == null || typeof p !== "object" || p.type !== "toolCall") continue;
        if (p.name !== "task" || typeof p.id !== "string" || p.id === "") continue;
        if (byId.has(p.id)) continue;
        byId.set(p.id, {
          toolCallId: p.id,
          args: p.arguments ?? null,
          running: false,
          live: null,
          final: null,
          isError: false,
          order: order++,
        });
      }
    } else if (msg.role === "toolResult" && typeof msg.toolCallId === "string" && msg.toolCallId !== "") {
      toolResults.set(msg.toolCallId, msg);
    }
  }

  // toolResult 回填（仅配对已建卡；消息级 isError 也在此并入）
  for (const [id, message] of toolResults) {
    const call = byId.get(id);
    if (!call) continue;
    const parsed = parseFinalSnapshot(message);
    if (parsed && !call.final) call.final = parsed;
    if (message.isError === true) call.isError = true;
  }

  // 事件态合并（帧值优先）
  for (const run of Object.values(toolRuns)) {
    if (run.toolName !== "task") continue;
    let call = byId.get(run.toolCallId);
    if (!call) {
      call = { toolCallId: run.toolCallId, args: null, running: false, live: null, final: null, isError: false, order: order++ };
      byId.set(run.toolCallId, call);
    }
    if (run.args != null) call.args = run.args;
    const live = parseLiveSnapshot(run.partialResult);
    if (live) call.live = live;
    const final = parseFinalSnapshot(run.result);
    if (final) call.final = final;
    if (run.isError === true) call.isError = true;
    call.running = !call.final && run.status === "running";
  }

  // 历史卡（无 run）终态未知：running 保持 false（不虚标运行中）
  return [...byId.values()].sort((a, b) => a.order - b.order);
}
