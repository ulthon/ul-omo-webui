// nav-rail 分段指示器纯逻辑（openchamber 同款右缘分段轨）：用户刻度按自然日聚合成段，
// 段高 ∝ 段内用户消息量（渲染侧 flex 比例分配 + 最小可点高 12px 承担），段日期标签
// 「今天/昨天/M月D日」（更早日期走 Intl 月-日，zh-CN「10月30日」形态，同 i18n.ts
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

/** 段：一个自然日的用户刻度聚合（段键 = 自然日键，全无效时间戳段为 ""） */
export interface NavSegmentSpec {
  key: string;
  /** 日期标签（今天/昨天/Intl 月-日；无效日键为 "—"） */
  label: string;
  /** 段内用户消息数（段高权重，≥1） */
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

/** 刻度按自然日聚合成段（时间线旧→新）：无效日键（""）刻度并入前段，流首无前段时
 *  并入次个真实日段，全无效自成一段（标签 "—"）。complete = 非首段，或首段无更早历史。 */
export function buildSegments(
  ticks: readonly NavTick[],
  opts: {
    hasMore: boolean;
    now: number;
    locale: string;
    labels: { today: string; yesterday: string };
  },
): NavSegmentSpec[] {
  const groups: Array<{ dayKey: string; ticks: NavTick[] }> = [];
  let pending: NavTick[] = []; // 无效日键缓冲：有前段并前段，否则并入下一个真实日段
  for (const tick of ticks) {
    if (tick.dayKey === "") {
      pending.push(tick);
      continue;
    }
    const last = groups[groups.length - 1];
    if (!last) {
      groups.push({ dayKey: tick.dayKey, ticks: [...pending, tick] });
    } else {
      if (pending.length > 0) {
        last.ticks.push(...pending);
        pending = [];
      }
      if (last.dayKey === tick.dayKey) {
        last.ticks.push(tick);
      } else {
        groups.push({ dayKey: tick.dayKey, ticks: [tick] });
      }
    }
  }
  if (pending.length > 0) {
    const last = groups[groups.length - 1];
    if (last) last.ticks.push(...pending);
    else groups.push({ dayKey: "", ticks: pending });
  }
  return groups.map((g, i) => {
    const head = g.ticks[0]; // 组入列时必带首刻度
    return {
      key: g.dayKey,
      label: dayLabelOf(g.dayKey, opts.now, opts.locale, opts.labels),
      count: g.ticks.length,
      firstIndex: head.index,
      firstKey: head.key,
      rows: g.ticks.map((tk) => ({ key: tk.key, time: tk.time, summary: tk.summary })),
      complete: i > 0 || !opts.hasMore,
    };
  });
}
