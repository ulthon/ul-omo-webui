// 右缘对话导航轨（A7，docs08-r3 任务 16）：openchamber 同款分段指示器——用户刻度按
// 自然日聚合成段（nav-rail-segments.ts 纯逻辑），段高 ∝ 段内用户消息量（flex 比例分
// 配，最小可点高 12px），段日期标签进悬停弹卡（受控显隐沿用原浮卡：进入即显、移出
// 100ms 内隐藏，弹卡自身悬停续期供「加载更早」钮点按）。刻度仍按 TanStack Virtual
// 测量缓存 itemStart/totalSize 比例定位（只读内存测量缓存，不破坏虚拟化）。点击刻度
// 定位到该条 + 目标行 1.5s 一次性高亮（data 属性 + index.css 动画，沿用）；点击段定
// 位到段首条——段不完整（首段且窗外还有更早历史）时先经 messages store 的
// fetchEarlierPage（backfillModelTimeline 同款 fetchPage 注入翻页通道）按 before 游标
//（store 最旧 id，同触顶翻页通道）逐窗回溯取到该段日界证据再落位，定位中段内显示
// spinner（弹卡头部「定位中」）。弹卡显示该段最近用户消息（时间 + 60 字单行摘要，默
// 认 3 条，「加载更早」一次 10 条，无更多时隐藏）。视口指示块按
// scrollTop..scrollTop+clientHeight 区间映射，rAF 节流直写 style（不进 React 渲染路
// 径，同自动滚底订阅范式）。hidden lg:flex 手机不显示（触屏无悬停，段/刻度点按即跳）；
// 不替代原生滚动条（容器 pointer-events-none，段/刻度按钮才可点，段间隙点击穿透）。
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { MessagesPage } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { useLocaleStore, useT } from "@/i18n/i18n";
import { NavRailSegmentCard } from "./nav-rail-segment-card";
import { buildSegments, buildTicks, dayKeyOf, type NavSegmentSpec, type NavTick } from "./nav-rail-segments";
import { useNavRailHover } from "./use-nav-rail-hover";
import { useNavRailJump } from "./use-nav-rail-jump";
import type { ChatListItem } from "./message-items";

/** 弹卡默认展示的段内最近用户消息条数 */
const CARD_INITIAL_ROWS = 3;

/** 「加载更早」一次展开的条数 */
const CARD_MORE_STEP = 10;

/** 段落位回溯翻页安全闸（正常 1-2 窗即越过日界；防异常服务端分页无限循环） */
const MAX_BACKFILL_PAGES = 50;

