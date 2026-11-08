// nav-rail 指示器带纯逻辑（OpenChamber v1.24.2 同款右缘刻度带复刻）：每条用户刻度
// 自成一段（用户消息簇），带体每格 12px pitch、段多时相邻段合并到上限 30 格
// （带高 = min(段数, 30) * 12px），超出即按权和最小相邻对合并保持可辨识密度。
// 活动段判定 pickActiveSegmentIndex：顶边 ≤ scrollTop+100px 的最后一段；距底
// ≤ max(48px, 10% 视口) 取最后段。本模块无副作用无 store 依赖。
import type { ChatListItem } from "./message-items";
import type { WireEntry, WireMessage } from "@/lib/api";

/** 悬停面板行摘要字数（两行截断，160 字符截断） */
export const SEGMENT_SUMMARY_CHARS = 160;

/** 带体每格 pitch（px）：一格一段，刻度条 2px 圆头居中 */
export const PITCH_PX = 12;

/** 带体最大格数（段数超出即合并），带高 = min(段数, 上限) * PITCH_PX */
export const BAND_MAX_SEGMENTS = 30;

/** 刻度带上下边缘 carousel 触发区高度（px）：停上/下 18px 内按 80ms 间隔滚动 */
export const BAND_EDGE_ZONE_PX = 18;

/** 活动段判定：顶边 ≤ scrollTop + 100px 的最后一段 */
export const ACTIVE_LEAD_PX = 100;

/** 导航刻度：items 数组中的下标（查测量缓存用）+ 条目 id/行 key（落位/高亮用）+ 面板预览摘要 */
export interface NavTick {
  key: string;
  index: number;
  entryId: string;
  /** 条目摘要（40 字，aria-label 用） */
  title: string;
  /** 条目摘要（160 字符，面板行用） */
  summary: string;
}

/** 段：用户消息簇（一条用户消息一格；段多时相邻段合并显示，段键 = 段首刻度 key） */
export interface NavSegmentSpec {
  key: string;
  /** 段内用户消息数（合并段为被并入各簇之和） */
  count: number;
  /** 段首刻度 items 下标与行 key（点击段落位/高亮锚点；行 key 即条目 id，跨重排稳定） */
  firstIndex: number;
  firstKey: string;
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
  const byId = new Map<string, { msg: WireMessage }>();
  for (const e of entries) {
    const msg = e.message as WireMessage | undefined;
    if (typeof e.id === "string" && msg) byId.set(e.id, { msg });
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
    });
  }
  return list;
}

/** 刻度聚合成段（时间线旧→新）：每条用户刻度一格；段数超出 maxSegments（带体上限
 *  30 格）时相邻段合并——每轮选权和最小的相邻对（并列取最左）并入左段（段键/段首
 *  随左段）。maxSegments 缺省取 BAND_MAX_SEGMENTS。 */
export function buildSegments(
  ticks: readonly NavTick[],
  maxSegments: number = BAND_MAX_SEGMENTS,
): NavSegmentSpec[] {
  const segments: NavSegmentSpec[] = ticks.map((tick) => ({
    key: tick.key,
    count: 1,
    firstIndex: tick.index,
    firstKey: tick.key,
  }));
  const max = Math.max(1, maxSegments);
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
    segments[best] = { ...left, count: left.count + right.count };
    segments.splice(best + 1, 1);
  }
  return segments;
}

/** 活动段判定（纯函数，scroll rAF 通道消费）：段顶边（测量缓存 start）≤
 *  scrollTop + ACTIVE_LEAD_PX 的最后一段；滚动距底 ≤ max(48px, 10% 视口) 或粘底
 *  时强制取最后段（最新段）。段全在判定线以下时取首段。 */
export function pickActiveSegmentIndex(
  segOffsets: readonly number[],
  opts: { scrollTop: number; viewportH: number; totalSize: number },
): number {
  const n = segOffsets.length;
  if (n === 0) return 0;
  const last = n - 1;
  const bottomGap = opts.totalSize - (opts.scrollTop + opts.viewportH);
  const nearBottom = bottomGap <= Math.max(48, opts.viewportH * 0.1);
  if (nearBottom) return last;
  const threshold = opts.scrollTop + ACTIVE_LEAD_PX;
  let idx = 0;
  for (let i = 0; i < n; i++) {
    if (segOffsets[i]! <= threshold) idx = i;
  }
  return idx;
}
