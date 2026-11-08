// 右缘对话导航轨（A7，docs08-r3 任务 16；#27b 簇分段升级）：openchamber 同款分段指示
// 器——每条用户刻度自成一段（用户消息簇），段高 ∝ 段内用户消息量（flex 比例分配，
// 最小可点高 12px），段多时相邻段合并（maxSegments = 轨高÷14px，ResizeObserver 测得
// 轨高后收敛）保持可辨识密度；段标签（段首刻度所在自然日）进悬停弹卡（受控显隐沿用
// 原浮卡：进入即显、移出 100ms 内隐藏，弹卡自身悬停续期供「加载更早」钮点按）。当前
// 视口所在段 data-active 高亮（指示块中点落在哪段轨区即点亮，随 scroll rAF 直写）。
// 刻度仍按 TanStack Virtual 测量缓存 itemStart/totalSize 比例定位（只读内存测量缓存，
// 不破坏虚拟化）。点击刻度/段定位到段首 + 目标行 1.5s 一次性高亮（data 属性 +
// index.css 动画，沿用）——簇分段语义下段由已加载消息构建，目标段必然已在窗内，
// 无需先翻页预拉（向上分页由弹卡「加载更早」承担）。弹卡显示该段用户消息预览（时间 +
// 两行截断摘要，默认 3 条，「加载更早」一次 10 条，无更多时隐藏）。视口指示块按
// scrollTop..scrollTop+clientHeight 区间映射，rAF 节流直写 style（不进 React 渲染路
// 径，同自动滚底订阅范式）。hidden lg:flex 手机不显示（触屏无悬停，段/刻度点按即跳）；
// 不替代原生滚动条（容器 pointer-events-none，段/刻度按钮才可点，段间隙点击穿透）。
import { useEffect, useMemo, useRef, useState } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { MessagesPage } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { useLocaleStore, useT } from "@/i18n/i18n";
import { NavRailSegmentCard } from "./nav-rail-segment-card";
import { buildSegments, buildTicks, SEG_MIN_TRACK_PX, type NavSegmentSpec, type NavTick } from "./nav-rail-segments";
import { useNavRailHover } from "./use-nav-rail-hover";
import { useNavRailJump } from "./use-nav-rail-jump";
import type { ChatListItem } from "./message-items";

/** 弹卡默认展示的段内最近用户消息条数 */
const CARD_INITIAL_ROWS = 3;

