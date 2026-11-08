// nav-rail 分段指示器纯逻辑（#27b，openchamber 同款右缘分段轨）：每条用户刻度自成一段
//（用户消息簇），段高 ∝ 段内用户消息量（渲染侧 flex 比例分配 + 最小可点高 12px 承担），
// 段多时相邻段合并保持可辨识密度（buildSegments maxSegments），段标签取段首刻度所在
// 自然日「今天/昨天/M月D日」（更早日期走 Intl 月-日，zh-CN「10月30日」形态，同 i18n.ts
// formatRelativeTime 的 Intl 口径）。now/locale/今日昨日文案由调用侧注入（测试确定性），
// 本模块无副作用无 store 依赖。
import type { ChatListItem } from "./message-items";
import type { WireEntry, WireMessage } from "@/lib/api";

/** 弹卡行摘要字数（单行 60 字截断） */
export const SEGMENT_SUMMARY_CHARS = 60;

/** 导航刻度：items 数组中的下标（查测量缓存用）+ 条目 id/行 key（落位/高亮用）+ 悬停预览 + 条目时间 */
export interface NavTick {
  key: string;
  index: number;
  entryId: string;
  /** 条目摘要（40 字，aria-label 用） */
  title: string;
  /** 条目摘要（60 字，弹卡行用） */
  summary: string;
  /** 条目 timestamp 的 HH:MM 形态；无有效时间数据为 null（弹卡行不显示时间） */
  time: string | null;
  /** 本地自然日键（YYYY-MM-DD）；时间戳无效为 ""（聚合时并入相邻段，不单独成段） */
  dayKey: string;
}

/** 弹卡行：段内一条用户消息（时间 + 单行摘要，旧→新） */
export interface NavSegmentRow {
  key: string;
  time: string | null;
  summary: string;
}

/** 段：用户消息簇（一条用户消息自成一段；段多时相邻段合并显示，段键 = 段首刻度 key） */
export interface NavSegmentSpec {
  key: string;
  /** 日期标签（段首刻度所在自然日：今天/昨天/Intl 月-日；无效日键为 "—"） */
  label: string;
  /** 段内用户消息数（段高权重，≥1；合并段为被并入各簇之和） */
  count: number;
  /** 段首刻度 items 下标与行 key（点击段落位/高亮锚点；行 key 即条目 id，跨重排稳定） */
  firstIndex: number;
  firstKey: string;
  /** 该日用户消息行（旧→新；弹卡显示尾部 N 条） */
  rows: NavSegmentRow[];
  /** 段数据是否完整：首段且窗外还有更早历史（hasMore）时窗外可能仍有该日条目，视为不完整 */
  complete: boolean;
}

/** 条目 timestamp → HH:MM（wire 条目原样 timestamp 字段，同 store 现读链路；无效值 null） */
export function tickTime(timestamp: unknown): string | null {
  const d = new Date(timestamp as string | number);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 条目 timestamp → 本地自然日键（YYYY-MM-DD）；无效值 null */
export function dayKeyOf(timestamp: unknown): string | null {
  const d = new Date(timestamp as string | number);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 用户消息首个 text part 原文（纯图/空文本消息返回 null 不刻画度） */
function firstUserText(msg: WireMessage): string | null {
  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
      return part.text.trim();
    }
  }
  return null;
}

/** 摘要截断：超限尾部省略号 */
function clipText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** items 里可导航的用户刻度（streaming/memoryMarker/assistant/toolResult/纯图消息不刻） */
export function buildTicks(items: ChatListItem[], entries: WireEntry[]): NavTick[] {
  const byId = new Map<string, { msg: WireMessage; ts: unknown }>();
  for (const e of entries) {
    const msg = e.message as WireMessage | undefined;
    if (typeof e.id === "string" && msg) byId.set(e.id, { msg, ts: e.timestamp });
  }
  const list: NavTick[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "entry") continue; // streaming / memoryMarker 等不刻画度
    const found = byId.get(item.entryId);
    const msg = found?.msg;
    if (!msg || msg.role !== "user") continue; // assistant / toolResult 不刻画度
    const text = firstUserText(msg);
    if (text === null) continue;
    list.push({
      key: item.key,
      index: i,
      entryId: item.entryId,
      title: clipText(text, 40),
      summary: clipText(text, SEGMENT_SUMMARY_CHARS),
      time: tickTime(found.ts),
      dayKey: dayKeyOf(found.ts) ?? "",
    });
  }
  return list;
}

/** 自然日键 → 段标签：今天/昨天走注入文案（按本地日界差整日数判定，DST 跨日由
 *  Math.round 收敛），更早走 Intl 月-日（locale 注入；zh-CN「10月29日」形态，short 月名
 *  同 i18n.ts formatRelativeTime 口径）；无效日键（""）为 "—"。 */
export function dayLabelOf(
  dayKey: string,
  now: number,
  locale: string,
  labels: { today: string; yesterday: string },
): string {
  if (dayKey === "") return "—";
  const parts = dayKey.split("-").map(Number);
  const at = new Date(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1).getTime();
  const midnight = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const diffDays = Math.round((midnight(new Date(now)) - at) / 86_400_000);
  if (diffDays === 0) return labels.today;
  if (diffDays === 1) return labels.yesterday;
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(at);
}

/** 相邻段合并后单段的最小占轨高度（px）：minHeight 12px + my-px 间隙 2px。
 *  调用侧按轨高换算 maxSegments = floor(railH / SEG_MIN_TRACK_PX)，段数超出即合并。 */
export const SEG_MIN_TRACK_PX = 14;

/** 刻度按用户消息簇聚合成段（#27b，时间线旧→新）：每条用户刻度自成一段；段数超出
 *  maxSegments（轨高÷单段最小占轨高度，保持可辨识密度）时相邻段合并——每轮选权和
 *  最小的相邻对（并列取最左）并入左段（段键/段首/标签随左段，行清单顺序拼接）。
 *  complete = 非首段，或首段无更早历史。maxSegments 缺省不合并（轨高未知时先按簇
 *  展示，测得轨高后随重渲染收敛）。 */
export function buildSegments(
  ticks: readonly NavTick[],
  opts: {
    hasMore: boolean;
    now: number;
    locale: string;
    labels: { today: string; yesterday: string };
    maxSegments?: number;
  },
): NavSegmentSpec[] {
  const segments: NavSegmentSpec[] = ticks.map((tick, i) => ({
    key: tick.key,
    label: dayLabelOf(tick.dayKey, opts.now, opts.locale, opts.labels),
    count: 1,
    firstIndex: tick.index,
    firstKey: tick.key,
    rows: [{ key: tick.key, time: tick.time, summary: tick.summary }],
    complete: i > 0 || !opts.hasMore,
  }));
  const max = opts.maxSegments ?? Number.POSITIVE_INFINITY;
  while (segments.length > max) {
    let best = 0;
    let bestSum = Number.POSITIVE_INFINITY;
    for (let i = 0; i < segments.length - 1; i++) {
      const sum = segments[i]!.count + segments[i + 1]!.count;
      if (sum < bestSum) {
        bestSum = sum;
        best = i;
      }
    }
    const left = segments[best]!;
    const right = segments[best + 1]!;
    segments[best] = {
      ...left,
      count: left.count + right.count,
      rows: [...left.rows, ...right.rows],
    };
    segments.splice(best + 1, 1);
  }
  return segments;
}
