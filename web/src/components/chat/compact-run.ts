// /compact 执行与刷新协调（docs08-r5 任务 8）。composer 与斜杠命令下拉共用：
// 直调压缩端点 → 游标增量刷新消息 → 广播 usage 刷新（水位环/状态条重拉权威快照）。
// 错误不上捕获（原样上抛 ApiError），由调用方行内/toast 明示——失败保留输入语义在
// 调用方落地。
import { fmtInt, type MessageKey } from "@/i18n/i18n";
import { api } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import type { CompactReceipt } from "@/lib/api";

/** usage 刷新订阅（模块级轻量事件：压缩等非回合路径改变水位时广播） */
type UsageRefreshListener = () => void;
const usageListeners = new Set<UsageRefreshListener>();

export function onUsageRefresh(listener: UsageRefreshListener): () => void {
  usageListeners.add(listener);
  return () => {
    usageListeners.delete(listener);
  };
}

/** 广播 usage 刷新（docs08-r6 任务 18 ②）：手动压缩回执之外的第二发射点——
 *  compaction_end SSE 事件驱动（504 超时路径引擎侧仍在后台压缩，事件到达即重拉
 *  权威快照，水位环/状态条自动更新）；与 runCompact 成功路径共用同一订阅面。 */
export function broadcastUsageRefresh(): void {
  for (const listener of usageListeners) listener();
}

/**
 * 执行压缩并刷新消息/usage。消息刷新走游标增量（compaction 条目非 message 形态，
 * 渲染层过滤后列表视觉零变化；条目集与引擎状态保持一致）；usage 广播给订阅面
 * （context-ring / status-bar）重拉权威快照，水位环即时反映压缩效果。
 */
export async function runCompact(sessionId: string): Promise<CompactReceipt> {
  const receipt = await api.compactSession(sessionId);
  const cur = useMessagesStore.getState().bySession[sessionId];
  const cursor = cur?.loaded ? (cur.cursor ?? undefined) : undefined;
  try {
    const page = await api.listMessages(sessionId, cursor);
    const store = useMessagesStore.getState();
    if (cursor) {
      store.appendEntries(sessionId, page.entries);
      store.setCursor(sessionId, page.cursor);
    } else {
      store.setEntries(sessionId, page.entries, page.cursor, page.leafId);
    }
  } catch {
    // 消息刷新失败不阻塞压缩成功反馈（下次打开会话/触顶增量自然对齐）
  }
  broadcastUsageRefresh();
  return receipt;
}

/** 压缩结果 toast 词条（{key, vars} 纯数据，由组件侧 t() 渲染，任务10同模式） */
export interface CompactToast {
  key: MessageKey;
  vars: Record<string, unknown>;
}

/** 压缩结果 toast 词条：压缩前后水位对比（tokensAfter 缺省时用压缩后 usage 快照） */
export function compactToastText(receipt: CompactReceipt): CompactToast {
  const after = receipt.tokensAfter ?? receipt.usage.contextUsage?.tokens;
  // fmtInt 显式按当前 locale 千分位（任务12）：不用无参 toLocaleString() 依赖宿主环境
  const before = fmtInt(receipt.tokensBefore);
  return after !== undefined
    ? { key: "chat.compact.done", vars: { before, after: fmtInt(after) } }
    : { key: "chat.compact.doneBefore", vars: { before } };
}
