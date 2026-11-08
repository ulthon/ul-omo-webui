// 触顶同步执行器（#27a：从 chat-view onReachTop 抽出可注入逻辑，纯 node 可测）。
// 行为契约：
// - before 翻页不进冷却、不受冷却门住（R1：冷却只护 cursor 增量防抖）；
// - 锚失效（409 cursor_invalid）一律升级 full=1 全量整替并重置翻页锚
//   （R2：对齐 event-dispatch gap 路径 409→refetch，否则同锚重发死锁）。
import { ApiError } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { resolveReachTopAction } from "./reach-top";

/** 依赖注入面：chat-view 传真实 ref/api；测试传假 api 与假冷却窗 */
export interface ReachTopSyncDeps {
  listMessages: typeof import("@/lib/api").api.listMessages;
  /** 当前是否仍在 cursor 冷却窗内（epoch ms） */
  coolingDown: () => boolean;
  /** 请求开始（置 in-flight/syncing） */
  begin: () => void;
  /** 请求收尾：kind=cursor 时写新冷却窗，before 不写（R1） */
  finish: (kind: "before" | "cursor") => void;
}

export async function runReachTopSync(sessionId: string, deps: ReachTopSyncDeps): Promise<void> {
  const state = useMessagesStore.getState().bySession[sessionId];
  const action = resolveReachTopAction(state);
  if (!action) return;
  if (action.kind === "cursor" && deps.coolingDown()) return;
  deps.begin();
  try {
    const page = await deps.listMessages(
      sessionId,
      action.kind === "before" ? { before: action.before } : { cursor: action.cursor },
    );
    const store = useMessagesStore.getState();
    if (action.kind === "before") {
      store.prependEntries(sessionId, page.entries, {
        hasMore: page.hasMore ?? false,
        oldestId: page.oldestId ?? null,
      });
    } else {
      store.appendEntries(sessionId, page.entries);
      store.setCursor(sessionId, page.cursor);
    }
  } catch (err) {
    if (err instanceof ApiError && err.code === "cursor_invalid") {
      const page = await deps.listMessages(sessionId, { full: true });
      useMessagesStore
        .getState()
        .setEntries(sessionId, page.entries, page.cursor, page.leafId, {
          hasMore: page.hasMore ?? false,
          oldestId: page.oldestId ?? null,
        });
    }
  } finally {
    deps.finish(action.kind);
  }
}
