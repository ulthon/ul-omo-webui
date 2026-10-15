// 消息流 items 组装纯逻辑（B11 模型切换点标记，docs08-r3 任务 15）：
// 从 message-list.tsx 拆出（组件文件只导组件，fast-refresh 约束；同 composer-logic 惯例）。
// chat-view.tsx 组装 items（chat-view.tsx:176 一带）调用；message-list.tsx 消费渲染。
import { messageModel } from "@/lib/api";
import type { WireEntry, WireMessage } from "@/lib/api";

/** items 数组判别联合：entry=定格条目气泡；streaming=流式气泡；modelDivider=模型切换点标记 */
export type ChatListItem =
  | { key: string; kind: "entry"; entryId: string; interrupted: boolean }
  | { key: string; kind: "streaming" }
  | { key: string; kind: "modelDivider"; model: string };

/** items 组装（B11 模型切换点标记）：assistant 条目与前一 assistant 条目的 message.model
 * 不同（含首条 assistant）时在其前插 modelDivider 标记项；divider 是 items 数组的一项，
 * 随 TanStack Virtual 正常测量渲染。无 model 字段（老数据）不显示也不更新比较基线；
 * 流式气泡项永不带标记（settle 落入 entries 后按最终 message.model 补记），流式期间无抖动。 */
export function buildMessageItems(
  entries: ReadonlyArray<WireEntry & { id: string; message: WireMessage }>,
  opts: { hasStreamingMessage: boolean; interrupted: boolean },
): ChatListItem[] {
  let lastAssistantId: string | null = null;
  for (const e of entries) {
    if (e.message.role === "assistant") lastAssistantId = e.id;
  }
  let lastModel: string | null = null;
  let sawModel = false;
  const list: ChatListItem[] = [];
  for (const e of entries) {
    // toolResult 不单独入列：结果已由 ToolCard 按 toolCallId 关联展示（parts.tsx 同口径，
    // ToolResultLine 恒空）；入列只会渲染出带"助手+时间"头部的空壳行，每个工具调用
    // 多占一行死空间（任务 10 走查发现，390/1920 同样存在）。
    if (e.message.role === "toolResult") continue;
    if (e.message.role === "assistant") {
      const model = messageModel(e);
      if (model !== null && (!sawModel || model !== lastModel)) {
        list.push({ key: `model-${e.id}`, kind: "modelDivider", model });
      }
      if (model !== null) {
        lastModel = model;
        sawModel = true;
      }
    }
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
