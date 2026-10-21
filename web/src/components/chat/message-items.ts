// 消息流 items 组装纯逻辑：
// 从 message-list.tsx 拆出（组件文件只导组件，fast-refresh 约束；同 composer-logic 惯例）。
// chat-view.tsx 组装 items（chat-view.tsx:176 一带）调用；message-list.tsx 消费渲染。
// B11 模型切换点分隔线已退役（2026-10-15 可见性缺口 ② 改为气泡头部常驻模型短名，
// 消息级 model 字段同源）：连续同模型段的盲区不复存在，分隔线冗余。
import type { WireEntry, WireMessage } from "@/lib/api";
import { memoryMarkerOf, type MemoryMarker } from "@/lib/memory-entries";

/** items 数组判别联合：entry=定格条目气泡；streaming=流式气泡；
 *  memoryMarker=记忆标记块（docs08-r4 任务 13，白名单 memory 条目派生）；
 *  customMessage=display=true 的 custom_message 占位行（docs08-r6 任务 10 ③，
 *  这类条目此前无渲染分支——入列却无内容可渲染即空壳路径） */
export type ChatListItem =
  | { key: string; kind: "entry"; entryId: string; interrupted: boolean }
  | { key: string; kind: "streaming" }
  | { key: string; kind: "memoryMarker"; marker: MemoryMarker }
  | { key: string; kind: "customMessage"; entryId: string };

/** message 载荷窄化（wire 形态从宽）：role 非字符串视为不可渲染条目跳过 */
function messageOf(entry: WireEntry & { id: string }): WireMessage | null {
  const msg = (entry as { message?: unknown }).message;
  if (msg === null || typeof msg !== "object") return null;
  return typeof (msg as WireMessage).role === "string" ? (msg as WireMessage) : null;
}

/** items 组装：toolResult 不单独入列（结果由 ToolCard 按 toolCallId 关联展示）；
 *  custom_message 条目按 display 分类（docs08-r6 任务 10 ③）；
 *  interrupted 标记挂最后一个 assistant 条目。 */
export function buildMessageItems(
  entries: ReadonlyArray<WireEntry & { id: string }>,
  opts: { hasStreamingMessage: boolean; interrupted: boolean },
): ChatListItem[] {
  let lastAssistantId: string | null = null;
  for (const e of entries) {
    if (messageOf(e)?.role === "assistant") lastAssistantId = e.id;
  }
  const list: ChatListItem[] = [];
  for (const e of entries) {
    // custom_message 分支（docs08-r6 任务 10 ③）：仅 display=true 入列渲染占位行
    // （task-3 枚举：18 种 customType 均无实物结构样本，禁猜字段，组件层只读 customType）；
    // display=false 引擎明示不展示，一律跳过——这类条目（库内 998 条）不得产生零内容
    // 气泡（空壳防线）；记忆标记条目已由 marker 通道渲染，此处跳过防双列。
    if (e.type === "custom_message") {
      if (e.display === true && memoryMarkerOf(e) === null) {
        list.push({ key: e.id, kind: "customMessage", entryId: e.id });
      }
      continue;
    }
    const msg = messageOf(e);
    if (!msg) continue;
    // toolResult 不单独入列：结果已由 ToolCard 按 toolCallId 关联展示（parts.tsx 同口径，
    // ToolResultLine 恒空）；入列只会渲染出带"助手+时间"头部的空壳行，每个工具调用
    // 多占一行死空间（任务 10 走查发现，390/1920 同样存在）。
    if (msg.role === "toolResult") continue;
    list.push({
      key: e.id,
      kind: "entry",
      entryId: e.id,
      interrupted: opts.interrupted && e.id === lastAssistantId,
    });
  }
    if (opts.hasStreamingMessage) list.push({ key: "__streaming", kind: "streaming" });
  return list;
}

/** 记忆标记并入 items（docs08-r4 任务 13）：白名单 memory 条目在其自身条目的流内位置
 *  （之后）插入 marker 项。items 顺序即 messageEntries 的顺序（buildMessageItems 保序），
 *  按 entries 下标归并即可；divider 锚点从 key 前缀还原，streaming 项无锚点恒最后。
 *  sessionBinding 按 identity 渲染去重（引擎每回合重写 binding 条目，同一 identity 只显示
 *  首次绑定）。无标记时原样返回（引用不变，订阅方不重算）。锚点不在 entries 的项
 *  （理论不发生）排最后、保序，防错位插队。 */
export function mergeMemoryItems(items: ChatListItem[], entries: readonly WireEntry[]): ChatListItem[] {
  const ordOf = new Map<string, number>();
  entries.forEach((e, i) => {
    if (typeof e.id === "string") ordOf.set(e.id, i);
  });
  const LAST = Number.MAX_SAFE_INTEGER;
  const seenBindings = new Set<string>();
  const markers: Array<{ ord: number; seq: number; item: ChatListItem }> = [];
  let seq = 0;
  for (const e of entries) {
    const marker = memoryMarkerOf(e);
    if (marker === null) continue;
    if (marker.dedupeKey !== undefined) {
      if (seenBindings.has(marker.dedupeKey)) continue;
      seenBindings.add(marker.dedupeKey);
    }
    markers.push({
      ord: ordOf.get(marker.entryId) ?? LAST,
      seq: seq++,
      item: { key: `memory-${marker.entryId}`, kind: "memoryMarker", marker },
    });
  }
  if (markers.length === 0) return items;
  const scored = markers.slice();
  for (const item of items) {
    const anchor = item.kind === "entry" ? item.entryId : null;
    const ord = anchor !== null ? (ordOf.get(anchor) ?? LAST) : LAST;
    scored.push({ ord, seq: seq++, item });
  }
  scored.sort((a, b) => a.ord - b.ord || a.seq - b.seq);
  return scored.map((s) => s.item);
}
