// nav-rail 指示器带单测（OpenChamber v1.24.2 复刻）：活动段判定纯函数（顶边
// scrollTop+100px 最后一段 / 距底 max(48,10% viewport) 取最后段）；带体段合并上限
// 30 格；悬停面板 = 全部用户消息迷你列表（160 字符截断、无时间行）；面板滚轮 54px
// 步进改高亮行；点击带体按指针 Y 选段跳转 + 活动指示 pin 2500ms 防回拖；「加载更早」
// 顶部圆钮按 before 游标（store 最旧 id）翻页。渲染走真实组件（happy-dom +
// createRoot，旧 harness 同款）；virtualizer 以最小桩满足只读消费面；store 直注；
// 翻页经 fetchPage 注入桩。测试语言锁 zh-CN（setup-locale.ts）。
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
const { NavRail, tapeStartOf, tickWidthOf } = await import("@/components/chat/nav-rail");
const { useMessagesStore } = await import("@/stores/messages");
const { buildTicks, buildSegments, pickActiveSegmentIndex, BAND_MAX_SEGMENTS, PITCH_PX } =
  await import("@/components/chat/nav-rail-segments");
type NavTick = Awaited<ReturnType<typeof buildTicks>>[number];

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

let seq = 0;
function userEntry(text: string): WireEntry {
  seq += 1;
  return {
    type: "message",
    id: `u${seq}`,
    timestamp: "2026-11-08T12:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
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

/** 调用序日志：fetchPage / scrollToOffset 按发生顺序入列 */
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

/** virtualizer 最小桩：每下标可指定测量起点（段顶边判定/点击落位断言用） */
function stubVirtualizer(starts: number[]) {
  return {
    getTotalSize: () => 1000,
    measurementsCache: starts.map((start) => ({ start, size: 100 })),
    scrollToOffset: (start: number) => {
      callLog.push(`scrollToOffset:${start}`);
    },
  };
}

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

interface Harness {
  host: HTMLElement;
  band: () => HTMLElement;
  segments: () => HTMLElement[];
  card: () => HTMLElement | null;
  rows: () => HTMLElement[];
  loadEarlier: () => HTMLButtonElement | null;
  /** 指针悬停带体（clientY → 12px 取整映射最近格） */
  hoverBand: (clientY: number) => void;
  /** 点击带体（clientY → 最近段跳转 + pin） */
  clickBand: (clientY: number) => void;
  scrollRail: (scrollTop: number) => void;
  unmount: () => Promise<void>;
}

async function mountRail(
  entries: WireEntry[],
  starts: number[],
  scrollEl?: HTMLDivElement,
): Promise<Harness> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const scrollRef = { current: scrollEl ?? null };
  const el = createElement(HarnessRail, {
    sessionId: "s1",
    scrollRef: scrollRef as { current: null },
    virtualizer: stubVirtualizer(starts),
  });
  await act(async () => {
    root.render(el);
  });
  const bandEl = () => {
    const el = host.querySelector<HTMLElement>('[data-testid="nav-rail-band"]');
    if (!el) throw new Error("指示器带不存在");
    return el;
  };
  return {
    host,
    band: bandEl,
    segments: () =>
      Array.from(host.querySelectorAll<HTMLElement>('[data-testid="nav-rail-segment"]')),
    card: () => host.querySelector<HTMLElement>('[data-testid="nav-rail-hover-card"]'),
    rows: () =>
      Array.from(host.querySelectorAll<HTMLElement>('[data-testid="nav-rail-hover-row"]')),
    loadEarlier: () =>
      host.querySelector<HTMLButtonElement>('[data-testid="nav-rail-load-earlier"]'),
    hoverBand: (clientY: number) => {
      act(() => {
        bandEl().dispatchEvent(
          new MouseEvent("pointermove", { bubbles: true, clientY }),
        );
      });
    },
    clickBand: (clientY: number) => {
      act(() => {
        bandEl().dispatchEvent(new MouseEvent("click", { bubbles: true, clientY }));
      });
    },
    scrollRail: (scrollTop: number) => {
      if (!scrollEl) throw new Error("未注入滚动容器");
      Object.defineProperty(scrollEl, "scrollTop", { configurable: true, value: scrollTop });
      act(() => {
        scrollEl.dispatchEvent(new Event("scroll"));
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** act 内排空微任务与一帧：scroll rAF 判定与异步续体全部落定 */
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

describe("nav-rail 活动段判定纯函数", () => {
  const offs = [0, 200, 400, 600];

  test("顶边 ≤ scrollTop+100px 的最后一段", () => {
    expect(pickActiveSegmentIndex(offs, { scrollTop: 0, viewportH: 200, totalSize: 1000 })).toBe(0);
    expect(pickActiveSegmentIndex(offs, { scrollTop: 250, viewportH: 200, totalSize: 1000 })).toBe(1);
    expect(pickActiveSegmentIndex(offs, { scrollTop: 350, viewportH: 200, totalSize: 1000 })).toBe(2);
  });

  test("距底 ≤ max(48px, 10% viewport) 或粘底取最后段", () => {
    // gap 30 ≤ max(48, 20) → 最后段（顶边判定本会落在中间段）
    expect(pickActiveSegmentIndex(offs, { scrollTop: 380, viewportH: 200, totalSize: 620 })).toBe(3);
    // gap 100 > max(48, 40) → 顶边判定生效（非最后段）
    expect(
      pickActiveSegmentIndex([0, 300, 500, 800], { scrollTop: 500, viewportH: 400, totalSize: 1000 }),
    ).toBe(2);
    // 粘底（gap < 0）
    expect(pickActiveSegmentIndex(offs, { scrollTop: 900, viewportH: 200, totalSize: 1000 })).toBe(3);
  });

  test("空段集返回 0", () => {
    expect(pickActiveSegmentIndex([], { scrollTop: 0, viewportH: 200, totalSize: 1000 })).toBe(0);
  });
});

describe("nav-rail 带体纯函数", () => {
  test("段合并上限 30 格：带高 = min(段数,30) * 12px，合并后权和守恒", () => {
    const entries = Array.from({ length: 40 }, (_, i) => userEntry(`第${i + 1}条`));
    const merged = buildSegments(ticksOf(entries));
    expect(merged.length).toBe(BAND_MAX_SEGMENTS);
    expect(merged.reduce((acc, s) => acc + s.count, 0)).toBe(40);
    expect(Math.min(40, BAND_MAX_SEGMENTS) * PITCH_PX).toBe(360);
    expect(Math.min(5, BAND_MAX_SEGMENTS) * PITCH_PX).toBe(60);
  });

  test("刻度宽度：普通 10 / active 14 / 悬停聚焦 20 邻近衰减 [1,0.6,0.35,0.15]", () => {
    expect(tickWidthOf(2, 2, null)).toBe(14);
    expect(tickWidthOf(2, -1, 2)).toBe(20);
    expect(tickWidthOf(3, -1, 2)).toBe(16); // 10 + 10*0.6
    expect(tickWidthOf(4, -1, 2)).toBe(13.5); // 10 + 10*0.35
    expect(tickWidthOf(5, -1, 2)).toBe(11.5); // 10 + 10*0.15
    expect(tickWidthOf(6, -1, 2)).toBe(10); // 衰减区外
    expect(tickWidthOf(2, 2, 2)).toBe(14); // active 优先于悬停
  });

  test("tape 滑动起点：段数 ≤ 30 不滑；超出时活动段尽量居中并钳界", () => {
    expect(tapeStartOf(20, 18)).toBe(0);
    expect(tapeStartOf(40, 0)).toBe(0);
    expect(tapeStartOf(40, 15)).toBe(0);
    expect(tapeStartOf(40, 25)).toBe(10);
    expect(tapeStartOf(40, 39)).toBe(10); // 钳上界 40-30
  });
});

describe("nav-rail 指示器带（组件）", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.unmount();
      harness = null;
    }
  });

  test("显示条件段数 ≥ 2：单条用户消息不渲染导航轨", async () => {
    seedStore({ entries: [userEntry("唯一一条")] });
    harness = await mountRail([userEntry("唯一一条")], [0]);
    expect(harness.host.querySelector('[data-testid="nav-rail"]')).toBeNull();
  });

  test("悬停面板 = 全部用户消息迷你列表：160 字符截断、无时间行、活动行实心标记", async () => {
    const e1 = userEntry("第一条消息");
    const e2 = userEntry("二".repeat(200));
    seedStore({ entries: [e1, e2] });
    harness = await mountRail([e1, e2], [0, 800]);

    harness.hoverBand(14); // y=14 → 格 1
    const card = harness.card();
    expect(card).not.toBeNull();
    const rows = harness.rows();
    expect(rows.length).toBe(2); // 全部用户消息，非单卡
    expect(rows[0]!.textContent).toBe("第一条消息");
    // 160 字符截断含省略号；无时间行无头像（OC 无）
    expect(rows[1]!.textContent).toBe(`${"二".repeat(160)}…`);
    expect(harness.host.querySelector('[data-testid="nav-rail-hover-time"]')).toBeNull();
    // 指针落在格 1 → 高亮行 = 段 1 首行（行 1）
    expect(rows[1]!.querySelector("[data-hl=true]")).not.toBeNull();
    expect(rows[0]!.querySelector("[data-hl=true]")).toBeNull();
  });

  test("面板滚轮 54px 步进：高亮行随滚轮方向移动并钳在行界", async () => {
    const e1 = userEntry("第一条消息");
    const e2 = userEntry("第二条消息");
    seedStore({ entries: [e1, e2] });
    harness = await mountRail([e1, e2], [0, 800]);
    harness.hoverBand(4); // 格 0 → 高亮行 0

    const rows = harness.rows();
    expect(rows[0]!.querySelector("[data-hl=true]")).not.toBeNull();
    const list = harness.host.querySelector('[data-testid="nav-rail-panel-list"]');
    expect(list).not.toBeNull();

    act(() => {
      list!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 54 }));
    });
    expect(harness.rows()[1]!.querySelector("[data-hl=true]")).not.toBeNull();

    // 再向下钳在末行；向上步回 0
    act(() => {
      list!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 54 }));
    });
    expect(harness.rows()[1]!.querySelector("[data-hl=true]")).not.toBeNull();
    act(() => {
      list!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -54 }));
    });
    act(() => {
      list!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -54 }));
    });
    expect(harness.rows()[0]!.querySelector("[data-hl=true]")).not.toBeNull();
  });

  test("点击带体按指针 Y 选最近段跳转，活动指示 pin 该段防回拖", async () => {
    const e1 = userEntry("第一条消息");
    const e2 = userEntry("第二条消息");
    seedStore({ entries: [e1, e2] });
    const scrollEl = document.createElement("div");
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scrollEl, "scrollTop", { configurable: true, value: 0, writable: true });
    harness = await mountRail([e1, e2], [0, 800], scrollEl);

    // 点击 y=14 → 段 1：scrollToOffset 落段 1 测量起点 800
    harness.clickBand(14);
    await act(async () => {});
    expect(callLog).toContain("scrollToOffset:800");
    // pin 生效：滚动判定会把活动段算回段 0（顶边 0 ≤ 100），指示仍钉在段 1
    harness.scrollRail(0);
    await settle();
    const segs = harness.segments();
    expect(segs[1]!.dataset.active).toBe("true");
    expect(segs[0]!.dataset.active).toBe("false");
    // 点击后面板关闭
    expect(harness.card()).toBeNull();
  });

  test("无 pin 时活动段随 scroll 判定：顶边阈值切换段；距底取最后段", async () => {
    const e1 = userEntry("第一条消息");
    const e2 = userEntry("第二条消息");
    seedStore({ entries: [e1, e2] });
    const scrollEl = document.createElement("div");
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scrollEl, "scrollTop", { configurable: true, value: 0, writable: true });
    harness = await mountRail([e1, e2], [0, 800], scrollEl);
    await settle();

    const segs = harness.segments();
    expect(segs.length).toBe(2);
    // 顶部：顶边 0 ≤ 100 → 段 0；段 1 顶边 800 > 100
    expect(segs[0]!.dataset.active).toBe("true");
    // 滚到 800：顶边 800 ≤ 900 → 段 1
    harness.scrollRail(800);
    await settle();
    expect(segs[1]!.dataset.active).toBe("true");
    expect(segs[0]!.dataset.active).toBe("false");
    // 滚回顶部（无 pin）→ 段 0
    harness.scrollRail(0);
    await settle();
    expect(segs[0]!.dataset.active).toBe("true");
  });

  test("「加载更早」顶部圆钮：hasMore 时渲染，点击按 before 游标（store 最旧 id）翻页", async () => {
    const e1 = userEntry("窗内一条");
    const e2 = userEntry("窗内两条");
    seedStore({ entries: [e1, e2], hasMore: true, oldestId: e1.id });
    const older = userEntry("窗外更早那条");
    fetchPageImpl = async () => ({
      sessionId: "s1",
      entries: [older, e1, e2],
      leafId: null,
      cursor: null,
      hasMore: false,
      oldestId: older.id,
    });
    harness = await mountRail([e1, e2], [0, 800]);

    const btn = harness.loadEarlier();
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-label")).toBe("加载更早");
    act(() => {
      btn!.click();
    });
    await settle();
    expect(callLog).toContain(`fetchPage:${e1.id}`);
    // 取回更早消息成新段（2→3 段），无更多后钮消失
    expect(harness.segments().length).toBe(3);
    expect(harness.loadEarlier()).toBeNull();
  });
});