export function NavRail({
  items,
  sessionId,
  scrollRef,
  virtualizer,
  fetchPage,
}: {
  items: ChatListItem[];
  sessionId: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** 翻页注入面（backfillModelTimeline 同款）：段回溯与「加载更早」共用，测试传桩免 mock api 模块 */
  fetchPage: (opts: { before?: string; full?: boolean }) => Promise<MessagesPage>;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);

  // items 最新引用：段回溯取数是异步流，落位时按提交后的 items 重找段首下标
  //（commit 后同步写入，回溯续体在读之前必已经过至少一次 commit）
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // 悬停弹卡：受控显隐状态机抽离至 use-nav-rail-hover（进入即显、移出 100ms 内隐藏、
  // 弹卡悬停续期、翻页展开数随段切换重置）
  const { hover, pages, setPages, openCard, closeCardSoon, clearHideTimer, cardTopFromEvent } =
    useNavRailHover(railRef);
  const [locating, setLocating] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const t = useT();
  // 刻度集合：items 里 kind==="entry" 且 store 条目 role==="user" 的项（纯逻辑见
  // buildTicks）。items 身份随 entries 任何变化而重建（chat-view useMemo），store 条目
  // 快照非响应式读即可覆盖新增/换 id 场景。
  const ticks = useMemo<NavTick[]>(() => {
    const entries = useMessagesStore.getState().bySession[sessionId]?.entries ?? [];
    return buildTicks(items, entries);
  }, [items, sessionId]);

  // 段聚合：按自然日分组（buildSegments 纯逻辑），段高权重 = 段内用户消息数。
  // now 取渲染时刻（标签只需日粒度；跨日陈旧随下一次 entries 变化自愈），与刻度的
  // 非响应式 store 快照读同一风类。
  const segments = useMemo<NavSegmentSpec[]>(
    () =>
      buildSegments(ticks, {
        hasMore: useMessagesStore.getState().bySession[sessionId]?.hasMore ?? false,
        now: Date.now(),
        locale: useLocaleStore.getState().locale,
        labels: { today: t("chat.navRail.today"), yesterday: t("chat.navRail.yesterday") },
      }),
    [ticks, sessionId, t],
  );

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

  // 定位与高亮抽离至 use-nav-rail-jump（刻度点击与段落位共用）
  const jumpToKey = useNavRailJump(scrollRef, virtualizer);

  // 点击段：完整段直接落位段首；不完整段（首段且窗外还有更早历史）先按 before 游标
  //（store 最旧 id，同触顶翻页通道）逐窗回溯，直到窗顶越过本日日界或历史取尽，再按提
  // 交后的 items 重找段首下标落位（行 key 即条目 id 跨重排稳定；取数合并是 store 流，
  // React 提交滞后一拍，等一帧后读 itemsRef）。回溯失败与触顶翻页同口径静默（段保持
  // 原位可重试）；定位中忽略重复点击。
  const onSegmentClick = (seg: NavSegmentSpec) => {
    if (seg.complete) {
      jumpToKey(seg.firstKey, seg.firstIndex);
      return;
    }
    if (locating !== null) return;
    setLocating(seg.key);
    const run = async () => {
      for (let i = 0; i < MAX_BACKFILL_PAGES; i++) {
        const st = useMessagesStore.getState().bySession[sessionId];
        if (!st?.hasMore || st.oldestId === null) break;
        await useMessagesStore.getState().fetchEarlierPage(sessionId, st.oldestId, fetchPage);
        const next = useMessagesStore.getState().bySession[sessionId];
        const oldestDay = next ? dayKeyOf(next.entries[0]?.timestamp) : null;
        if (!next?.hasMore || (oldestDay !== null && oldestDay !== seg.key)) break;
      }
      // 等一帧让 prependEntries 触发的重排提交，再按最新 items 落位
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const entries = useMessagesStore.getState().bySession[sessionId]?.entries ?? [];
      const fresh = buildTicks(itemsRef.current, entries);
      const idx = fresh.findIndex((tk) => tk.key === seg.firstKey);
      if (idx >= 0) jumpToKey(seg.firstKey, idx);
    };
    run()
      .catch(() => {
        // 回溯失败静默（软增强，不打断浏览；定位态已由 finally 复位）
      })
      .finally(() => setLocating(null));
  };

  // 弹卡行数：「加载更早」每次展开 CARD_MORE_STEP 条，钳在段内已加载行数
  const shownCount = (seg: NavSegmentSpec) =>
    Math.min(seg.rows.length, CARD_INITIAL_ROWS + pages * CARD_MORE_STEP);
  // 还能加载更早：本地有余量，或段不完整（首段且窗外可能有该日更早条目）
  const canMore = (seg: NavSegmentSpec) => shownCount(seg) < seg.rows.length || !seg.complete;

  // 「加载更早」：先展开本地已加载的更早消息（一次 10 条）；本地余量取尽且段不完整时
  // 经 fetchEarlierPage 按 before 游标（store 最旧 id）取一窗并入（段行随 store 重算）
  // 再展开。取数失败静默（钮由 finally 复位可重试，页数不前跳）。
  const onCardMore = (seg: NavSegmentSpec) => {
    if (loadingMore) return;
    if (shownCount(seg) < seg.rows.length) {
      setPages((n) => n + 1);
      return;
    }
    setLoadingMore(true);
    const run = async () => {
      const st = useMessagesStore.getState().bySession[sessionId];
      if (st?.hasMore && st.oldestId !== null) {
        await useMessagesStore.getState().fetchEarlierPage(sessionId, st.oldestId, fetchPage);
      }
      setPages((n) => n + 1);
    };
    run()
      .catch(() => {
        // 取数失败静默（软增强；loadingMore 已由 finally 复位，钮可重试）
      })
      .finally(() => setLoadingMore(false));
  };

  // 刻度所属段：正常按日键命中；无效日键并入段的场合（刻度 dayKey 为 "" 而段键为真实
  // 日）按行 key 回查（rows 即本段刻度清单）
  const segOfTick = (tick: NavTick): NavSegmentSpec | null => {
    const byDay = segments.find((s) => s.key === tick.dayKey);
    if (byDay) return byDay;
    return segments.find((s) => s.rows.some((r) => r.key === tick.key)) ?? null;
  };
  const onTickEnter = (tick: NavTick, ev: React.MouseEvent<HTMLButtonElement>) => {
    const seg = segOfTick(tick);
    if (seg) openCard(seg.key, cardTopFromEvent(ev));
  };

  if (ticks.length === 0 || segments.length === 0) return null;

  const totalSize = virtualizer.getTotalSize();
  const measurements = virtualizer.measurementsCache;
  const hoverSeg = hover !== null ? (segments.find((s) => s.key === hover.segKey) ?? null) : null;

  return (
    <div
      ref={railRef}
      data-testid="nav-rail"
      className="pointer-events-none absolute inset-y-1 right-0 hidden w-3.5 lg:flex"
    >
      {/* 段层：段高按段内用户消息量 flex 比例分配（flexBasis 0 + minHeight 12px 托底），
          段间 my-px 间隙点击穿透给滚动条；点段=定位段首（不完整段先回溯取数） */}
      <div className="absolute inset-y-0 left-0 right-0 flex flex-col">
        {segments.map((seg) => (
          <button
            key={seg.key}
            type="button"
            data-testid="nav-rail-segment"
            aria-label={t("chat.navRail.jumpTo", { title: seg.label })}
            aria-busy={locating === seg.key || undefined}
            data-loading={locating === seg.key || undefined}
            onClick={() => onSegmentClick(seg)}
            onMouseEnter={(ev) => openCard(seg.key, cardTopFromEvent(ev))}
            onMouseLeave={closeCardSoon}
            className="pointer-events-auto relative my-px rounded-full transition-colors hover:bg-border/60"
            style={{ flexGrow: seg.count, flexBasis: 0, minHeight: 12 }}
          >
            <span aria-hidden className="absolute inset-y-0 left-0.5 right-0.5 rounded-full bg-border/50" />
            {locating === seg.key && (
              <Loader2
                aria-hidden
                className="absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 animate-spin text-primary"
              />
            )}
          </button>
        ))}
      </div>
      {/* 视口指示块：段层之上（后声明后绘制），按 scrollTop 区间映射 */}
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
            aria-label={t("chat.navRail.jumpTo", { title: tick.title })}
            onClick={() => jumpToKey(tick.key, tick.index)}
            onMouseEnter={(ev) => onTickEnter(tick, ev)}
            onMouseLeave={closeCardSoon}
            className="pointer-events-auto absolute right-0.5 z-10 h-1.5 w-2 -translate-y-1/2 rounded-full bg-border transition-colors hover:bg-primary"
            style={{ top: `${(m.start / totalSize) * 100}%` }}
          />
        );
      })}
      {hover !== null && hoverSeg !== null && (
        <NavRailSegmentCard
          segment={hoverSeg}
          top={hover.top}
          shown={shownCount(hoverSeg)}
          canMore={canMore(hoverSeg)}
          pagedOnce={pages > 0}
          loadingMore={loadingMore}
          locating={locating === hoverSeg.key}
          onMore={() => onCardMore(hoverSeg)}
          onMouseEnter={clearHideTimer}
          onMouseLeave={closeCardSoon}
        />
      )}
    </div>
  );
}
