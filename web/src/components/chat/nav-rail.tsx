// 右缘对话导航轨（OpenChamber v1.24.2 源码级复刻）：
// 1. 指示器带：右对齐 absolute right-1.5 top-1/2 -translate-y-1/2，命中区宽 28px
//    （容器被消息列挤压时缩 12px，ResizeObserver 测得）；带高 = min(段数,30)*12px，
//    每格 12px pitch；刻度 span h-0.5 rounded-full transition-all duration-200
//    ease-out（2px 圆头条），宽普通 10px / active 14px / 悬停聚焦 20px 邻近衰减
//    [1,0.6,0.35,0.15]；颜色 active 前景色全不透明、普通 /30、悬停 /80。带体
//    translateY 滑动 tape（transition-transform duration-300 ease-out，key=首段 id
//    防 prepend 假动画）；悬停指针 Y/12 取整映射最近刻度；停上/下
//    18px 边缘区 80ms 间隔 carousel：步进 tape 窗口起点遍历更多段（只动
//    刻度带窗口，聊天内容绝不动）。
// 2. 悬停面板：固定贴 gutter 左侧（right-full mr-3 不跟指针），全部用户消息预览的
//    迷你滚动列表（见 nav-rail-segment-card.tsx），离开 160ms 隐藏、移入取消隐藏。
// 3. 「加载更早」：gutter 顶部独立圆钮（size-5 + arrow-up / loader），不再放面板内。
// 4. 点击：按指针 Y 选最近段跳转（jumpToKey），活动指示 pin 目标 2500ms 防回拖，
//    面板关闭。
// 5. 活动段判定：pickActiveSegmentIndex（顶边 ≤ scrollTop+100px 的最后一段；距底
//    ≤ max(48px, 10% viewport) 或粘底取最后段），scroll rAF 节流、值变才 setState。
// 6. 显示条件：段数 ≥ 2。hidden lg:flex 手机不显示（触屏无悬停）。
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { MessagesPage } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { useT } from "@/i18n/i18n";
import { NavRailSegmentCard, PANEL_ROW_PX } from "./nav-rail-segment-card";
import {
  buildSegments,
  buildTicks,
  BAND_EDGE_ZONE_PX,
  BAND_MAX_SEGMENTS,
  PITCH_PX,
  pickActiveSegmentIndex,
  type NavSegmentSpec,
  type NavTick,
} from "./nav-rail-segments";
import { useNavRailJump } from "./use-nav-rail-jump";
import type { ChatListItem } from "./message-items";

/** 命中区宽度（px）；容器被消息列挤压时缩到 12px（ResizeObserver 测得） */
const BAND_HIT_W_PX = 28;
const BAND_HIT_W_NARROW_PX = 12;

/** 悬停面板移出后的隐藏延迟（ms） */
const PANEL_HIDE_DELAY_MS = 160;

/** 点击 pin 活动段时长（ms）：防 scroll 判定立刻把活动指示拖回原段 */
const PIN_MS = 2500;

/** carousel 边缘滚动间隔（ms） */
const CAROUSEL_STEP_MS = 80;

/** 悬停聚焦宽度衰减系数（距离 0..3） */
const HOVER_DECAY = [1, 0.6, 0.35, 0.15] as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** 刻度宽度（px）：active 14 / 悬停聚焦 20 邻近衰减 / 普通 10 */
export function tickWidthOf(i: number, activeIdx: number, hoverIdx: number | null): number {
  if (i === activeIdx) return 14;
  if (hoverIdx !== null) {
    const d = Math.abs(i - hoverIdx);
    if (d === 0) return 20;
    if (d < HOVER_DECAY.length) return 10 + 10 * HOVER_DECAY[d]!;
  }
  return 10;
}

