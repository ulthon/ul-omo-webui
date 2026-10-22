// 消息 footer 溯源行数据源（docs08 2026-10-22 批次任务 17）：assistant 气泡头部
// 模型短名旁的「代理名 + 用时」取数纯函数。leaf 模块（fast-refresh 口径，单测直驱）。
//
// 数据源可得性核对（任务 17「可得性首步核对」结论，2026-10-22 实证）：
// - agent 名：引擎自身推导「当前 agent」的唯一 wire 通道是 custom 条目 data 上的
//   agentName / agent 字符串（session-worker.js deriveAgentName 实证：倒序扫描
//   custom 条目取 data.agentName ?? data.agent；compaction.agent-checkpoint 落库
//   同形态，真实库内当前全为 null）。本模块按同通道取值——无名 agent 返回 null，
//   渲染层省略不臆造；引擎侧一旦落了具名 agent（含子代理标注）即如实显示。
// - 用时：时间戳差（任务 7 折叠行耗时同款数据面）。锚点 = 时间线上最近一条更早的
//   user 消息条目（回合起点）：回合最终回复即整回合用时（对齐 OC「9m 46s」量级），
//   回合中途步进气泡为回合已进行时长；无 user 锚点（老会话截断/纯工具流）或任一端
//   时间戳缺失/非法（流式在途）→ null，渲染层省略。格式复用 step-duration 既有
//   先例（同秒差 "0.0s" 非空、一位小数秒、分钟级 "9m 46s"、负差按 0 收敛）。
//
// 纯函数无副作用；entries 缺失（store 未及/会话未加载）一律 null。
import type { WireEntry } from "@/lib/api";
import { entryTimestampMs, formatStepDuration } from "./step-duration";

/** 条目时间戳窄化：entry.timestamp（ISO，jsonl 实录形态）优先，回落 message.timestamp
 *  （ms 数字，message 帧实录形态）——step-duration.entryStartMs 同款链，不另立口径。 */
function entryStartMs(entry: WireEntry): number | null {
  const top = entryTimestampMs(entry.timestamp);
  if (top !== null) return top;
  const message = entry.message as { timestamp?: unknown } | undefined;
  return entryTimestampMs(message?.timestamp);
}

/** 条目 message 载荷 role 窄化（wire 形态从宽，非对象/缺 role 视为不可判）。 */
function roleOf(entry: WireEntry): unknown {
  const message = entry.message;
  if (message === null || typeof message !== "object") return undefined;
  return (message as { role?: unknown }).role;
}

/** 溯源 agent 名（引擎 deriveAgentName 同通道）：该条目及更早的最近一条 custom 条目
 *  data.agentName（优先）或 data.agent（回落）字符串；无名/空串跳过，无命中 → null。
 *  条目自身在时间线之后（更晚）的标注不回溯适用。 */
export function originAgentName(
  entries: readonly WireEntry[] | undefined,
  entryId: string,
): string | null {
  if (!entries) return null;
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx < 0) return null;
  for (let i = idx; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "custom") continue;
    const data = entry.data;
    if (data === null || typeof data !== "object") continue;
    const record = data as Record<string, unknown>;
    if (typeof record.agentName === "string" && record.agentName !== "") return record.agentName;
    if (typeof record.agent === "string" && record.agent !== "") return record.agent;
  }
  return null;
}

/** 消息用时标签：本条目完成时间戳 − 最近一条更早 user 消息条目时间戳。
 *  无 user 锚点 / 锚点或本条目时间戳缺失 → null；锚点时间戳缺失（罕见畸形）跳过
 *  继续向前找。负差（时钟偏移/乱序）由 formatStepDuration 按 0 收敛为 "0.0s"
 *  （任务 7 先例：同秒差显 0.0s 不空值）。 */
export function originDurationLabel(
  entries: readonly WireEntry[] | undefined,
  entryId: string,
): string | null {
  if (!entries) return null;
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx < 0) return null;
  const endMs = entryStartMs(entries[idx]);
  if (endMs === null) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || roleOf(entry) !== "user") continue;
    const startMs = entryStartMs(entry);
    if (startMs === null) continue;
    return formatStepDuration(endMs - startMs);
  }
  return null;
}
