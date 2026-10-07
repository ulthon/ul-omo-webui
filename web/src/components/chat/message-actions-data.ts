// 消息级操作纯助手（todo 25）：气泡原文提取与 fork 重试目标定位。
import type { WireEntry, WireMessage } from "@/lib/api";

/** 气泡消息的 markdown 原文：text part 按序拼接（thinking/toolCall/image 等 part 不算原文） */
export function messageRawText(message: WireMessage): string {
  const parts = Array.isArray(message.content) ? message.content : [];
  const texts = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string);
  return texts.join("\n\n");
}

/** 条目的消息角色（双形态兼容：GET 定格 type="message"，SSE 实时 message_start/message_end） */
export function entryRole(entry: WireEntry | undefined): string | null {
  const msg = entry?.message as WireMessage | undefined;
  return typeof msg?.role === "string" ? msg.role : null;
}

/**
 * fork 重试目标：重试 = 从触发回复的那条 user 消息重新生成分支。
 * role=user 取自身；role=assistant 就近向前找最近一条 user 条目。
 * 引擎 fork position="before" 仅接受 user 消息条目（agent-session-runtime 实证语义），
 * 找不到返回 null（入口禁用）。
 */
export function findForkTargetEntry(entries: WireEntry[], entryId: string, role: string): WireEntry | null {
  if (role === "user") {
    const self = entries.find((e) => e.id === entryId);
    return self ?? null;
  }
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx < 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (entryRole(entries[i]) === "user" && entries[i].id) return entries[i];
  }
  return null;
}
