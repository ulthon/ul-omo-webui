// nav-rail 分段指示器单测（openchamber 同款右缘分段轨升级）：跨自然日 entries 聚合成
// 段（段标签 今天/昨天/Intl 月-日，段高权重 = 段内用户消息数）；悬停段弹卡显示该段最
// 近用户消息（时间 + 60 字单行摘要）；「加载更早」按 before 游标（store 最旧 id）翻页
// 取更早并入；点击不完整段先翻页后落位（断言调用序：fetchPage 先于 scrollToOffset）。
// 渲染走真实组件（happy-dom + createRoot，nav-rail-hover 同款 harness）；virtualizer 以
// 最小桩满足只读消费面；store 直注；翻页经 fetchPage 注入桩（backfillModelTimeline 同
// 款注入面，免 mock api 模块）。测试语言锁 zh-CN（setup-locale.ts）。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MessagesPage, WireEntry } from "@/lib/api";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement, useMemo } = await import("react");
const { NavRail } = await import("@/components/chat/nav-rail");
const { useMessagesStore } = await import("@/stores/messages");
const { buildTicks, buildSegments, SEG_MIN_TRACK_PX } = await import(
  "@/components/chat/nav-rail-segments"
);
type NavTick = Awaited<ReturnType<typeof buildTicks>>[number];

type SegmentOpts = Parameters<typeof buildSegments>[1];
const segOpts = (over: Partial<SegmentOpts> = {}): SegmentOpts => ({
  hasMore: false,
  now: Date.now(),
  locale: "zh-CN",
  labels: { today: "今天", yesterday: "昨天" },
  ...over,
});

/** entries → items（chat-view 同链路）→ ticks（纯函数测试入口） */
function ticksOf(entries: WireEntry[]): NavTick[] {
  const items = entries.map((e) => ({
    key: e.id as string,
    kind: "entry" as const,
    entryId: e.id as string,
    interrupted: false,
    model: null,
  }));
  return buildTicks(items, entries);
}

/** 本地某天指定时刻的 ISO 时间戳（n 天前；时刻锚定白天使渲染侧 Date.now() 与构造时刻
 *  跨日界的窗口期至少半天，标签断言与午夜无竞态） */
function isoDaysAgo(n: number, hour = 12, minute = 0): string {
  const d = new Date(Date.now() - n * 86_400_000);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

let seq = 0;
function userEntry(text: string, ts: string): WireEntry {
  seq += 1;
  return {
    type: "message",
    id: `u${seq}`,
    timestamp: ts,
    message: { role: "user", content: [{ type: "text", text }] },
  } as WireEntry;
}
function assistantEntry(ts: string): WireEntry {
  seq += 1;
  return {
    type: "message",
    id: `a${seq}`,
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "text", text: "收到" }] },
  } as WireEntry;
}

interface SeedOptions {
  entries: WireEntry[];
  hasMore?: boolean;
  oldestId?: string | null;
}

function seedStore({ entries, hasMore = false, oldestId = null }: SeedOptions) {
  useMessagesStore.setState({
    bySession: {
      s1: {
        entries,
        cursor: null,
        leafId: null,
        loaded: true,
        hasMore,
        oldestId,
        streaming: false,
        streamingMessage: null,
        streamingEntryId: null,
        toolRuns: {},
        compacting: false,
      },
    },
  });
}

/** 调用序日志：fetchPage / scrollToOffset 按发生顺序入列（先翻页后落位断言用） */
const callLog: string[] = [];
let fetchPageImpl: (opts: { before?: string; full?: boolean }) => Promise<MessagesPage> = async () => ({
  sessionId: "s1",
  entries: [],
  leafId: null,
  cursor: null,
  hasMore: false,
  oldestId: null,
});
const fetchPageSpy = (opts: { before?: string; full?: boolean }) => {
  callLog.push(`fetchPage:${opts.before ?? ""}`);
  return fetchPageImpl(opts);
};

function stubVirtualizer(scrollStart = 500) {
  return {
    getTotalSize: () => 1000,
    // 每个下标同一起点：翻页后段首下标前移也落同一 offset（断言只看调用序与发生）
    measurementsCache: Array.from({ length: 64 }, () => ({ start: scrollStart, size: 100 })),
    scrollToOffset: (start: number) => {
      callLog.push(`scrollToOffset:${start}`);
    },
  };
}

