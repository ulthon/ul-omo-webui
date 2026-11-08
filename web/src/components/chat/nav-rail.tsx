// 聊天右缘导航（OpenChamber v2.7.0 角标+面板形态复刻 + 用户改良交互）：
// 1. 角标指示器：转写区顶端右上角固定五格刻度 glyph（bg-background/85 无边框无模糊
//    衬底、圆角 8、每格 26x2px 圆头条、间距 5px）。亮格 = 当前阅读位置在已加载
//    prompt 序列中等比映射（litCountOf，条数 ≤5 时亮 min(n,5)）。显示条件段数 ≥ 2。
//    无悬停动画无跟随指针；滚动时亮格跟随（scroll rAF 节流，pickActiveSegmentIndex
//    判当前段，值变才 setState）。点击 pin 2500ms 防亮格回拖。
// 2. 面板：悬停角标 120ms 或点击角标打开（pointerleave 清定时）；原位覆盖角标展开
//    （容器 pointer-events:none，面板显式 pointer-events:auto）；宽
//    min(20rem, calc(100vw - 5rem))；surface-elevated（bg-popover）+border/60+
//    rounded-xl+shadow。首行 = Load more prompts 按钮（居中 12px muted，加载中
//    spinner 旋转 + disabled + cursor-wait；无更早时改尾注「已到会话最早」）。列表
//    区原生滚动 max-h 24rem；每行 = 一条用户消息预览（160 字截断 line-clamp-2，
//    title 全文）；当前选中行实心 accent 填充；打开时选中行滚到列表中央。
// 3. 分页（OC 机制）：点 Load more → 循环调 fetchEarlierPage（before 游标，store
//    链路）直到面板至少新增 1 条用户消息或 hasMore=false。加载中新消息前插后：
//    选中行索引平移补偿（选中跟人走）+ 列表 scrollTop 锚定原首行（不跳）。
// 4. 点击行：jumpToKey 跳转 + 目标 pin 高亮 2.5s（useNavRailJump）+ 活动 pin
//    2500ms；面板不关，选中实心行 = 所点行并滚到中央。ESC / 点面板外关闭。
// 5. 显示条件：段数 ≥ 2。hidden lg:block 手机不显示（触屏无悬停）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { MessagesPage } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { useT } from "@/i18n/i18n";
import {
  buildTicks,
  countUserPrompts,
  INDICATOR_CELLS,
  litCountOf,
  pickActiveSegmentIndex,
} from "./nav-rail-segments";
import { useNavRailJump } from "./use-nav-rail-jump";
import type { ChatListItem } from "./message-items";

/** 悬停角标开面板延迟（ms） */
const PANEL_OPEN_DELAY_MS = 120;

