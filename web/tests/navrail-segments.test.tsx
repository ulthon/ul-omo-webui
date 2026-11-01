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

async function mountRail(entries: WireEntry[], scrollStart = 500): Promise<Harness> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const el = createElement(HarnessRail, {
    sessionId: "s1",
    scrollRef: { current: null },
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

describe("nav-rail 分段指示器", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.unmount();
      harness = null;
    }
  });

  test("跨 3 天 entries 聚合 3 段：标签按旧→新为 Intl 月日/昨天/今天，段高权重=段内用户消息数", async () => {
    // 3 天前 2 条用户消息、昨天 1 条（夹 1 条 assistant 不计）、今天 3 条
    const entries = [
      userEntry("三天前第一条", isoDaysAgo(3, 9)),
      userEntry("三天前第二条", isoDaysAgo(3, 10)),
      assistantEntry(isoDaysAgo(1, 9)),
      userEntry("昨天那条", isoDaysAgo(1, 10)),
      userEntry("今天一", isoDaysAgo(0, 9)),
      userEntry("今天二", isoDaysAgo(0, 10)),
      userEntry("今天三", isoDaysAgo(0, 11)),
    ];
    seedStore({ entries });
    harness = await mountRail(entries);

    const segs = harness.segments();
    expect(segs.length).toBe(3);
    const dayNum = new Date(Date.now() - 3 * 86_400_000).getDate();
    // DOM 序 = 时间线旧→新：最旧段 Intl 月日标签、中段昨天、末段今天（日期标签在 aria-label）
    expect(segs[0].getAttribute("aria-label")).toContain(`${dayNum}日`);
    expect(segs[0].getAttribute("aria-label")).toContain("月");
    expect(harness.segment(1).getAttribute("aria-label")).toBe("跳转到：昨天");
    expect(harness.segment(2).getAttribute("aria-label")).toBe("跳转到：今天");
    // 段高权重 = 段内用户消息数（flexGrow 行内样式），最小可点高 12px
    expect(segs[0].style.flexGrow).toBe("2");
    expect(segs[1].style.flexGrow).toBe("1");
    expect(segs[2].style.flexGrow).toBe("3");
    expect(segs[0].style.minHeight).toBe("12px");
  });

  test("悬停段弹卡：段标签 + 该天最近 3 条用户消息（时间 + 60 字摘要），更早的不显示", async () => {
    const entries = [
      userEntry("三天前最早的那条消息不应该出现在默认弹卡里", isoDaysAgo(3, 8)),
      userEntry("一".repeat(100), isoDaysAgo(3, 9)),
      userEntry("三天前第三条", isoDaysAgo(3, 10)),
      userEntry("三天前最新一条", isoDaysAgo(3, 11)),
    ];
    seedStore({ entries, hasMore: true, oldestId: entries[0].id });
    harness = await mountRail(entries);

    harness.fireSegmentEnter(0);
    const card = harness.card();
    expect(card).not.toBeNull();
    // 段标签为 Intl 月日（zh-CN），非今天/昨天
    const dayNum = new Date(Date.now() - 3 * 86_400_000).getDate();
    expect(card!.querySelector('[data-testid="nav-rail-segment-label"]')?.textContent).toContain(`${dayNum}日`);
    // 最近 3 条（9/10/11 点）：长文本 60 字截断含省略号；时间行 HH:MM
    expect(card!.textContent).toContain(`${"一".repeat(60)}…`);
    expect(card!.textContent).toContain("三天前最新一条");
    expect(card!.textContent).not.toContain("不应该出现在默认弹卡里");
    const time = card!.querySelector('[data-testid="nav-rail-hover-time"]');
    expect(time?.textContent).toMatch(/^\d{2}:\d{2}$/);
    // 本地还有余量（4 条 > 3 条）：钮可见且未发起取数
    expect(harness.moreButton()).not.toBeNull();
    expect(callLog.length).toBe(0);
  });

  test("点「加载更早」：本地余量取尽后 fetchPage 带 before 游标（store 最旧 id），取回并入弹卡", async () => {
    const first = userEntry("最早第一条", isoDaysAgo(3, 8));
    const second = userEntry("最早第二条", isoDaysAgo(3, 9));
    const latest = userEntry("窗口内最新一条", isoDaysAgo(3, 10));
    // 已加载窗只有 2 条（first 在窗外，靠 before 游标取回）
    seedStore({ entries: [second, latest], hasMore: true, oldestId: second.id });
    fetchPageImpl = async () => ({
      sessionId: "s1",
      entries: [first, second],
      leafId: null,
      cursor: null,
      hasMore: false,
      oldestId: first.id,
    });
    harness = await mountRail([second, latest]);

    harness.fireSegmentEnter(0);
    expect(harness.moreButton()).not.toBeNull();
    act(() => {
      harness!.moreButton()!.click();
    });
    await settle();

    expect(callLog).toContain(`fetchPage:${second.id}`);
    const card = harness.card();
    expect(card).not.toBeNull();
    // 取回的更早消息并入弹卡；无更多：hasMore 已尽 → 钮隐藏、翻过页显示「无更多」
    expect(card!.textContent).toContain("最早第一条");
    expect(harness.moreButton()).toBeNull();
    expect(card!.textContent).toContain("无更多");
  });

  test("点击不完整段：先按 before 游标翻页取到该段，再 scrollToOffset 落位（断言调用序）", async () => {
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
    await settle();

    // 调用序：fetchPage(before=store 最旧 id) 先于 scrollToOffset
    expect(callLog[0]).toBe(`fetchPage:${visible.id}`);
    expect(callLog[1]).toBe("scrollToOffset:500");
    // 定位态已复位
    expect(harness.segment(0).getAttribute("aria-busy")).toBeNull();
  });

  test("点击完整段：直接落位不翻页", async () => {
    const entries = [userEntry("今天唯一一条", isoDaysAgo(0, 9))];
    seedStore({ entries, hasMore: false, oldestId: null });
    harness = await mountRail(entries);

    harness.clickSegment(0);
    await act(async () => {});

    expect(callLog).toEqual(["scrollToOffset:500"]);
  });
});
