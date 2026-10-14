// 右缘对话导航轨（A7，docs08-r3 任务 16）：刻度 = 用户输入条目，位置按 TanStack Virtual
// 测量缓存 measurementsCache 的 itemStart/totalSize 比例定位（未测量条目取 estimateSize
// 估值，滚动测量精化后随重渲染自动跟随——只读内存测量缓存，不做全量 DOM 测量，不破坏虚拟化）。
// 点击刻度 scrollToOffset 定位 + 目标气泡 1.5s 一次性高亮（data 属性 + index.css 动画）；
// 悬停 title 显示前 40 字预览。视口指示块按 scrollTop..scrollTop+clientHeight 区间映射，
// rAF 节流直写 style（不进 React 渲染路径，同自动滚底订阅范式）。hidden lg:flex 手机不显示；
// 不替代原生滚动条（容器 pointer-events-none，刻度按钮才可点，间隙点击穿透给滚动条）。
import { useEffect, useMemo, useRef } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useMessagesStore } from "@/stores/messages";
import type { WireMessage } from "@/lib/api";
import type { ChatListItem } from "./message-items";

/** 导航刻度：items 数组中的下标（查测量缓存用）+ 行 key（高亮定位用）+ 悬停预览 */
interface NavTick {
  key: string;
  index: number;
  title: string;
}

/** 用户消息首个 text part 的前 40 字（悬停预览）；纯图/空文本消息返回 null 不刻画度 */
function previewText(msg: WireMessage): string | null {
  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
      const text = part.text.trim();
      return text.length > 40 ? `${text.slice(0, 40)}…` : text;
    }
  }
  return null;
}

export function NavRail({
  items,
  sessionId,
  scrollRef,
  virtualizer,
}: {
  items: ChatListItem[];
  sessionId: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<{ el: HTMLElement; timer: number } | null>(null);

  // 刻度集合：items 里 kind==="entry" 且 store 条目 role==="user" 的项。items 身份随 entries
  // 任何变化而重建（chat-view useMemo），这里非响应式读 store 快照即可覆盖新增/换 id 场景。
  const ticks = useMemo<NavTick[]>(() => {
    const entries = useMessagesStore.getState().bySession[sessionId]?.entries ?? [];
    const byId = new Map<string, WireMessage>();
    for (const e of entries) {
      const msg = e.message as WireMessage | undefined;
      if (typeof e.id === "string" && msg) byId.set(e.id, msg);
    }
    const list: NavTick[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "entry") continue; // streaming / modelDivider 不刻画度
      const msg = byId.get(item.entryId);
      if (!msg || msg.role !== "user") continue; // assistant / toolResult 不刻画度
      const title = previewText(msg);
      if (title === null) continue;
      list.push({ key: item.key, index: i, title });
    }
    return list;
  }, [items, sessionId]);

  // 视口指示块：scroll 事件 rAF 节流后直写 transform/height；rail 尺寸变化（窗口改宽高）
  // 经 ResizeObserver 走同一路径。deps 带 ticks.length：空→有刻度翻转时 refs 才挂上，需重挂监听。
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const railEl = railRef.current;
    const indicator = indicatorRef.current;
    if (!scrollEl || !railEl || !indicator) return;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const total = virtualizer.getTotalSize();
      const railH = railEl.clientHeight;
      if (total <= 0 || railH <= 0) return;
      const ratio = railH / total;
      const height = Math.max(12, Math.min(scrollEl.clientHeight * ratio, railH));
      const top = Math.max(0, Math.min(scrollEl.scrollTop * ratio, railH - height));
      indicator.style.transform = `translateY(${top}px)`;
      indicator.style.height = `${height}px`;
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(paint);
    };
    paint();
    scrollEl.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(railEl);
    return () => {
      scrollEl.removeEventListener("scroll", schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [virtualizer, scrollRef, ticks.length]);

  // 点击刻度：定位到该条目起点（测量缓存 itemStart，未测量项为估值，落点随精化收敛）+
  // 目标行 1.5s 一次性高亮。跳转后虚拟行由 virtualizer 异步重挂（scroll 事件不随 scrollTop
  // 赋值同步），rAF 轮询至多 20 帧等目标行出现在 DOM 再点亮；连点先清上一次（不留悬挂定时器）。
  const onTickClick = (tick: NavTick) => {
    const m = virtualizer.measurementsCache[tick.index];
    if (m) virtualizer.scrollToOffset(m.start, { align: "start" });
    let tries = 0;
    const tryHighlight = () => {
      tries++;
      const el = scrollRef.current?.querySelector<HTMLElement>(
        `[data-entry-key="${CSS.escape(tick.key)}"]`,
      );
      if (el) {
        const prev = highlightRef.current;
        if (prev) {
          window.clearTimeout(prev.timer);
          delete prev.el.dataset.navHighlight;
        }
        el.dataset.navHighlight = "";
        highlightRef.current = {
          el,
          timer: window.setTimeout(() => {
            delete el.dataset.navHighlight;
            highlightRef.current = null;
          }, 1600),
        };
        return;
      }
      if (tries < 20) requestAnimationFrame(tryHighlight);
    };
    tryHighlight();
  };

  if (ticks.length === 0) return null;

  const totalSize = virtualizer.getTotalSize();
  const measurements = virtualizer.measurementsCache;
  return (
    <div
      ref={railRef}
      data-testid="nav-rail"
      className="pointer-events-none absolute inset-y-1 right-0 hidden w-3.5 lg:flex"
    >
      <div
        ref={indicatorRef}
        data-testid="nav-rail-viewport"
        aria-hidden
        className="absolute inset-x-0 top-0 rounded-full bg-border/70"
        style={{ height: 12, willChange: "transform" }}
      />
      {ticks.map((tick) => {
        const m = measurements[tick.index];
        if (!m || totalSize <= 0) return null;
        return (
          <button
            key={tick.key}
            type="button"
            data-testid="nav-rail-tick"
            title={tick.title}
            aria-label={`跳转到：${tick.title}`}
            onClick={() => onTickClick(tick)}
            className="pointer-events-auto absolute right-0.5 h-1.5 w-2 -translate-y-1/2 rounded-full bg-border transition-colors hover:bg-primary"
            style={{ top: `${(m.start / totalSize) * 100}%` }}
          />
        );
      })}
    </div>
  );
}
