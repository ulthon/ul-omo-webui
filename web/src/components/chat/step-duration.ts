// 折叠步骤行耗时标签（docs08 2026-10-22 批次任务 7）：thinking 块用条目起止时间戳差
// （本条目 timestamp → 时间线上紧随的下一条目 timestamp），tool-card 用 toolCall 所在
// 条目 → 配对 toolResult 条目的时间戳差（无结果省略）。时间戳缺失（老会话）一律返回
// null——不显示标签、不显示占位。格式沿 subagent-panel formatDuration 先例
// （<1s → "0.4s"？否：同秒对显 "0.0s" 不空值；<60s → 一位小数秒；分钟级 → "1m 23s"；
// 小时级无既有先例，分钟数自然增长如 "75m 3s"，不新增小时档）。
import type { WireEntry } from "@/lib/api";

/** 条目时间戳 → ms。接受 ISO 字符串（entry.timestamp 实录形态）与 ms 数字
 *  （message.timestamp 实录形态，TODO_RESULT_MESSAGE fixture 等）；缺失/非法 → null。 */
export function entryTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** ms → 耗时标签。负值（时钟偏移/乱序）按 0 处理；同秒差显 "0.0s"（非空非 NaN）。
 *  边界先按整秒四舍五入再分档：59.95s 起进位到 "1m 0s"，永不出现 "60.0s"/"1m 60s"（t7 终验微修）。 */
export function formatStepDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSec = Math.round(clamped / 1000);
  if (totalSec < 60) return `${(clamped / 1000).toFixed(1)}s`;
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

/** 起止时间戳 → 标签；任一缺失 → null（不显示）。 */
export function stepDurationLabel(
  startMs: number | null,
  endMs: number | null,
): string | null {
  if (startMs === null || endMs === null) return null;
  return formatStepDuration(endMs - startMs);
}

/** 条目时间戳窄化：entry.timestamp 优先，回落 message.timestamp（toolResult 帧形态）。 */
function entryStartMs(entry: WireEntry): number | null {
  const top = entryTimestampMs(entry.timestamp);
  if (top !== null) return top;
  const message = entry.message as { timestamp?: unknown } | undefined;
  return entryTimestampMs(message?.timestamp);
}

/** thinking 块耗时：本条目 → 时间线上紧随的下一条目时间戳差。任一端缺失 → null。 */
export function thinkingDurationLabel(
  entries: WireEntry[],
  entryId: string,
): string | null {
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx < 0 || idx + 1 >= entries.length) return null;
  return stepDurationLabel(entryStartMs(entries[idx]), entryStartMs(entries[idx + 1]));
}

/** 工具调用耗时：toolCall 所在条目 → 按 toolCallId 配对的 toolResult 条目时间戳差。
 *  无结果（运行中/老会话缺帧）→ null。配对遍历同 tool-card.findToolResultMessage 的
 *  条目类型集合（message / message_start / message_end）。 */
export function toolDurationLabel(
  entries: WireEntry[],
  toolCallId: string,
  entryId: string,
): string | null {
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx < 0) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" && entry.type !== "message_start" && entry.type !== "message_end")
      continue;
    const msg = entry.message as { role?: unknown; toolCallId?: unknown } | undefined;
    if (msg && msg.role === "toolResult" && msg.toolCallId === toolCallId) {
      return stepDurationLabel(entryStartMs(entries[idx]), entryStartMs(entry));
    }
  }
  return null;
}
