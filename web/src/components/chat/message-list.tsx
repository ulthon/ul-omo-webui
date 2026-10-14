// 虚拟化消息列表（todo 16）：TanStack Virtual 动态测量（measureElement + ResizeObserver），
// 长会话手机端只挂载可视区。自动滚底不经 React：直接订阅 store，在底部时 rAF 跟随滚动；
// 用户上滚即暂停跟随并浮出"回到底部"。顶部触顶触发增量同步（游标分页钩子，ChatView 提供）。
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { useMessagesStore } from "@/stores/messages";
import { Button } from "@/components/ui/button";
import type { ChatListItem } from "./message-items";
import { EntryBubble, StreamingBubble } from "./message-bubble";
import { NavRail } from "./nav-rail";

/** 模型切换点标记（B11）：居中细分隔线 + muted 模型名；仅在 assistant 段 model 变化处出现 */
export const ModelDivider = memo(function ModelDivider({ model }: { model: string }) {
  return (
    <div data-testid="model-divider" data-model={model} aria-label={`模型 ${model}`} className="flex items-center gap-3 py-0.5">
      <span className="h-px min-w-0 flex-1 bg-border" aria-hidden />
      <span className="shrink-0 text-xs text-muted-foreground">{model}</span>
      <span className="h-px min-w-0 flex-1 bg-border" aria-hidden />
    </div>
  );
});

const Row = memo(function Row({ item, sessionId }: { item: ChatListItem; sessionId: string }) {
  if (item.kind === "streaming") return <StreamingBubble sessionId={sessionId} />;
  if (item.kind === "modelDivider") return <ModelDivider model={item.model} />;
  return <EntryBubble sessionId={sessionId} entryId={item.entryId} interrupted={item.interrupted} />;
});

/** 距底部小于该值视为"在底部"（跟随流式内容增长） */
const BOTTOM_THRESHOLD = 80;

export function MessageList({
  items,
  sessionId,
  syncing,
  onReachTop,
}: {
  items: ChatListItem[];
  sessionId: string;
  syncing: boolean;
  onReachTop: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 6,
    getItemKey: (index) => items[index].key,
  });

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance < BOTTOM_THRESHOLD;
    followRef.current = atBottom;
    setShowJump(!atBottom);
    if (el.scrollTop < BOTTOM_THRESHOLD) onReachTop();
  }, [onReachTop]);

  // 自动跟随：store 任意变化（delta/新条目）且用户在底部 → rAF 滚底，不经 React 渲染路径
  useEffect(() => {
    let raf = 0;
    const unsub = useMessagesStore.subscribe(() => {
      if (!followRef.current || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (followRef.current) scrollToBottom();
      });
    });
    return () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollToBottom]);

  // 打开会话 / 从空到有内容：定位到底部（测量异步完成，两段式补齐）
  const hasItems = items.length > 0;
  useEffect(() => {
    if (!hasItems) return;
    const raf = requestAnimationFrame(() => {
      scrollToBottom();
      window.setTimeout(() => scrollToBottom(), 100);
    });
    return () => cancelAnimationFrame(raf);
  }, [hasItems, scrollToBottom]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="chat-scroll"
        className="h-full overflow-y-auto overscroll-contain px-3 py-4 sm:px-4"
      >
        {items.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            暂无消息，发送第一条消息开始对话
          </div>
        ) : (
          <div className="relative mx-auto max-w-3xl" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((vi) => (
              <div
                key={vi.key}
                data-index={vi.index}
                data-entry-key={items[vi.index].key}
                ref={virtualizer.measureElement}
                className="w-full pb-3"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <Row item={items[vi.index]} sessionId={sessionId} />
              </div>
            ))}
          </div>
        )}
      </div>

      <NavRail items={items} sessionId={sessionId} scrollRef={scrollRef} virtualizer={virtualizer} />

      {syncing && (
        <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm">
          同步历史…
        </div>
      )}

      {showJump && items.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          data-testid="jump-bottom"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-md"
          onClick={() => {
            followRef.current = true;
            setShowJump(false);
            scrollToBottom(true);
          }}
        >
          <ArrowDown className="size-3.5" />
          回到底部
        </Button>
      )}
    </div>
  );
}