/** tape 滑动起点（格下标）：活动段尽量居中，overscan 4，钳在有效范围内 */
export function tapeStartOf(segCount: number, focusIdx: number): number {
  if (segCount <= BAND_MAX_SEGMENTS) return 0;
  return clamp(focusIdx - BAND_MAX_SEGMENTS / 2, 0, segCount - BAND_MAX_SEGMENTS);
}

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
  const bandRef = useRef<HTMLDivElement | null>(null);
  // 活动段：scroll 判定值（activeIdx）+ 点击 pin（pinIdx，2500ms 内覆盖判定值）
  const [activeIdx, setActiveIdx] = useState(0);
  const [pinIdx, setPinIdx] = useState<number | null>(null);
  const activeIdxRef = useRef(0);
  const computedIdxRef = useRef(0);
  const pinIdxRef = useRef<number | null>(null);
  const pinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 悬停：命中格（段下标）与面板（高亮行 + glide 视窗起点 + 160ms 隐藏定时器）
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const [viewStart, setViewStart] = useState(0);
  const panelHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const carouselTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // carousel 偏移（格）：tapeStartOf(viewIdx) 基础上的独立窗口步进量，离开带体/点击后归零
  const [carouselOff, setCarouselOff] = useState(0);
  const segLenRef = useRef(0);
  // 命中区宽（ResizeObserver：容器被消息列挤压时缩 12px）
  const [hitW, setHitW] = useState(BAND_HIT_W_PX);
  const [loadingMore, setLoadingMore] = useState(false);
  const hasMore = useMessagesStore((s) => s.bySession[sessionId]?.hasMore ?? false);

  const t = useT();
  // 刻度集合：items 里 kind==="entry" 且 store 条目 role==="user" 的项（纯逻辑见
  // buildTicks）。items 身份随 entries 任何变化而重建，store 条目快照非响应式读即可
  // 覆盖新增/换 id 场景。
  const ticks = useMemo<NavTick[]>(() => {
    const entries = useMessagesStore.getState().bySession[sessionId]?.entries ?? [];
    return buildTicks(items, entries);
  }, [items, sessionId]);

  // 段聚合：每条用户刻度一段（不合并，buildSegments 纯逻辑传 max=段数）；段数超出
  // 带容量（30 格）时带体显示 30 格窗口，由 tape 滑动 + carousel 边缘步进遍历。
  // 显示条件：段数 ≥ 2。
  const segments = useMemo<NavSegmentSpec[]>(
    () => buildSegments(ticks, Math.max(ticks.length, 1)),
    [ticks],
  );
  segLenRef.current = segments.length;

  // 段顶边（内容坐标系，测量缓存 start）：活动段判定与点击映射共用
  const segOffsets = useMemo(
    () =>
      segments.map((s) => virtualizer.measurementsCache[s.firstIndex]?.start ?? 0),
    [segments, virtualizer],
  );
  const segOffsetsRef = useRef(segOffsets);
  segOffsetsRef.current = segOffsets;

  // 刻度 → 段下标（段占 ticks 连续区间，按段权展开）与段 → 面板行首下标
  const tickSegIdx = useMemo(() => {
    const arr: number[] = [];
    segments.forEach((s, si) => {
      for (let k = 0; k < s.count; k++) arr.push(si);
    });
    return arr;
  }, [segments]);
  const segStartRow = useMemo(() => {
    let acc = 0;
    return segments.map((s) => {
      const v = acc;
      acc += s.count;
      return v;
    });
  }, [segments]);
  const rowsFlat = useMemo(
    () =>
      ticks.map((tk, i) => ({
        key: tk.key,
        summary: tk.summary,
        segIdx: tickSegIdx[i] ?? 0,
      })),
    [ticks, tickSegIdx],
  );

  // 视口活动段（pin 生效值优先）：viewIdx 供刻度宽度/颜色与 tape 滑动消费
  const viewIdx = pinIdx ?? Math.min(activeIdx, segments.length - 1);

  // scroll 通道：rAF 节流跑 pickActiveSegmentIndex，值变才 setState；pin 生效期间只
  // 记录判定值不写 state（防回拖），pin 到期再落。
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const offs = segOffsetsRef.current;
      if (offs.length === 0) return;
      const idx = pickActiveSegmentIndex(offs, {
        scrollTop: scrollEl.scrollTop,
        viewportH: scrollEl.clientHeight,
        totalSize: virtualizer.getTotalSize(),
      });
      computedIdxRef.current = idx;
      if (pinIdxRef.current === null && idx !== activeIdxRef.current) {
        activeIdxRef.current = idx;
        setActiveIdx(idx);
      }
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(paint);
    };
    paint();
    scrollEl.addEventListener("scroll", schedule, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [virtualizer, scrollRef, segments]);

  // pin 状态镜像 ref（scroll 回调读）与到期清理
  useEffect(() => {
    pinIdxRef.current = pinIdx;
  }, [pinIdx]);
  useEffect(() => {
    return () => {
      if (pinTimerRef.current !== null) clearTimeout(pinTimerRef.current);
      if (panelHideTimerRef.current !== null) clearTimeout(panelHideTimerRef.current);
      if (carouselTimerRef.current !== null) clearInterval(carouselTimerRef.current);
    };
  }, []);

  // 命中区宽：ResizeObserver 测容器，被消息列挤压（< 28px）时缩 12px
  useEffect(() => {
    const railEl = railRef.current;
    if (!railEl) return;
    const ro = new ResizeObserver(() => {
      setHitW(railEl.clientWidth < BAND_HIT_W_PX ? BAND_HIT_W_NARROW_PX : BAND_HIT_W_PX);
    });
    ro.observe(railEl);
    return () => ro.disconnect();
  }, []);

  // 面板 glide：高亮行居中，上下各 2 行死区（hl 越界才滑），钳在有效视窗范围
  const winRows = Math.min(rowsFlat.length, 8);
  useEffect(() => {
    if (!panelOpen) return;
    setViewStart((vs) => {
      let next = vs;
      if (hl < next + 2) next = hl - 2;
      if (hl > next + winRows - 3) next = hl - winRows + 3;
      return clamp(next, 0, Math.max(0, rowsFlat.length - winRows));
    });
  }, [hl, panelOpen, winRows, rowsFlat.length]);

  // 面板显隐：进入（band 或面板自身）取消隐藏定时器；离开 160ms 后隐藏
  const clearPanelHideTimer = () => {
    if (panelHideTimerRef.current !== null) {
      clearTimeout(panelHideTimerRef.current);
      panelHideTimerRef.current = null;
    }
  };
  const openPanel = (segIdx: number) => {
    clearPanelHideTimer();
    setHl(segStartRow[segIdx] ?? 0);
    setPanelOpen(true);
  };
  const closePanelSoon = () => {
    clearPanelHideTimer();
    panelHideTimerRef.current = setTimeout(() => {
      panelHideTimerRef.current = null;
      setPanelOpen(false);
    }, PANEL_HIDE_DELAY_MS);
  };

  // carousel：悬停停在带上/下 18px 边缘区时按 80ms 间隔步进 tape 窗口起点
  //（+1/-1 格，铳在 [0, 段数-可视格数]；只动刻度带窗口，消息列绝不滚动）
  const stopCarousel = () => {
    if (carouselTimerRef.current !== null) {
      clearInterval(carouselTimerRef.current);
      carouselTimerRef.current = null;
    }
  };
  const startCarousel = (dir: 1 | -1) => {
    if (carouselTimerRef.current !== null) return;
    carouselTimerRef.current = setInterval(() => {
      const maxOff = Math.max(
        0,
        segLenRef.current - Math.min(segLenRef.current, BAND_MAX_SEGMENTS),
      );
      setCarouselOff((c) => clamp(c + dir, 0, maxOff));
    }, CAROUSEL_STEP_MS);
  };

  // 有效 tape 起点 = 活动段居中起点 + carousel 偏移，铳在窗口范围内
  const visCount = Math.min(segments.length, BAND_MAX_SEGMENTS);
  const maxOff = Math.max(0, segments.length - visCount);
  const effTapeStart = clamp(
    tapeStartOf(segments.length, viewIdx) + carouselOff,
    0,
    maxOff,
  );

  // 指针 → 段下标：Y/12 取整映射最近格 + tape 起点偏移（钳段界）
  const segIdxFromPointer = (clientY: number): number => {
    const band = bandRef.current;
    if (!band) return 0;
    const y = clientY - band.getBoundingClientRect().top;
    const cell = clamp(Math.floor(y / PITCH_PX), 0, Math.min(segments.length, BAND_MAX_SEGMENTS) - 1);
    return clamp(cell + effTapeStart, 0, segments.length - 1);
  };
  const onBandMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    const band = bandRef.current;
    if (!band) return;
    const rect = band.getBoundingClientRect();
    const y = ev.clientY - rect.top;
    const segIdx = segIdxFromPointer(ev.clientY);
    stopCarousel();
    if (y < BAND_EDGE_ZONE_PX) startCarousel(-1);
    else if (y > rect.height - BAND_EDGE_ZONE_PX) startCarousel(1);
    setHoverIdx(segIdx);
    openPanel(segIdx);
  };
  const onBandLeave = () => {
    stopCarousel();
    setCarouselOff(0);
    setHoverIdx(null);
    closePanelSoon();
  };

  const jumpToKey = useNavRailJump(scrollRef, virtualizer);

  // 点击：按指针 Y 选最近段跳转 + 活动指示 pin 2500ms 防回拖 + 面板关闭
  const onBandClick = (ev: React.MouseEvent<HTMLDivElement>) => {
    stopCarousel();
    setCarouselOff(0);
    const segIdx = segIdxFromPointer(ev.clientY);
    const seg = segments[segIdx];
    if (!seg) return;
    jumpToKey(seg.firstKey, seg.firstIndex);
    setPanelOpen(false);
    setPinIdx(segIdx);
    if (pinTimerRef.current !== null) clearTimeout(pinTimerRef.current);
    pinTimerRef.current = setTimeout(() => {
      pinTimerRef.current = null;
      setPinIdx(null);
      setActiveIdx(computedIdxRef.current);
      activeIdxRef.current = computedIdxRef.current;
    }, PIN_MS);
  };

  // 「加载更早」：按 before 游标（store 最旧 id）向窗外取一窗并入。失败静默（钮由
  // finally 复位可重试）。
  const onLoadEarlier = () => {
    if (loadingMore) return;
    setLoadingMore(true);
    const run = async () => {
      const st = useMessagesStore.getState().bySession[sessionId];
      if (st?.hasMore && st.oldestId !== null) {
        await useMessagesStore.getState().fetchEarlierPage(sessionId, st.oldestId, fetchPage);
      }
    };
    run()
      .catch(() => {
        // 取数失败静默（软增强；loadingMore 已由 finally 复位，钮可重试）
      })
      .finally(() => setLoadingMore(false));
  };

  if (ticks.length === 0 || segments.length < 2) return null;

  const viewIdxSafe = clamp(viewIdx, 0, segments.length - 1);
  const bandH = visCount * PITCH_PX;
  const panelWindowH = winRows * PANEL_ROW_PX;
  const offsetY = -viewStart * PANEL_ROW_PX;

  return (
    <div
      ref={railRef}
      data-testid="nav-rail"
      className="pointer-events-none absolute inset-y-1 right-0 hidden w-7 lg:flex"
    >
      {/* 「加载更早」独立圆钮：gutter 顶部，加载中 loader 旋转 + opacity-70 */}
      {hasMore && (
        <button
          type="button"
          data-testid="nav-rail-load-earlier"
          aria-label={t("chat.navRail.loadEarlier")}
          onClick={onLoadEarlier}
          className="pointer-events-auto absolute right-1.5 top-1 z-10 flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          {loadingMore ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin opacity-70" />
          ) : (
            <ArrowUp aria-hidden className="size-3.5" />
          )}
        </button>
      )}

      {/* 指示器带：右对齐垂直居中，命中区 28px（挤压缩 12px）；点击按指针 Y 选最近段 */}
      <div
        ref={bandRef}
        data-testid="nav-rail-band"
        className="pointer-events-auto absolute right-1.5 top-1/2 -translate-y-1/2"
        style={{ width: hitW, height: bandH }}
        onPointerMove={onBandMove}
        onPointerLeave={onBandLeave}
        onClick={onBandClick}
        role="navigation"
        aria-label={t("chat.navRail.jumpTo", { title: ticks[0]?.title ?? "" })}
      >
        {/* tape：translateY 滑动（duration-300 ease-out），key=首段 id 防 prepend 假动画 */}
        <div
          key={segments[0]!.key}
          className="flex flex-col items-center transition-transform duration-300 ease-out"
          style={{ transform: `translateY(${-effTapeStart * PITCH_PX}px)` }}
        >
          {segments.map((seg, i) => {
            const isActive = i === viewIdxSafe;
            const isHover = hoverIdx === i;
            return (
              <span
                key={seg.key}
                data-testid="nav-rail-segment"
                data-seg-key={seg.key}
                data-active={isActive ? "true" : "false"}
                className="flex items-center justify-center"
                style={{ height: PITCH_PX, width: "100%" }}
              >
                <span
                  aria-hidden
                  className={`block h-0.5 rounded-full transition-all duration-200 ease-out ${
                    isActive
                      ? "bg-foreground"
                      : isHover
                        ? "bg-foreground/80"
                        : "bg-foreground/30"
                  }`}
                  style={{ width: tickWidthOf(i, viewIdxSafe, hoverIdx) }}
                />
              </span>
            );
          })}
        </div>
      </div>

      {/* 悬停面板：固定贴 gutter 左侧，全部用户消息迷你列表（可交互，见组件注释） */}
      {panelOpen && rowsFlat.length > 0 && (
        <NavRailSegmentCard
          rows={rowsFlat}
          hl={clamp(hl, 0, rowsFlat.length - 1)}
          activeSegIdx={viewIdxSafe}
          offsetY={offsetY}
          windowH={panelWindowH}
          onRowEnter={setHl}
          onWheelStep={(dir) =>
            setHl((h) => clamp(h + dir, 0, rowsFlat.length - 1))
          }
          onMouseEnter={clearPanelHideTimer}
          onMouseLeave={closePanelSoon}
        />
      )}
    </div>
  );
}
