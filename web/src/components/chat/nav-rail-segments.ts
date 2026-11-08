// nav-rail 纯逻辑（OpenChamber v2.7.0 角标+面板形态）：每条用户消息一个 prompt 行，
// 角标五格刻度亮格数由阅读位置在已加载 prompt 序列中等比映射；活动位置判定沿用
// pickActiveSegmentIndex（顶边 ≤ scrollTop+100px 的最后一段；距底 ≤ max(48px, 10%
// 视口) 取最后段）。本模块无副作用无 store 依赖。
import type { ChatListItem } from "./message-items";
import type { WireEntry, WireMessage } from "@/lib/api";

/** 面板行摘要字数（两行截断，title 全文） */
export const SEGMENT_SUMMARY_CHARS = 160;

/** 角标固定格数（亮格在其中按阅读位置映射） */
export const INDICATOR_CELLS = 5;

/** 活动位置判定：顶边 ≤ scrollTop + 100px 的最后一段 */
export const ACTIVE_LEAD_PX = 100;

/** 导航行：items 数组中的下标（查测量缓存用）+ 条目 id/行 key（落位/高亮用）+ 预览摘要 */
export interface NavTick {
  key: string;
  index: number;
  entryId: string;
  /** 条目摘要（40 字，aria-label 用） */
  title: string;
  /** 条目摘要（160 字符，面板行用） */
  summary: string;
}

/** 用户消息首个 text part 原文（纯图/空文本消息返回 null 不刻行） */
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
    if (item.kind !== "entry") continue; // streaming / memoryMarker 等不刻
    const found = byId.get(item.entryId);
    const msg = found?.msg;
    if (!msg || msg.role !== "user") continue; // assistant / toolResult 不刻
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

/** entries 里的用户 prompt 计数（分页循环终止判定：至少新增 1 条才停） */
export function countUserPrompts(entries: readonly WireEntry[]): number {
  let n = 0;
  for (const e of entries) {
    const msg = e.message as WireMessage | undefined;
    if (!msg || msg.role !== "user") continue;
    if (firstUserText(msg) !== null) n++;
  }
  return n;
}

/** 角标亮格数（0..5）：条数 ≤5 时亮 min(条数, 5)（全亮展示已加载序列）；超过 5 条
 *  时按当前阅读位置等比映射到 1..5（首条亮 1 格、末条亮满 5 格）。 */
export function litCountOf(segCount: number, activeIdx: number): number {
  if (segCount <= 0) return 0;
  if (segCount <= INDICATOR_CELLS) return Math.min(segCount, INDICATOR_CELLS);
  const idx = Math.min(Math.max(activeIdx, 0), segCount - 1);
  return 1 + Math.round((idx / (segCount - 1)) * (INDICATOR_CELLS - 1));
}

/** 活动位置判定（纯函数，scroll rAF 通道消费）：顶边 ≤ scrollTop + ACTIVE_LEAD_PX 的
 *  最后一段；滚动距底 ≤ max(48px, 10% 视口) 或粘底时强制取最后段。段全在判定线以下
 *  时取首段。 */
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
