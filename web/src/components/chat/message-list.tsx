// 虚拟化消息列表（todo 16）：TanStack Virtual 动态测量（measureElement + ResizeObserver），
// 长会话手机端只挂载可视区。自动滚底不经 React：直接订阅 store，在底部时 rAF 跟随滚动；
// 用户上滚即暂停跟随并浮出"回到底部"。顶部触顶触发增量同步（游标分页钩子，ChatView 提供）。
// 记忆标记（docs08-r4 任务 13）：entries 中白名单 memory 条目经 mergeMemoryItems 并入 items，
// 标记块随虚拟化正常测量渲染。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, ArrowDown, Bell, BookOpen, ChevronDown, Database, Lightbulb, BookCheck, Pin } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMessagesStore } from "@/stores/messages";
import type { MemoryMarker, MemoryMarkerKind } from "@/lib/memory-entries";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/i18n";
import { mergeMemoryItems, shouldShowStickyUser, stickyUserOf, type ChatListItem, type CompactionMarker } from "./message-items";
import { CustomMessageBubble, EntryBubble, LoopGuardGroupBubble, StreamingBubble } from "./message-bubble";
import { TipCard } from "./tip-card";
import { NavRail } from "./nav-rail";

/** 记忆标记块（docs08-r4 任务 13）：图标 + 一句话摘要 + 点击展开原文；折叠时不渲染原文
 *  （惰性展开，不影响消息流渲染）。样式与 thinking 块同族更轻（无边框细行）；权重分级：
 *  weak 弱标记 / weakest 极弱（projection-pin）/ notice 提示卡（kibitzer/memorian/notice/recall）。 */
const MARKER_ICONS: Record<MemoryMarkerKind, LucideIcon> = {
  sessionBinding: Database,
  acceptedTurns: BookCheck,
  projectionPin: Pin,
  kibitzerNudged: Lightbulb,
  memorianNudged: Lightbulb,
  memoryNotice: Bell,
  memoryRecall: BookOpen,
};

const MARKER_TONE: Record<MemoryMarker["weight"], string> = {
  weak: "text-xs text-muted-foreground",
  weakest: "text-[11px] text-muted-foreground/60",
  notice: "text-xs text-foreground/80",
};

