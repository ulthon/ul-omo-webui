// 排队条（docs08-r4 任务 11，spike 口径）：输入区上方细条"N 条待发"。
// 数据源 = queue store（queue_update 增量 + GET queue 对账 + 本端乐观占位）；
// 撤销按 spike 指引 3：引擎只有整队 clearQueue（无单条撤单协议面），单条撤销 =
// 前端自持列表 → 整队清空 → 保留项按序重新入队（enqueueOrder 保序）。
// 用户 abort 后队列保留但挂起（spike (b)-6 实测）：列表不清空，明示"将在下次发送时
// 执行"，另有一键清空（撤空的消息不会再投递，本地占位一并移除）。
import { useState } from "react";
import { ListOrdered, X } from "lucide-react";
import { api, type QueueItem } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { useQueueStore } from "@/stores/queue";
import { useUiStore } from "@/stores/ui";
import { t } from "@/i18n/i18n";

/** 单条撤销：整队清空 + 保留项重新入队 + 快照对账（不依赖事件回传时序） */
async function cancelQueuedItem(sessionId: string, target: QueueItem, items: QueueItem[]): Promise<void> {
  const retained = items.filter((item) => item !== target);
  await api.clearQueue(sessionId);
  // 重新入队显式只带 streamingBehavior（spike 铁律；api.prompt 对排队请求自动剥模型/思考档）
  for (const item of retained) {
    await api.prompt(sessionId, { text: item.text, streamingBehavior: item.mode });
  }
  const snapshot = await api.getQueue(sessionId);
  useQueueStore.getState().setSnapshot(sessionId, snapshot);
  useMessagesStore.getState().removeQueuedLocalEntry(sessionId, target.text);
}

export function QueueBar({ sessionId }: { sessionId: string }) {
  const items = useQueueStore((s) => s.bySession[sessionId]?.items);
  const streaming = useMessagesStore((s) => s.bySession[sessionId]?.streaming ?? false);
  const showToast = useUiStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const list = items ?? [];
  if (list.length === 0) return null;

  const run = (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    action()
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : t("chat.queue.cancelFailed"), "error");
      })
      .finally(() => setBusy(false));
  };

  return (
    <div data-testid="queue-bar" className="rounded-lg border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <ListOrdered className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 tabular-nums">{t("chat.queue.pendingCount", { n: list.length })}</span>
        {!streaming && (
          <span data-testid="queue-suspended-hint" className="min-w-0 truncate">
            {t("chat.queue.suspendedHint")}
          </span>
        )}
        <button
          type="button"
          data-testid="queue-clear"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api.clearQueue(sessionId);
              useQueueStore.getState().applyUpdate(sessionId, []);
              useMessagesStore.getState().removeAllQueuedLocalEntries(sessionId);
            })
          }
          className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {t("chat.queue.clear")}
        </button>
      </div>
      <ul className="mt-0.5 space-y-0.5">
        {list.map((item, index) => (
          <li key={item.enqueueOrder !== null ? `q${item.enqueueOrder}` : `p${index}`} data-testid="queue-item" className="flex items-center gap-1.5">
            <span
              data-testid="queue-item-mode"
              title={item.mode === "steer" ? t("chat.queue.steerTitle") : t("chat.queue.followTitle")}
              className="shrink-0 rounded-sm border bg-background px-1 py-px leading-4"
            >
              {item.mode === "steer" ? t("chat.queue.steer") : t("chat.queue.follow")}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.text}</span>
            <button
              type="button"
              data-testid="queue-item-cancel"
              aria-label={t("chat.queue.removeItem")}
              disabled={busy}
              onClick={() => run(() => cancelQueuedItem(sessionId, item, list))}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