/** 「加载更早」一次展开的条数 */
const CARD_MORE_STEP = 10;

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
  /** 翻页注入面（backfillModelTimeline 同款）：「加载更早」窗外翻页共用，测试传桩免 mock api 模块 */
  fetchPage: (opts: { before?: string; full?: boolean }) => Promise<MessagesPage>;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  // 轨高（窗口/容器变化时随 ResizeObserver 更新）：换算段数上限，超出即相邻段合并
  const [railHeight, setRailHeight] = useState(0);

  // 悬停弹卡：受控显隐状态机抽离至 use-nav-rail-hover（进入即显、移出 100ms 内隐藏、
  // 弹卡悬停续期、翻页展开数随段切换重置）
  const { hover, pages, setPages, openCard, closeCardSoon, clearHideTimer, cardTopFromEvent } =
    useNavRailHover(railRef);
  const [loadingMore, setLoadingMore] = useState(false);

  const t = useT();
  // 刻度集合：items 里 kind==="entry" 且 store 条目 role==="user" 的项（纯逻辑见
  // buildTicks）。items 身份随 entries 任何变化而重建（chat-view useMemo），store 条目
  // 快照非响应式读即可覆盖新增/换 id 场景。
  const ticks = useMemo<NavTick[]>(() => {
    const entries = useMessagesStore.getState().bySession[sessionId]?.entries ?? [];
    return buildTicks(items, entries);
  }, [items, sessionId]);

  // 段聚合：按用户消息簇分段（每条用户刻度一段，#27b），段数上限 = 轨高÷单段最小
  // 占轨高度，超出即相邻段合并（buildSegments 纯逻辑）。轨高未测得时先不合并，测得
  // 后随重渲染收敛。now 取渲染时刻（标签只需日粒度），与刻度的非响应式 store 快照
  // 读同一风类。
  const segments = useMemo<NavSegmentSpec[]>(
    () =>
      buildSegments(ticks, {
        hasMore: useMessagesStore.getState().bySession[sessionId]?.hasMore ?? false,
        now: Date.now(),
        locale: useLocaleStore.getState().locale,
        labels: { today: t("chat.navRail.today"), yesterday: t("chat.navRail.yesterday") },
        maxSegments:
          railHeight > 0 ? Math.max(1, Math.floor(railHeight / SEG_MIN_TRACK_PX)) : undefined,
      }),
    [ticks, sessionId, t, railHeight],
  );

  // 视口指示块：scroll 事件 rAF 节流后直写 transform/height，并点亮当前视口所在段
  // （#27b：指示块中点落在哪段轨区，该段 data-active 高亮；段界以段钮真实 offsetTop
  // 为准，minHeight 托底造成的非纯比例分布不失准）。rail 尺寸变化（窗口改宽高）经
  // ResizeObserver 走同一路径并同步 railHeight（段合并密度随轨高收敛）。deps 带
  // ticks.length：空→有刻度翻转时 refs 才挂上，需重挂监听。
  const segmentsRef = useRef(segments);
  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const railEl = railRef.current;
    const indicator = indicatorRef.current;
    if (!scrollEl || !railEl || !indicator) return;
    let raf = 0;
    let activeKey: string | null = null;
    const paint = () => {
      raf = 0;
      const railH = railEl.clientHeight;
      if (railH > 0 && railHeight !== railH) setRailHeight(railH);
      const total = virtualizer.getTotalSize();
      if (total <= 0 || railH <= 0) return;
      const ratio = railH / total;
      const height = Math.max(12, Math.min(scrollEl.clientHeight * ratio, railH));
      const top = Math.max(0, Math.min(scrollEl.scrollTop * ratio, railH - height));
      indicator.style.transform = `translateY(${top}px)`;
      indicator.style.height = `${height}px`;
      const mid = top + height / 2;
      const segs = segmentsRef.current;
      const totalWeight = segs.reduce((acc, s) => acc + s.count, 0);
      let nextKey: string | null = null;
      if (totalWeight > 0) {
        // 段界按权重比例划分（与渲染侧 flexGrow 同一公式；minHeight 托底造成的偏差
        // 在合并密度下受限，软指示可接受）。末段兜底吸收指示块中点恰在轨底界的浮点边界。
        let acc = 0;
        for (let i = 0; i < segs.length; i++) {
          acc += segs[i]!.count;
          const bottom = (acc / totalWeight) * railH;
          if (mid <= bottom || i === segs.length - 1) {
            nextKey = segs[i]!.key;
            break;
          }
        }
      }
      if (nextKey !== activeKey) {
        activeKey = nextKey;
        railEl
          .querySelectorAll<HTMLElement>('[data-testid="nav-rail-segment"]')
          .forEach((el) => {
            el.dataset.active = el.dataset.segKey === activeKey ? "true" : "false";
          });
      }
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
    // railHeight 进 deps：合并密度随轨高收敛后段钮重排，需重算当前段
  }, [virtualizer, scrollRef, ticks.length, railHeight, segments]);

  // 定位与高亮抽离至 use-nav-rail-jump（刻度点击与段落位共用）
  const jumpToKey = useNavRailJump(scrollRef, virtualizer);

  // 点击段：定位段首（scrollToIndex 到测量起点 + 目标行高亮）。簇分段语义下段由已
  // 加载消息构建，目标段必然已在窗内，无需先翻页预拉（向上分页由弹卡「加载更早」
  // 承担）；行 key 即条目 id 跨重排稳定。
  const onSegmentClick = (seg: NavSegmentSpec) => {
    jumpToKey(seg.firstKey, seg.firstIndex);
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
            data-seg-key={seg.key}
            aria-label={t("chat.navRail.jumpTo", { title: seg.label })}
            onClick={() => onSegmentClick(seg)}
            onMouseEnter={(ev) => openCard(seg.key, cardTopFromEvent(ev))}
            onMouseLeave={closeCardSoon}
            className="pointer-events-auto group relative my-px rounded-full transition-colors hover:bg-border/60"
            style={{ flexGrow: seg.count, flexBasis: 0, minHeight: 12 }}
          >
            <span
              aria-hidden
              className="absolute inset-y-0 left-0.5 right-0.5 rounded-full bg-border/50 transition-colors group-data-[active=true]:bg-primary/60"
            />
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
          onMore={() => onCardMore(hoverSeg)}
          onMouseEnter={clearHideTimer}
          onMouseLeave={closeCardSoon}
        />
      )}
    </div>
  );
}