/** 点击 pin 活动位置时长（ms）：防 scroll 判定立刻把亮格拖回原位 */
const PIN_MS = 2500;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** 分页锚点：前插后恢复选中行与列表滚动位（scrollTop 锚定原首行） */
interface PageAnchor {
  prevLen: number;
  selIdx: number;
  firstKey: string;
  prevTop: number;
  prevScrollTop: number;
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
  /** 翻页注入面（backfillModelTimeline 同款）：面板内分页共用，测试传桩免 mock api 模块 */
  fetchPage: (opts: { before?: string; full?: boolean }) => Promise<MessagesPage>;
}) {
  // 活动位置：scroll 判定值（activeIdx）+ 点击 pin（pinIdx，2500ms 内覆盖判定值）
  const [activeIdx, setActiveIdx] = useState(0);
  const [pinIdx, setPinIdx] = useState<number | null>(null);
  const activeIdxRef = useRef(0);
  const pinIdxRef = useRef<number | null>(null);
  // 面板：开态 / 选中行（实心 accent）/ 悬停定时 / 加载中
  const [panelOpen, setPanelOpen] = useState(false);
  const [selIdx, setSelIdx] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingRef = useRef(false);
  const anchorRef = useRef<PageAnchor | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const hasMore = useMessagesStore((s) => s.bySession[sessionId]?.hasMore ?? false);

  const t = useT();
  // 行集合：items 里 kind==="entry" 且 store 条目 role==="user" 的项（纯逻辑见
  // buildTicks）。items 身份随 entries 任何变化而重建，store 条目快照非响应式读即可
  // 覆盖新增/换 id 场景。
  const ticks = useMemo<ReturnType<typeof buildTicks>>(() => {
    const entries = useMessagesStore.getState().bySession[sessionId]?.entries ?? [];
    return buildTicks(items, entries);
  }, [items, sessionId]);
  const ticksRef = useRef(ticks);
  ticksRef.current = ticks;

  // 行顶边（内容坐标系，测量缓存 start）：活动位置判定与点击落位共用
  const rowOffsets = useMemo(
    () => ticks.map((tk) => virtualizer.measurementsCache[tk.index]?.start ?? 0),
    [ticks, virtualizer],
  );
  const rowOffsetsRef = useRef(rowOffsets);
  rowOffsetsRef.current = rowOffsets;

  // 生效位置（pin 优先）：亮格与选中行跟随（选中行仅在无手动点选时跟随）
  const viewIdx = pinIdx ?? Math.min(activeIdx, Math.max(ticks.length - 1, 0));

  // scroll 通道：rAF 节流跑 pickActiveSegmentIndex，值变才 setState；pin 生效期间只
  // 记录判定值不写 state（防回拖），pin 到期再落。
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const offs = rowOffsetsRef.current;
      if (offs.length === 0) return;
      const idx = pickActiveSegmentIndex(offs, {
        scrollTop: scrollEl.scrollTop,
        viewportH: scrollEl.clientHeight,
        totalSize: virtualizer.getTotalSize(),
      });
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
  }, [virtualizer, scrollRef, ticks]);

  // pin 状态镜像 ref（scroll 回调读）与到期落值
  useEffect(() => {
    pinIdxRef.current = pinIdx;
    if (pinIdx === null) return;
    const timer = setTimeout(() => {
      setPinIdx(null);
      setActiveIdx(activeIdxRef.current);
    }, PIN_MS);
    return () => clearTimeout(timer);
  }, [pinIdx]);

  const clearHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const closePanel = useCallback(() => {
    clearHoverTimer();
    setPanelOpen(false);
  }, []);

  // 打开面板：选中行 = 当前阅读位置行（无 pin 时），滚到列表中央
  const openPanel = () => {
    clearHoverTimer();
    setSelIdx(clamp(pinIdx ?? activeIdx, 0, Math.max(ticks.length - 1, 0)));
    setPanelOpen(true);
  };
  const onIndicatorEnter = () => {
    clearHoverTimer();
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      openPanel();
    }, PANEL_OPEN_DELAY_MS);
  };

  // ESC / 点面板外关闭（面板与角标内的按下不算外）
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") closePanel();
    };
    const onPointerDown = (ev: PointerEvent) => {
      const root = containerRef.current;
      const target = ev.target as Node | null;
      if (root && target && root.contains(target)) return;
      closePanel();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [panelOpen, closePanel]);

  // 打开面板时：选中行滚到列表中央（双 rAF 等布局就绪；手动算 scrollTop，避免
  // scrollIntoView 连带滚动聊天容器）。仅开态变更时触发，不随选中行变化重跑
  // （点选/平移补偿各自显式控制滚动位）。
  const selIdxRef = useRef(selIdx);
  selIdxRef.current = selIdx;
  useEffect(() => {
    if (!panelOpen) return;
    const list = listRef.current;
    if (!list) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = list.querySelector<HTMLElement>(
          `[data-row-key="${CSS.escape(ticksRef.current[selIdxRef.current]?.key ?? "")}"]`,
        );
        if (el) list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
      }),
    );
  }, [panelOpen]);

  /** 选中行滚到列表中央（点选时用） */
  const centerRow = (i: number) => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(
      `[data-row-key="${CSS.escape(ticks[i]?.key ?? "")}"]`,
    );
    if (list && el) list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
  };

  // 分页锚定：前插后（ticks 变长）选中行索引平移补偿 + scrollTop 锚定原首行
  useEffect(() => {
    const a = anchorRef.current;
    if (!a) return;
    anchorRef.current = null;
    const delta = ticks.length - a.prevLen;
    if (delta <= 0) return;
    setSelIdx(clamp(a.selIdx + delta, 0, ticks.length - 1));
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(
      `[data-row-key="${CSS.escape(a.firstKey)}"]`,
    );
    if (el) list.scrollTop = el.offsetTop - (a.prevTop - a.prevScrollTop);
  }, [ticks]);

  const jumpToKey = useNavRailJump(scrollRef, virtualizer);

  // 点击行：跳转 + 目标 pin 高亮 + 活动 pin 2500ms；面板不关，选中 = 所点行滚到中央
  const onRowClick = (i: number) => {
    const tk = ticks[i];
    if (!tk) return;
    jumpToKey(tk.key, tk.index);
    setSelIdx(i);
    centerRow(i);
    setPinIdx(i);
  };

  // Load more：循环翻页直到面板至少新增 1 条用户消息或 hasMore=false。前插前记锚
  // （原首行 offsetTop + scrollTop + 选中行），新增后由锚定 effect 补偿。失败静默
  // （钮由 finally 复位可重试）。
  const onLoadMore = () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true);
    const run = async () => {
      for (;;) {
        const st = useMessagesStore.getState().bySession[sessionId];
        if (!st?.hasMore || st.oldestId === null) break;
        const beforeCount = countUserPrompts(st.entries);
        const list = listRef.current;
        const firstRow = list?.querySelector<HTMLElement>("[data-row-key]");
        anchorRef.current = {
          prevLen: ticksRef.current.length,
          selIdx,
          firstKey: firstRow?.dataset.rowKey ?? ticksRef.current[0]?.key ?? "",
          prevTop: firstRow?.offsetTop ?? 0,
          prevScrollTop: list?.scrollTop ?? 0,
        };
        await useMessagesStore
          .getState()
          .fetchEarlierPage(sessionId, st.oldestId, fetchPage);
        const st2 = useMessagesStore.getState().bySession[sessionId];
        const added = st2 ? countUserPrompts(st2.entries) - beforeCount : 0;
        if (added >= 1) break;
        if (!st2?.hasMore) break;
      }
    };
    run()
      .catch(() => {
        // 取数失败静默（软增强；loadingMore 已由 finally 复位，钮可重试）
      })
      .finally(() => {
        loadingRef.current = false;
        setLoadingMore(false);
      });
  };

  if (ticks.length < 2) return null;

  const lit = litCountOf(ticks.length, viewIdx);

  return (
    <div
      ref={containerRef}
      data-testid="nav-rail"
      className="pointer-events-none absolute right-1 top-1 z-40 hidden lg:block"
    >
      {/* 角标指示器：固定五格刻度，亮格随阅读位置映射；悬停 120ms / 点击开面板 */}
      <div
        data-testid="nav-rail-indicator"
        role="navigation"
        aria-label={t("chat.navRail.jumpTo", { title: ticks[0]?.title ?? "" })}
        className="pointer-events-auto flex items-center gap-[5px] rounded-lg bg-background/85 p-2"
        onPointerEnter={onIndicatorEnter}
        onPointerLeave={clearHoverTimer}
        onClick={openPanel}
      >
        {Array.from({ length: INDICATOR_CELLS }, (_, i) => (
          <span
            key={i}
            aria-hidden
            className={`block h-[2px] w-[26px] rounded-full ${
              i < lit ? "bg-foreground" : "bg-foreground/25"
            }`}
          />
        ))}
      </div>

      {/* 面板：原位覆盖角标展开（容器 pointer-events:none，面板显式恢复交互） */}
      {panelOpen && (
        <div
          ref={panelRef}
          data-testid="nav-rail-panel"
          className="pointer-events-auto absolute right-0 top-0 z-50 w-[min(20rem,calc(100vw-5rem))] rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-md"
        >
          {/* 首行：Load more prompts（无更早时改尾注「已到会话最早」） */}
          {hasMore ? (
            <button
              type="button"
              data-testid="nav-rail-load-more"
              disabled={loadingMore}
              onClick={onLoadMore}
              className={`flex w-full items-center justify-center gap-1.5 rounded-t-xl py-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground ${
                loadingMore ? "cursor-wait" : ""
              }`}
            >
              {loadingMore && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
              {t("chat.navRail.loadMorePrompts")}
            </button>
          ) : (
            <div
              data-testid="nav-rail-earliest"
              className="flex w-full items-center justify-center py-2 text-xs text-muted-foreground"
            >
              {t("chat.navRail.earliestReached")}
            </div>
          )}

          {/* 列表区：原生滚动 max-h 24rem；行 = 用户消息预览，选中行实心 accent */}
          <div ref={listRef} className="relative max-h-96 overflow-y-auto pb-1">
            {ticks.map((tk, i) => {
              const isSel = i === selIdx;
              return (
                <div
                  key={tk.key}
                  data-testid={isSel ? "nav-rail-prompt-row-active" : "nav-rail-prompt-row"}
                  data-row-key={tk.key}
                  title={tk.title}
                  onClick={() => onRowClick(i)}
                  className={`cursor-pointer px-2 py-1.5 ${
                    isSel
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <span className="line-clamp-2 text-xs leading-snug [overflow-wrap:anywhere]">
                    {tk.summary}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
