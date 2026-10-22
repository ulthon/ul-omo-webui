// 成本全景聚合纯函数（docs08 2026-10-22 批次任务 9，GAP-11 4⑪「成本全景卡」）。
// stat-panel 数据层：全部数据来自现成来源（无新端点/无新拉取——计划红线）：
//   - GET /api/usage 快照（status-bar-data.toUsageStats 产物）：累计费用 + token 分项（命中率分母）；
//   - messages store entries（SSE 已填充，组件只订阅）：per-entry message.usage.cost.total /
//     message.model / 条目时间戳 / toolCall→toolResult 配对；
//   - 子代理逐个花费沿 subagent-data.collectSubagentCalls（r6 数据源）在组件层取数。
// 估算纪律（缺数据行省略，计划口径）：条目无 message 级完成时间，模型/工具耗时只能按
// 时间戳聚合估算（口径见 aggregateTimeAttribution 注释）；cacheRead/total 可得才出命中率；
// usage 形状异常一律按 0/省略处理，绝不 NaN（零 usage → 零值展示）。
import type { WireEntry } from "@/lib/api";
import { entryTimestampMs } from "./step-duration";

function obj(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 严格有限数值（undefined/NaN/Infinity → null；与展示层 num() 的"缺省 0"语义区分——
 *  聚合层必须区分"无数据"与"零值"） */
function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isCountedEntryType(type: unknown): boolean {
  return type === "message" || type === "message_start" || type === "message_end";
}

/** 条目时间戳：entry.timestamp（ISO，jsonl 落库形态）优先，回落 message.timestamp（ms，帧形态） */
function entryMs(entry: WireEntry): number | null {
  const top = entryTimestampMs(entry.timestamp);
  if (top !== null) return top;
  const message = obj(entry.message);
  return message ? entryTimestampMs(message.timestamp) : null;
}

/** 本地日界 00:00 的 ms（"今日"口径：查看者本地时区） */
export function startOfTodayMs(nowMs: number): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 单条 assistant 条目的 per-entry 花费（message_end 落盘形态：usage.cost.total 数字） */
function assistantEntryCost(entry: WireEntry): { cost: number; model: string | null } | null {
  const msg = obj(entry.message);
  if (!msg || msg.role !== "assistant") return null;
  const usage = obj(msg.usage);
  if (!usage) return null;
  const cost = obj(usage.cost);
  const total = cost ? finite(cost.total) : null;
  if (total === null) return null;
  const model = typeof msg.model === "string" && msg.model !== "" ? msg.model : null;
  return { cost: total, model };
}

export interface ModelCostSplit {
  model: string;
  cost: number;
}

export interface CostBreakdown {
  /** 会话累计费用（usage 快照；非有限输入归 0，绝不 NaN） */
  cumulative: number;
  /** 今日费用（本地日界起的 per-entry cost.total 合计；零条目 → 0） */
  todayTotal: number;
  /** 今日按模型拆分（仅含 message.model 可得且花费>0 的条目；降序） */
  byModel: ModelCostSplit[];
  /** 计入今日合计的条目数（测试/诊断用） */
  entriesCounted: number;
}

/** 今日/累计费用聚合：累计取 usage 快照，今日从 messages 条目 per-entry
 *  usage.cost.total 按本地日界聚合；按 message.model 拆分（缺模型条目只进合计不进拆分）。
 *  时间戳在 (日界, now] 窗口内才计入——昨日条目不计今日，未来时间戳（时钟偏移）同样不计。 */
export function aggregateCostBreakdown(snapshotCost: number, entries: WireEntry[], nowMs: number): CostBreakdown {
  const cumulative = finite(snapshotCost) ?? 0;
  const dayStart = startOfTodayMs(nowMs);
  let todayTotal = 0;
  let entriesCounted = 0;
  const models = new Map<string, number>();
  for (const entry of entries) {
    if (!isCountedEntryType(entry.type)) continue;
    const info = assistantEntryCost(entry);
    if (!info) continue;
    const ts = entryMs(entry);
    if (ts === null || ts < dayStart || ts > nowMs) continue;
    todayTotal += info.cost;
    entriesCounted += 1;
    if (info.model) models.set(info.model, (models.get(info.model) ?? 0) + info.cost);
  }
  const byModel = [...models.entries()]
    .map(([model, cost]) => ({ model, cost }))
    .sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
  return { cumulative, todayTotal, byModel, entriesCounted };
}

export interface TimeAttribution {
  /** 模型生成耗时估算 ms；无法估算（零生成窗）→ null，行省略 */
  modelMs: number | null;
  /** 工具执行耗时合计 ms；无配对 → null，行省略 */
  toolMs: number | null;
}

/** 模型 vs 工具耗时（时间戳聚合估算，唯一可得口径——message 无完成时间字段）：
 *  - 工具 = Σ(toolResult 条目 ts − 配对 toolCall 所在 assistant 条目 ts)，每 id 取首个结果；
 *  - 模型 = Σ assistant 生成窗：有工具调用的条目取「首个自有配对结果到达 ts」（生成必已
 *    结束，含首工具排队，轻微高估）；无工具调用的条目仅当时间线后继是引擎活动条目
 *    （assistant/toolResult，罕见连续生成）才取后继 ts——收尾 assistant 的下一条目是
 *    下一次用户消息（间隔含用户空闲），不可作生成窗，省略（已知低估）。
 *  两口径独立计算，和可超墙钟（估算语义，i18n 标签明示"估"）；负跨度（时钟偏移/乱序）丢弃。 */
export function aggregateTimeAttribution(entries: WireEntry[]): TimeAttribution {
  const timeline: Array<{ role: string | null; ts: number; toolCallIds: string[] }> = [];
  const callTs = new Map<string, number>();
  for (const entry of entries) {
    if (!isCountedEntryType(entry.type)) continue;
    const ts = entryMs(entry);
    if (ts === null) continue;
    const msg = obj(entry.message);
    const role = msg && typeof msg.role === "string" ? msg.role : null;
    const toolCallIds: string[] = [];
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        const p = obj(part);
        if (p && p.type === "toolCall" && typeof p.id === "string" && p.id !== "") toolCallIds.push(p.id);
      }
    }
    timeline.push({ role, ts, toolCallIds });
    if (role === "assistant") {
      for (const id of toolCallIds) if (!callTs.has(id)) callTs.set(id, ts);
    }
  }
  // 配对：toolResult.toolCallId → 首个结果条目 ts（仅配对已建卡调用）
  const resultTs = new Map<string, number>();
  for (const entry of entries) {
    if (!isCountedEntryType(entry.type)) continue;
    const msg = obj(entry.message);
    if (!msg || msg.role !== "toolResult") continue;
    const tcId = typeof msg.toolCallId === "string" ? msg.toolCallId : null;
    if (!tcId || !callTs.has(tcId) || resultTs.has(tcId)) continue;
    const ts = entryMs(entry);
    if (ts === null) continue;
    const call = callTs.get(tcId) ?? 0;
    if (ts - call < 0) continue;
    resultTs.set(tcId, ts);
  }
  let toolMs = 0;
  let paired = 0;
  for (const [id, call] of callTs) {
    const r = resultTs.get(id);
    if (r === undefined) continue;
    toolMs += r - call;
    paired += 1;
  }
  let modelMs = 0;
  let genCount = 0;
  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i];
    if (t.role !== "assistant") continue;
    let end: number | null = null;
    if (t.toolCallIds.length > 0) {
      for (const id of t.toolCallIds) {
        const r = resultTs.get(id);
        if (r !== undefined) end = end === null ? r : Math.min(end, r);
      }
    }
    if (end === null) {
      const next = timeline[i + 1];
      if (next && (next.role === "assistant" || next.role === "toolResult")) end = next.ts;
    }
    if (end === null) continue;
    const span = end - t.ts;
    if (span < 0) continue;
    modelMs += span;
    genCount += 1;
  }
  return { modelMs: genCount > 0 ? modelMs : null, toolMs: paired > 0 ? toolMs : null };
}

/** 缓存命中率 = cacheRead / total（total 实测 = input+output+cacheRead+cacheWrite，
 *  glm-4.6v 样本核对 45371 吻合）；total≤0 → null（行省略），cacheRead 0 → 0%（如实为零）。 */
export function cacheHitRate(tokens: { cacheRead: number; total: number }): number | null {
  const total = finite(tokens.total);
  const cacheRead = finite(tokens.cacheRead);
  if (total === null || total <= 0) return null;
  return (cacheRead ?? 0) / total;
}