interface Harness {
  host: HTMLElement;
  segments: () => HTMLElement[];
  segment: (i: number) => HTMLElement;
  card: () => HTMLElement | null;
  moreButton: () => HTMLButtonElement | null;
  fireSegmentEnter: (i: number) => void;
  clickSegment: (i: number) => void;
  unmount: () => Promise<void>;
}
/** 生产接线镜像：items 随 store entries 重建（chat-view useMemo → MessageList →
 *  NavRail 同链路），翻页头插后段/刻度才能重算，静态 items 会把段钉在旧窗 */
function HarnessRail(props: {
  sessionId: string;
  scrollRef: { current: null };
  virtualizer: ReturnType<typeof stubVirtualizer>;
}) {
  const entries = useMessagesStore((s) => s.bySession[props.sessionId]?.entries);
  const items = useMemo(
    () =>
      (entries ?? []).map((e) => ({
        key: e.id as string,
        kind: "entry" as const,
        entryId: e.id as string,
        interrupted: false,
        model: null,
      })),
    [entries],
  );
  return createElement(NavRail, {
    items,
    sessionId: props.sessionId,
    scrollRef: props.scrollRef,
    virtualizer: props.virtualizer,
    fetchPage: fetchPageSpy,
  });
}

async function mountRail(
  entries: WireEntry[],
  scrollStart = 500,
  scrollRef: { current: unknown } = { current: null },
): Promise<Harness> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const el = createElement(HarnessRail, {
    sessionId: "s1",
    scrollRef: scrollRef as { current: null },
    virtualizer: stubVirtualizer(scrollStart),
  });
  await act(async () => {
    root.render(el);
  });
  const segmentEls = () =>
    Array.from(host.querySelectorAll<HTMLElement>('[data-testid="nav-rail-segment"]'));
  return {
    host,
    segments: segmentEls,
    segment: (i: number) => {
      const el = segmentEls()[i];
      if (!el) throw new Error(`段 ${i} 不存在`);
      return el;
    },
    card: () => host.querySelector<HTMLElement>('[data-testid="nav-rail-hover-card"]'),
    moreButton: () => host.querySelector<HTMLButtonElement>('[data-testid="nav-rail-segment-more"]'),
    // React 的 onMouseEnter 由根节点 mouseover 合成（nav-rail-hover 同款派发）
    fireSegmentEnter: (i: number) => {
      const el = segmentEls()[i];
      if (!el) throw new Error(`段 ${i} 不存在，无法悬停`);
      act(() => {
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseenter"));
      });
    },
    clickSegment: (i: number) => {
      const el = segmentEls()[i];
      if (!el) throw new Error(`段 ${i} 不存在，无法点击`);
      act(() => {
        el.click();
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** act 内排空微任务与一帧：点击后的异步续体（取数→合并→重渲染→段落位前的等帧）
 *  全部落定。React 19 act 环境下 act 外的更新不提交 DOM，必须排在 act 内。 */
const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
};

beforeEach(() => {
  callLog.length = 0;
  seq = 0;
  fetchPageImpl = async () => ({
    sessionId: "s1",
    entries: [],
    leafId: null,
    cursor: null,
    hasMore: false,
    oldestId: null,
  });
});

afterEach(async () => {
  document.body.innerHTML = "";
});

describe("nav-rail 分段纯函数（簇边界与合并密度）", () => {
  test("每条用户消息自成一段（簇边界）：assistant 不入段，段键=刻度 key，complete 仅首段随 hasMore", () => {
    const entries = [
      userEntry("第一条", isoDaysAgo(0, 9)),
      assistantEntry(isoDaysAgo(0, 9, 30)),
      userEntry("第二条", isoDaysAgo(0, 10)),
      userEntry("第三条", isoDaysAgo(1, 9)),
    ];
    const ticks = ticksOf(entries);
    expect(ticks.length).toBe(3);
    const full = buildSegments(ticks, segOpts());
    expect(full.length).toBe(3);
    expect(full.map((s) => s.key)).toEqual(ticks.map((tk) => tk.key));
    expect(full.map((s) => s.count)).toEqual([1, 1, 1]);
    expect(full.every((s) => s.complete)).toBe(true);
    // 窗外有更早历史：仅最旧簇不完整
    const withMore = buildSegments(ticks, segOpts({ hasMore: true }));
    expect(withMore.map((s) => s.complete)).toEqual([false, true, true]);
  });

  test("段多时相邻合并保持密度：maxSegments=2 时权和最小相邻对优先并入左段，行序拼接", () => {
    const entries = [
      userEntry("一", isoDaysAgo(0, 8)),
      userEntry("二", isoDaysAgo(0, 9)),
      userEntry("三", isoDaysAgo(0, 10)),
      userEntry("四", isoDaysAgo(0, 11)),
      userEntry("五", isoDaysAgo(0, 12)),
    ];
    const ticks = ticksOf(entries);
    const merged = buildSegments(ticks, segOpts({ maxSegments: 2 }));
    expect(merged.length).toBe(2);
    // 合并序列：[1,1,1,1,1]→[2,1,1,1]→[2,1,2]→[2,3]（每轮权和最小对，并列取最左）
    expect(merged.map((s) => s.count)).toEqual([2, 3]);
    // 段键/段首随左段保留，行清单按时间线顺序拼接
    expect(merged[0]!.key).toBe(ticks[0]!.key);
    expect(merged[0]!.firstKey).toBe(ticks[0]!.key);
    expect(merged[0]!.rows.map((r) => r.key)).toEqual([ticks[0]!.key, ticks[1]!.key]);
    expect(merged[1]!.rows.map((r) => r.key)).toEqual(
      [ticks[2]!.key, ticks[3]!.key, ticks[4]!.key],
    );
    // 不完整标记随左段（最旧段）保留
    const mergedMore = buildSegments(ticks, segOpts({ hasMore: true, maxSegments: 2 }));
    expect(mergedMore.map((s) => s.complete)).toEqual([false, true]);
  });

  test("单段最小占轨高度换算密度：轨高 280px → 20 段上限", () => {
    expect(Math.max(1, Math.floor(280 / SEG_MIN_TRACK_PX))).toBe(20);
    const entries = Array.from({ length: 24 }, (_, i) =>
      userEntry(`第${i + 1}条`, isoDaysAgo(0, 8, i)),
    );
    const merged = buildSegments(ticksOf(entries), segOpts({ maxSegments: 20 }));
    expect(merged.length).toBe(20);
    expect(merged.reduce((acc, s) => acc + s.count, 0)).toBe(24);
  });
});

describe("nav-rail 分段指示器（组件）", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.unmount();
      harness = null;
    }
  });

  test("每条用户消息一段：3 条今天用户消息 → 3 段，标签今天，段高权重均 1（assistant 不计）", async () => {
    const entries = [
      userEntry("今天一", isoDaysAgo(0, 9)),
      assistantEntry(isoDaysAgo(0, 9, 30)),
      userEntry("今天二", isoDaysAgo(0, 10)),
      userEntry("今天三", isoDaysAgo(0, 11)),
    ];
    seedStore({ entries });
    harness = await mountRail(entries);

    const segs = harness.segments();
    expect(segs.length).toBe(3);
    expect(segs[0]!.getAttribute("aria-label")).toBe("跳转到：今天");
    expect(segs[2]!.getAttribute("aria-label")).toBe("跳转到：今天");
    expect(segs.every((el) => el.style.flexGrow === "1")).toBe(true);
    expect(segs[0]!.style.minHeight).toBe("12px");
  });

  test("悬停段弹卡：该簇用户消息内容预览（两行截断）+ 卡头日期标签 + 行首时间；其他簇不出现", async () => {
    const entries = [
      userEntry("其他簇的消息不应该出现在这一簇的弹卡里", isoDaysAgo(3, 8)),
      userEntry("一".repeat(100), isoDaysAgo(3, 9)),
    ];
    seedStore({ entries, hasMore: true, oldestId: entries[0]!.id });
    harness = await mountRail(entries);

    harness.fireSegmentEnter(1);
    const card = harness.card();
    expect(card).not.toBeNull();
    // 卡头日期标签为 Intl 月日（zh-CN）；预览行：60 字截断含省略号 + 行首时间 HH:MM
    const dayNum = new Date(Date.now() - 3 * 86_400_000).getDate();
    expect(card!.querySelector('[data-testid="nav-rail-segment-label"]')?.textContent).toContain(`${dayNum}日`);
    expect(card!.textContent).toContain(`${"一".repeat(60)}…`);
    expect(card!.textContent).not.toContain("不应该出现在这一簇的弹卡里");
    expect(card!.querySelector('[data-testid="nav-rail-hover-time"]')?.textContent).toMatch(/^\d{2}:\d{2}$/);
    // 单簇段无本地余量：完整段不显示「加载更早」钮（不发起取数）
    expect(harness.moreButton()).toBeNull();
    expect(callLog.length).toBe(0);
  });

  test("不完整簇「加载更早」：fetchPage 带 before 游标（store 最旧 id），取回更早消息成新簇段，取尽后钮隐藏显「无更多」", async () => {
    const older = userEntry("窗外更早那条", isoDaysAgo(3, 8));
    const visible = userEntry("窗内唯一一条", isoDaysAgo(3, 10));
    seedStore({ entries: [visible], hasMore: true, oldestId: visible.id });
    fetchPageImpl = async () => ({
      sessionId: "s1",
      entries: [older, visible],
      leafId: null,
      cursor: null,
      hasMore: false,
      oldestId: older.id,
    });
    harness = await mountRail([visible]);

    expect(harness.segments().length).toBe(1);
    harness.fireSegmentEnter(0);
    expect(harness.moreButton()).not.toBeNull();
    act(() => {
      harness!.moreButton()!.click();
    });
    await settle();

    expect(callLog).toContain(`fetchPage:${visible.id}`);
    // 取回的更早消息成新簇段（1→2 段）；本段取尽：钮隐藏、翻过页显示「无更多」
    expect(harness.segments().length).toBe(2);
    expect(harness.moreButton()).toBeNull();
    expect(harness.card()!.textContent).toContain("无更多");
  });

  test("点击段直接落位：簇分段下段首消息必已加载，不翻页预拉（向上分页由弹卡「加载更早」承担）", async () => {
    const older = userEntry("上一天更早的条目", isoDaysAgo(4, 9));
    const visible = userEntry("今天可见的一条", isoDaysAgo(3, 9));
    seedStore({ entries: [visible], hasMore: true, oldestId: visible.id });
    fetchPageImpl = async () => ({
      sessionId: "s1",
      entries: [older, visible],
      leafId: null,
      cursor: null,
      hasMore: false,
      oldestId: older.id,
    });
    harness = await mountRail([visible]);

    harness.clickSegment(0);
    await act(async () => {});

    // scrollToOffset 直接落位；不发起 fetchPage（段由已加载消息构建，目标必在窗内）
    expect(callLog).toEqual(["scrollToOffset:500"]);
  });

  test("点击完整段：直接落位不翻页", async () => {
    const entries = [userEntry("今天唯一一条", isoDaysAgo(0, 9))];
    seedStore({ entries, hasMore: false, oldestId: null });
    harness = await mountRail(entries);

    harness.clickSegment(0);
    await act(async () => {});

    expect(callLog).toEqual(["scrollToOffset:500"]);
  });

  test("当前位置高亮所在段：视口在顶部时首段点亮，滚到底部后末段点亮", async () => {
    const entries = [
      userEntry("第一条", isoDaysAgo(0, 9)),
      userEntry("第二条", isoDaysAgo(0, 10)),
    ];
    seedStore({ entries });
    const scrollEl = document.createElement("div");
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scrollEl, "scrollTop", { configurable: true, value: 0, writable: true });
    const scrollRef = { current: scrollEl };
    harness = await mountRail(entries, 500, scrollRef);

    // 轨高测量（happy-dom 无布局引擎，clientHeight 桩 200）：设桩后派发 scroll 触发
    // rAF 重算 → railHeight 状态更新 → 段合并密度/当前段重算
    const railEl = harness.host.querySelector<HTMLElement>('[data-testid="nav-rail"]');
    expect(railEl).not.toBeNull();
    Object.defineProperty(railEl, "clientHeight", { configurable: true, value: 200 });
    act(() => {
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    await settle();

    // total 1000、轨高 200 → ratio 0.2：顶部时指示块 0..40，中点 20 → 首段（界 100px）
    const segs = harness.segments();
    expect(segs.length).toBe(2);
    expect(segs[0]!.dataset.active).toBe("true");
    expect(segs[1]!.dataset.active).toBe("false");

    // 滚到中后段：scrollTop 500 → 指示块 top 100..140，中点 120 → 末段
    Object.defineProperty(scrollEl, "scrollTop", { configurable: true, value: 500, writable: true });
    act(() => {
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    await settle();

    expect(harness.segments()[0]!.dataset.active).toBe("false");
    expect(harness.segments()[1]!.dataset.active).toBe("true");
  });
});
