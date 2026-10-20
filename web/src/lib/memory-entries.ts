// 记忆标记条目甄别与派生（docs08-r4 任务 13，spike task-3 (c) 实证）：
// 引擎记忆相关 custom 条目经两通道到达，历史（GET messages 全量）与实时（SSE）形态同构——
//   entry 通道：历史 type:"custom" 条目；实时 entry_appended 载荷同形。
//     实证：senpi-memory.session-binding / omo-memory:accepted-turns / omo-memory:projection-pin。
//   message 通道：历史 type:"custom_message" 条目；实时 message_end（message.role="custom"）。
//     omo-kibitzer:nudged / omo-memorian:nudged / omo-memory:notice（spike 短会话未实测到帧，
//     customType 清单来自 omo 扩展源码枚举，形态按同构实现，联调时核对）。
// 白名单外条目（pi-rules.scan、senpi.hooks.stop-state、senpi-task.usage、environment-context、
// senpi.todo-first-turn、omo-model-profile:applied 等引擎内部状态）一律不渲染、不入列。
// 载荷只做窄化读取（wire 原样透传，形态从宽），异常形态降级为通用摘要，不臆造字段。
import type { WireEntry } from "@/lib/api";
import type { MessageKey } from "@/i18n/i18n";

/** entry 通道白名单（type:"custom" 条目的 customType；entry_appended 放行与渲染共用） */
export const MEMORY_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "senpi-memory.session-binding",
  "omo-memory:accepted-turns",
  "omo-memory:projection-pin",
]);

/** message 通道白名单（custom_message 条目 / role:"custom" 消息的 customType；
 *  spike 源码枚举清单内的提示三类，短会话未实测到帧） */
export const MEMORY_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "omo-kibitzer:nudged",
  "omo-memorian:nudged",
  "omo-memory:notice",
]);

export type MemoryMarkerKind =
  | "sessionBinding"
  | "acceptedTurns"
  | "projectionPin"
  | "kibitzerNudged"
  | "memorianNudged"
  | "memoryNotice";

/** 视觉权重：weak=弱标记（entry 通道主类）；weakest=极弱（projection-pin，spike 允许可忽略）；
 *  notice=提示卡（message 通道 kibitzer/memorian/notice）。 */
export type MemoryMarkerWeight = "weak" | "weakest" | "notice";

/** 摘要纯数据形态（任务 10）：组件层 t(summary.key, summary.vars) 渲染 */
export interface MemoryMarkerSummary {
  key: MessageKey;
  vars?: Record<string, unknown>;
}

export interface MemoryMarker {
  /** 锚定条目 id（并入 items 时的排序锚点 + React key） */
  entryId: string;
  kind: MemoryMarkerKind;
  weight: MemoryMarkerWeight;
  /** 一句话摘要（标记块常显文案；{key, vars} 纯数据） */
  summary: MemoryMarkerSummary;
  /** 展开原文（data JSON 或 content 文本；空串 = 无可展开内容） */
  detail: string;
  /** 渲染去重键（仅 sessionBinding 设 identity：引擎每回合重写 binding 条目，同一 identity
   *  重复标记是噪音，流内只显示首次绑定；其余类型不设，逐条忠实渲染） */
  dedupeKey?: string;
}

/** customType 读取：custom 条目在顶层，role=custom 消息在 message 内 */
function customTypeOf(entry: WireEntry): string | null {
  if (typeof entry.customType === "string" && entry.customType !== "") return entry.customType;
  const msg = entry.message;
  if (msg !== null && typeof msg === "object") {
    const mct = (msg as Record<string, unknown>).customType;
    if (typeof mct === "string" && mct !== "") return mct;
  }
  return null;
}

/** entry 通道：type:"custom" 且 customType 在白名单（须有 id，入列按 id 幂等） */
export function isMemoryCustomEntry(entry: WireEntry): boolean {
  if (entry.type !== "custom" || typeof entry.id !== "string") return false;
  const ct = customTypeOf(entry);
  return ct !== null && MEMORY_ENTRY_TYPES.has(ct);
}

/** message 通道：type:"custom_message"（历史与实时 entry_appended 载荷同形，均有 id）/
 *  实时 message_end（message.role="custom"，实测无 id，有 id 时才可渲染）。
 *  message_start 不认（start/end 双帧防重，终态以 end 为准）。 */
export function isMemoryCustomMessageEntry(entry: WireEntry): boolean {
  if (typeof entry.id !== "string") return false;
  if (entry.type === "custom_message") {
    const ct = customTypeOf(entry);
    return ct !== null && MEMORY_MESSAGE_TYPES.has(ct);
  }
  if (entry.type !== "message_end") return false;
  const msg = entry.message;
  if (msg === null || typeof msg !== "object") return false;
  if ((msg as Record<string, unknown>).role !== "custom") return false;
  const ct = customTypeOf(entry);
  return ct !== null && MEMORY_MESSAGE_TYPES.has(ct);
}

