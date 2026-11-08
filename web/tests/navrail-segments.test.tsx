// nav-rail 角标+面板单测（OC v2.7.0 换装形态）：亮格等比映射纯函数（条数 ≤5 亮
// min(n,5)，>5 按阅读位置映射 1..5）；面板内 Load more 分页循环终止条件（至少新增
// 1 条用户消息或 hasMore=false 才停）；前插后选中行索引平移补偿 + 列表 scrollTop
// 锚定（不跳）；点击行跳转（scrollToOffset）+ 面板保留 + 选中实心行 = 所点行。
// 渲染走真实组件（happy-dom + createRoot，旧 harness 同款）；virtualizer 以最小桩
// 满足只读消费面；store 直注；翻页经 fetchPage 注入桩。测试语言锁 zh-CN
// （setup-locale.ts）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
const {
  buildTicks,
  countUserPrompts,
  litCountOf,
  pickActiveSegmentIndex,
} = await import("@/components/chat/nav-rail-segments");
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

function seedStore(entries: WireEntry[], paging?: { hasMore: boolean; oldestId: string | null }) {
  useMessagesStore.setState({
    bySession: {
      s1: {
        entries,
        cursor: null,
        leafId: null,
        loaded: true,
        hasMore: paging?.hasMore ?? false,
        oldestId: paging?.oldestId ?? null,
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
/** 每次调 fetchPage 弹出一个页（空数组 = 无新增用户消息） */
let pageQueue: { entries: WireEntry[]; hasMore: boolean; oldestId: string | null }[] = [];
const fetchPageSpy = (opts: { before?: string; full?: boolean }) => {
  callLog.push(`fetchPage:${opts.before ?? ""}`);
  const page = pageQueue.shift() ?? { entries: [], hasMore: false, oldestId: null };
  return Promise.resolve({
    sessionId: "s1",
    entries: page.entries,
    leafId: null,
    cursor: null,
    hasMore: page.hasMore,
    oldestId: page.oldestId,
  } satisfies MessagesPage);
};

/** virtualizer 最小桩：每下标可指定测量起点（活动位置判定/点击落位断言用） */
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
  indicator: () => HTMLElement;
  panel: () => HTMLElement;
  rows: () => HTMLElement[];
  activeRow: () => HTMLElement | null;
  loadMore: () => HTMLButtonElement | null;
  list: () => HTMLElement | null;
  openPanel: () => void;
  clickRow: (i: number) => void;
  clickLoadMore: () => Promise<void>;
  scrollRail: (scrollTop: number) => void;
  unmount: () => Promise<void>;
}

async function mountRail(
  entries: WireEntry[],
  starts: number[],
  paging?: { hasMore: boolean; oldestId: string | null },
): Promise<Harness> {
  seedStore(entries, paging);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const scrollRef = { current: null };
  const el = createElement(HarnessRail, {
    sessionId: "s1",
    scrollRef: scrollRef as { current: null },
    virtualizer: stubVirtualizer(starts),
  });
  await act(async () => {
    root.render(el);
  });
  return {
    host,
    indicator: () => {
      const el = host.querySelector<HTMLElement>('[data-testid="nav-rail-indicator"]');
      if (!el) throw new Error("角标不存在");
      return el;
    },
    panel: () => {
      const el = host.querySelector<HTMLElement>('[data-testid="nav-rail-panel"]');
      if (!el) throw new Error("面板不存在");
      return el;
    },
    rows: () =>
      Array.from(
        host.querySelectorAll<HTMLElement>(
          '[data-testid="nav-rail-prompt-row"], [data-testid="nav-rail-prompt-row-active"]',
        ),
      ),
    activeRow: () =>
      host.querySelector<HTMLElement>('[data-testid="nav-rail-prompt-row-active"]'),
    loadMore: () =>
      host.querySelector<HTMLButtonElement>('[data-testid="nav-rail-load-more"]'),
    list: () =>
      host.querySelector<HTMLElement>('[data-testid="nav-rail-panel"] > div:last-child'),
    openPanel: () => {
      act(() => {
        host
          .querySelector<HTMLElement>('[data-testid="nav-rail-indicator"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    clickRow: (i: number) => {
      const row = host.querySelectorAll<HTMLElement>(
        '[data-testid="nav-rail-prompt-row"], [data-testid="nav-rail-prompt-row-active"]',
      )[i];
      if (!row) throw new Error(`行 ${i} 不存在`);
      act(() => {
        row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    clickLoadMore: async () => {
      const btn = host.querySelector<HTMLButtonElement>(
        '[data-testid="nav-rail-load-more"]',
      );
      if (!btn) throw new Error("Load more 按钮不存在");
      await act(async () => {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
    },
    scrollRail: (scrollTop: number) => {
      const scrollEl = scrollRef.current;
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

beforeEach(() => {
  callLog.length = 0;
  pageQueue = [];
  seq = 0;
});

afterEach(() => {
  useMessagesStore.setState({ bySession: {} });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("litCountOf 亮格映射", () => {
  test("条数 ≤5 时亮 min(条数, 5)", () => {
    expect(litCountOf(0, 0)).toBe(0);
    expect(litCountOf(2, 0)).toBe(2);
    expect(litCountOf(3, 2)).toBe(3);
    expect(litCountOf(5, 4)).toBe(5);
  });

  test("条数 >5 时按阅读位置等比映射 1..5", () => {
    expect(litCountOf(10, 0)).toBe(1);
    expect(litCountOf(10, 9)).toBe(5);
    expect(litCountOf(10, 4)).toBe(3); // 4/9 ≈ 0.44 → round(1+1.78)=3
    expect(litCountOf(21, 10)).toBe(3); // 中位 → 3
    expect(litCountOf(10, -5)).toBe(1); // 越界钳位
    expect(litCountOf(10, 99)).toBe(5);
  });
});

describe("countUserPrompts 分页计数", () => {
  test("只数带文本的用户消息（assistant/纯图不计）", () => {
    const entries = [
      userEntry("a"),
      {
        type: "message",
        id: "a1",
        timestamp: "x",
        message: { role: "assistant", content: [{ type: "text", text: "b" }] },
      } as WireEntry,
      userEntry("c"),
    ];
    expect(countUserPrompts(entries)).toBe(2);
  });
});

describe("pickActiveSegmentIndex（沿用，供亮格跟随）", () => {
  test("顶边 ≤ scrollTop+100 的最后一段；距底取最后段", () => {
    const offs = [0, 300, 600, 900];
    expect(pickActiveSegmentIndex(offs, { scrollTop: 0, viewportH: 400, totalSize: 2000 })).toBe(0);
    expect(pickActiveSegmentIndex(offs, { scrollTop: 350, viewportH: 400, totalSize: 2000 })).toBe(1);
    expect(pickActiveSegmentIndex(offs, { scrollTop: 1600, viewportH: 400, totalSize: 2000 })).toBe(3);
  });
});

describe("面板分页（Load more 循环）", () => {
  test("翻到新增 1 条用户消息即停（终止条件一）", async () => {
    const entries = [userEntry("m1"), userEntry("m2"), userEntry("m3")];
    const old1 = userEntry("old1");
    // 第一窗空回（无新增，hasMore 仍真）→ 第二窗回 1 条即达标停
    pageQueue = [
      { entries: [], hasMore: true, oldestId: "cursor2" },
      { entries: [old1], hasMore: false, oldestId: null },
    ];
    seedStore(entries, { hasMore: true, oldestId: "cursor1" });
    const h = await mountRail(entries, [0, 100, 200], { hasMore: true, oldestId: "cursor1" });
    h.openPanel();
    expect(h.loadMore()).not.toBeNull();
    // 循环在单次点击内自旋：空窗续翻，直到新增 1 条或 hasMore=false
    await h.clickLoadMore();
    expect(callLog.filter((c) => c.startsWith("fetchPage")).length).toBe(2);
    expect(h.rows().length).toBe(4);
    await h.unmount();
  });

  test("hasMore=false 且零新增也停（终止条件二）", async () => {
    const entries = [userEntry("m1"), userEntry("m2")];
    pageQueue = [{ entries: [], hasMore: false, oldestId: null }];
    seedStore(entries, { hasMore: true, oldestId: "cursor1" });
    const h = await mountRail(entries, [0, 100], { hasMore: true, oldestId: "cursor1" });
    h.openPanel();
    await h.clickLoadMore();
    expect(callLog.filter((c) => c.startsWith("fetchPage")).length).toBe(1);
    // 无更早后按钮消失（尾注态由 UI 呈现）
    expect(h.loadMore()).toBeNull();
    await h.unmount();
  });

  test("前插后选中行索引平移补偿 + scrollTop 锚定（不跳）", async () => {
    const entries = [userEntry("m1"), userEntry("m2"), userEntry("m3")];
    // 前插 2 条旧消息
    const old1 = userEntry("old1");
    const old2 = userEntry("old2");
    pageQueue = [{ entries: [old1, old2], hasMore: false, oldestId: null }];
    seedStore(entries, { hasMore: true, oldestId: "cursor1" });
    const h = await mountRail(entries, [0, 100, 200], { hasMore: true, oldestId: "cursor1" });
    h.openPanel();
    // 点中第 2 行（新序中应平移到下标 3）
    h.clickRow(1);
    expect(h.activeRow()?.textContent).toContain("m2");
    const list = h.list();
    expect(list).not.toBeNull();
    // 刷帧：等 openPanel 的双 rAF 居中回调先落定，再置锚定滚动位
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
    // 锚定：面板列表滚动位手动置位，翻页后保持
    Object.defineProperty(list!, "scrollTop", { configurable: true, writable: true, value: 77 });
    await h.clickLoadMore();
    expect(h.rows().length).toBe(5);
    // 平移补偿：选中行 = m2（原下标 1 + 新增 2）
    expect(h.activeRow()?.textContent).toContain("m2");
    const activeIdx = h.rows().findIndex((r) => r === h.activeRow());
    expect(activeIdx).toBe(3);
    // scrollTop 锚定：happy-dom 无布局（offsetTop 恒 0），锚定式回写 = 原值
    expect(list!.scrollTop).toBe(77);
    await h.unmount();
  });
});

describe("点击行交互", () => {
  test("点击行跳转 + 面板保留 + 选中实心行 = 所点行", async () => {
    const entries = [userEntry("m1"), userEntry("m2"), userEntry("m3")];
    seedStore(entries);
    const h = await mountRail(entries, [0, 100, 200]);
    h.openPanel();
    expect(h.panel()).not.toBeNull();
    h.clickRow(2);
    // 跳转走 scrollToOffset（测量桩起点 200）
    expect(callLog).toContain("scrollToOffset:200");
    // 面板不关，选中 = 所点行
    expect(h.panel()).not.toBeNull();
    expect(h.activeRow()?.textContent).toContain("m3");
    const rows = h.rows();
    expect(rows[2]).toEqual(h.activeRow());
    await h.unmount();
  });

  test("段数 <2 不渲染角标", async () => {
    seedStore([userEntry("only")]);
    const h = await mountRail([userEntry("only")], [0]);
    expect(() => h.indicator()).toThrow();
    await h.unmount();
  });
});