export const MemoryMarkerBlock = memo(function MemoryMarkerBlock({ marker }: { marker: MemoryMarker }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const Icon = MARKER_ICONS[marker.kind];
  return (
    <div data-testid="memory-marker" data-kind={marker.kind} data-weight={marker.weight} className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-muted lg:min-h-0 ${MARKER_TONE[marker.weight]}`}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{t(marker.summary.key, marker.summary.vars)}</span>
        {marker.detail !== "" && (
          <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        )}
      </button>
      {open && marker.detail !== "" && (
        <div className="mt-0.5 max-h-48 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
          {marker.detail}
        </div>
      )}
    </div>
  );
});

/** 压缩摘要标记块（docs08-r6 任务 18 ③）：Archive 图标 +「上下文已压缩：摘要首行」
 *  常显，点击展开原文（summary 全文 + details JSON，details 缺失时仅全文）；
 *  tokensBefore 存在时尾部带压缩前水位。样式与记忆标记同族（weak 弱标记）。 */
export const CompactionMarkerBlock = memo(function CompactionMarkerBlock({ marker }: { marker: CompactionMarker }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  return (
    <div data-testid="compaction-marker" className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-muted lg:min-h-0 text-xs text-muted-foreground"
      >
        <Archive className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{t("chat.compact.marker", { summary: marker.summaryFirstLine })}</span>
        {marker.detail !== "" && (
          <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        )}
      </button>
      {open && marker.detail !== "" && (
        <div className="mt-0.5 max-h-48 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
          {marker.detail}
        </div>
      )}
    </div>
  );
});

const Row = memo(function Row({ item, sessionId }: { item: ChatListItem; sessionId: string }) {
  if (item.kind === "streaming") return <StreamingBubble sessionId={sessionId} />;
  if (item.kind === "memoryMarker") return <MemoryMarkerBlock marker={item.marker} />;
  if (item.kind === "customMessage") return <CustomMessageBubble sessionId={sessionId} entryId={item.entryId} />;
  if (item.kind === "loopGuardGroup")
    return <LoopGuardGroupBubble sessionId={sessionId} loopGuardKind={item.loopGuardKind} entryIds={item.entryIds} />;
  if (item.kind === "compactionMarker") return <CompactionMarkerBlock marker={item.marker} />;
  return <EntryBubble sessionId={sessionId} entryId={item.entryId} interrupted={item.interrupted} model={item.model} />;
});

/** 距底部小于该值视为"在底部"（跟随流式内容增长） */
const BOTTOM_THRESHOLD = 80;

/** 滚动容器 py-4 顶垫（粘性判定把测量缓存偏移换算到视口坐标用） */
const STICKY_TOP_PAD = 16;

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

  // 白名单 memory 条目与 compaction 条目并入 items（docs08-r4 任务 13 / 任务 18 ③）：
  // entries 引用不变（流式 delta 只动 streamingMessage）时 memo 不重算，无标记会话
  // mergeMemoryItems 原样返回不建数组
  const entries = useMessagesStore((s) => s.bySession[sessionId]?.entries);
  const mergedItems = useMemo(() => mergeMemoryItems(items, entries ?? []), [items, entries]);
  // 压缩进行态（docs08-r6 任务 18 ①）：compaction_start/progress 置位、end 消除
  // （帧丢失由 store 兑底回落），消息流顶部浮条呈现
  const compacting = useMessagesStore((s) => s.bySession[sessionId]?.compacting ?? false);

  // 粘性用户条（docs08-r7 任务 11）：虚拟化行绝对定位，纯 CSS sticky 不可行；判定复用
  // 既有 scroll 通道（不新增监听），几何用 TanStack 测量缓存（窗外行可判，同 NavRail）。
  // 回底消失：atBottom 恒隐藏，回底钮滚底后随之消失。值只在翻转时写入（cand 引用稳定）。
  const [stickyUser, setStickyUser] = useState<{ key: string; text: string } | null>(null);
  const stickyCandidate = useMemo(() => stickyUserOf(mergedItems, entries ?? []), [mergedItems, entries]);

  const virtualizer = useVirtualizer({
    count: mergedItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 6,
    getItemKey: (index) => mergedItems[index].key,
  });

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    if (!smooth) return;
    // 平滑滚动途中与落底后,虚拟化行测量都可能增长总高使点击时目标失效,落点未到底
    // (docs08-r7 任务 11 回底打磨;手机档实测涨约 239px):2s 窗口内每 300ms 校验,
    // 仍在底部阈值外则补瞬时对底;用户主动上滚(位置回退>50px)即退出不抢滚动。
    // 非 smooth 路径(会话打开两段式)不变。
    let lastTop = -1;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const el2 = scrollRef.current;
      if (!el2 || Date.now() - started > 2000) {
        window.clearInterval(timer);
        return;
      }
      const top = el2.scrollTop;
      if (lastTop >= 0 && top < lastTop - 50) {
        window.clearInterval(timer);
        return;
      }
      lastTop = top;
      if (el2.scrollHeight - top - el2.clientHeight > BOTTOM_THRESHOLD) {
        el2.scrollTo({ top: el2.scrollHeight, behavior: "auto" });
      } else {
        window.clearInterval(timer);
      }
    }, 300);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance < BOTTOM_THRESHOLD;
    followRef.current = atBottom;
    setShowJump(!atBottom);
    // 粘性用户条：回底消失；最近 user 气泡完整滚出视口（任一侧）时钉摘要于消息区顶
    const cand = stickyCandidate;
    const m = cand ? virtualizer.measurementsCache[cand.index] : undefined;
    if (cand && m) {
      const rowTop = STICKY_TOP_PAD + m.start - el.scrollTop;
      const rowBottom = rowTop + m.size;
      setStickyUser(shouldShowStickyUser(atBottom, rowTop, rowBottom, 0, el.clientHeight) ? cand : null);
    } else {
      setStickyUser(null);
    }
    if (el.scrollTop < BOTTOM_THRESHOLD) onReachTop();
  }, [onReachTop, stickyCandidate, virtualizer]);

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
  const t = useT();
  const hasItems = mergedItems.length > 0;
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
        {mergedItems.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-sm text-muted-foreground">
            <p>{t("chat.messageList.empty")}</p>
            {/* 空态用法提示卡（docs08 2026-10-22 批次任务 25）：开关关/已关/无数据时自隐藏 */}
            <TipCard />
          </div>
        ) : (
          <div className="relative mx-auto max-w-3xl" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((vi) => (
              <div
                key={vi.key}
                data-index={vi.index}
                data-entry-key={mergedItems[vi.index].key}
                ref={virtualizer.measureElement}
                className="w-full pb-3"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <Row item={mergedItems[vi.index]} sessionId={sessionId} />
              </div>
            ))}
          </div>
        )}
      </div>

      <NavRail items={mergedItems} sessionId={sessionId} scrollRef={scrollRef} virtualizer={virtualizer} />

      {(syncing || compacting) && (
        <div className={`pointer-events-none absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-1 ${stickyUser ? "top-10" : "top-2"}`}>
          {compacting && (
            <div
              data-testid="compacting-banner"
              className="rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm"
            >
              {t("chat.compact.ongoing")}
            </div>
          )}
          {syncing && (
            <div className="rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm">
              {t("chat.messageList.syncing")}
            </div>
          )}
        </div>
      )}

      {stickyUser && (
        <div
          data-testid="sticky-user-message"
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 flex justify-center px-3 pt-2"
        >
          <div className="max-w-full truncate rounded-full bg-primary px-3.5 py-1.5 text-xs text-primary-foreground shadow-md">
            {stickyUser.text}
          </div>
        </div>
      )}

      {showJump && mergedItems.length > 0 && (
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
          {t("chat.messageList.jumpToBottom")}
        </Button>
      )}
    </div>
  );
}
