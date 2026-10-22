// 排队条（docs08-r4 任务 11；docs08-r7 任务 15 单显示源与双操作）：
// 数据源 = queue store（服务端 queueList 真相：queue_update 增量 + GET queue 快照对账
// + 本端乐观占位）。消息流零排队占位——引擎接受（user 帧投递）才入流，条目只在此。
// 每条两操作：立即发送（转 steer 注入，下一循环边界即读取，余项保持排队）与单条撤销；
// 引擎只有整队 clearQueue 协议面，两操作都走"清空→重排→快照对账"（queue-actions.ts），
// 清空→重入队窗口期新排队条目合并按序不丢（agent_settled 竞态同守卫）。
// 用户 abort 后队列保留但挂起（spike (b)-6 实测）：列表不清空，明示"将在下次发送时
// 执行"，另有整队清空（撤空的消息不会再投递）。
import { useState } from "react";
import { ListOrdered, SendHorizontal, X } from "lucide-react";
import { api } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { useQueueStore } from "@/stores/queue";
import { useUiStore } from "@/stores/ui";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { restructureQueue } from "@/components/chat/queue-actions";

export function QueueBar({ sessionId }: { sessionId: string }) {
  const items = useQueueStore((s) => s.bySession[sessionId]?.items);
  const streaming = useMessagesStore((s) => s.bySession[sessionId]?.streaming ?? false);
  const showToast = useUiStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const t = useT();
  const list = items ?? [];
  if (list.length === 0) return null;

  const run = (action: () => Promise<void>, failKey: "chat.queue.cancelFailed" | "chat.queue.sendNowFailed") => {
    if (busy) return;
    setBusy(true);
    action()
      .catch((err: unknown) => {
        showToast(apiErrorMessage(err, failKey), "error");
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
            }, "chat.queue.cancelFailed")
          }
          className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {t("chat.queue.clear")}
        </button>
      </div>
      <ul className="mt-0.5 space-y-0.5">
        {list.map((item, index) => (
          <li key={item.enqueueOrder !== null ? `q${item.enqueueOrder}` : `p${index}`} data-testid="queue-item" className="flex items-center gap-1.5">
            {/* 忙碌波形（docs08-r7 任务 13）：待发条目左侧三竖线波形，busy-wave 级差 150ms；
                reduced-motion 降为等高三竖线静态可辨 */}
            <span data-testid="queue-item-wave" className="flex h-3.5 shrink-0 items-center gap-0.5" aria-hidden>
              <span className="busy-wave-bar h-3 w-0.5 rounded-full bg-current" />
              <span className="busy-wave-bar h-3 w-0.5 rounded-full bg-current" />
              <span className="busy-wave-bar h-3 w-0.5 rounded-full bg-current" />
            </span>
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
              data-testid="queue-item-send-now"
              aria-label={t("chat.queue.sendNowItem")}
              title={t("chat.queue.sendNowTitle")}
              disabled={busy}
              onClick={() => run(() => restructureQueue(sessionId, list, item, true), "chat.queue.sendNowFailed")}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <SendHorizontal className="size-3.5" />
            </button>
            <button
              type="button"
              data-testid="queue-item-remove"
              aria-label={t("chat.queue.removeItem")}
              disabled={busy}
              onClick={() => run(() => restructureQueue(sessionId, list, item, false), "chat.queue.cancelFailed")}
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