/** entry_appended 载荷放行门（store 入列）：白名单 custom 条目 + 白名单 custom_message
 *  条目（隔离实例实测：custom_message 经 entry_appended 携 id 到达，早于同义的
 *  message_start/end 无 id 帧）。其余（pi-rules.scan、senpi.hooks.stop-state、
 *  senpi-task.usage、type:"message" 的 user/assistant 条目等）一律不放行。 */
export function isMemoryAppendedEntry(entry: WireEntry): boolean {
  return isMemoryCustomEntry(entry) || isMemoryCustomMessageEntry(entry);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 载荷对象：custom 条目 data（顶层）/ custom_message details（顶层）/ 实时 message.details */
function payloadOf(entry: WireEntry): Record<string, unknown> | null {
  if (isPlainObject(entry.data)) return entry.data;
  if (isPlainObject(entry.details)) return entry.details;
  const msg = entry.message;
  if (msg !== null && typeof msg === "object") {
    const det = (msg as Record<string, unknown>).details;
    if (isPlainObject(det)) return det;
  }
  return null;
}

/** 展开用文本：custom_message content 优先（提示卡正文），custom 条目回落 data JSON */
function detailTextOf(entry: WireEntry): string {
  const direct = typeof entry.content === "string" ? entry.content : "";
  if (direct !== "") return direct;
  const msg = entry.message;
  if (msg !== null && typeof msg === "object") {
    const c = (msg as Record<string, unknown>).content;
    if (typeof c === "string" && c !== "") return c;
  }
  const payload = payloadOf(entry);
  if (payload !== null && Object.keys(payload).length > 0) return JSON.stringify(payload, null, 2);
  return "";
}

function markerMeta(customType: string): { kind: MemoryMarkerKind; weight: MemoryMarkerWeight } | null {
  switch (customType) {
    case "senpi-memory.session-binding":
      return { kind: "sessionBinding", weight: "weak" };
    case "omo-memory:accepted-turns":
      return { kind: "acceptedTurns", weight: "weak" };
    case "omo-memory:projection-pin":
      return { kind: "projectionPin", weight: "weakest" };
    case "omo-kibitzer:nudged":
      return { kind: "kibitzerNudged", weight: "notice" };
    case "omo-memorian:nudged":
      return { kind: "memorianNudged", weight: "notice" };
    case "omo-memory:notice":
      return { kind: "memoryNotice", weight: "notice" };
    default:
      return null;
  }
}

function summaryOf(customType: string, payload: Record<string, unknown> | null): MemoryMarkerSummary {
  switch (customType) {
    case "senpi-memory.session-binding": {
      const identity = payload !== null && typeof payload.identity === "string" ? payload.identity : "";
      return identity !== ""
        ? { key: "chat.memoryMarkers.boundWith", vars: { identity } }
        : { key: "chat.memoryMarkers.bound" };
    }
    case "omo-memory:accepted-turns":
      return { key: "chat.memoryMarkers.acceptedTurns" };
    case "omo-memory:projection-pin":
      return { key: "chat.memoryMarkers.projectionPin" };
    case "omo-kibitzer:nudged":
      return { key: "chat.memoryMarkers.kibitzerNudged" };
    case "omo-memorian:nudged":
      return { key: "chat.memoryMarkers.memorianNudged" };
    case "omo-memory:notice":
      return { key: "chat.memoryMarkers.memoryNotice" };
    default:
      return { key: "chat.memoryMarkers.memoryNotice" };
  }
}

/** 条目 → 记忆标记（非白名单 / 非两通道形态 / 无 id 一律 null，渲染层跳过） */
export function memoryMarkerOf(entry: WireEntry): MemoryMarker | null {
  if (typeof entry.id !== "string" || entry.id === "") return null;
  const customType = customTypeOf(entry);
  if (customType === null) return null;
  const meta = markerMeta(customType);
  if (meta === null) return null;
  if (!isMemoryCustomEntry(entry) && !isMemoryCustomMessageEntry(entry)) return null;
  const payload = payloadOf(entry);
  const marker: MemoryMarker = {
    entryId: entry.id,
    kind: meta.kind,
    weight: meta.weight,
    summary: summaryOf(customType, payload),
    detail: detailTextOf(entry),
  };
  if (meta.kind === "sessionBinding" && payload !== null && typeof payload.identity === "string") {
    marker.dedupeKey = payload.identity;
  }
  return marker;
}
