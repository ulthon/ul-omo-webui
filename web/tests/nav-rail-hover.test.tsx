// NavRail 悬停浮卡单测：原生 title 已移除，悬停刻度即时显示受控浮卡（含 40 字摘要与
// 条目时间戳），移出后 100ms 内隐藏（fake timers 驱动，不真等）。渲染走真实组件
// （happy-dom + createRoot，tip-card 同款）；virtualizer 以最小桩满足只读消费面
// （getTotalSize/measurementsCache），store 直注。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { NavRail } = await import("@/components/chat/nav-rail");
const { useMessagesStore } = await import("@/stores/messages");

const USER_ENTRY = {
  type: "message",
  id: "e1",
  timestamp: "2026-10-26T10:30:00Z",
  message: { role: "user", content: [{ type: "text", text: "帮我总结一下这段长文本的要点内容" }] },
};

function seedStore() {
  useMessagesStore.setState({
    bySession: {
      s1: {
        entries: [USER_ENTRY],
        cursor: null,
        leafId: null,
        loaded: true,
        hasMore: false,
        oldestId: null,
        streaming: false,
        streamingMessage: null,
        streamingEntryId: null,
        toolRuns: {},
        compacting: null,
      },
    },
  });
}

function stubVirtualizer() {
  return {
    getTotalSize: () => 1000,
    measurementsCache: [{ start: 500, size: 100 }],
    scrollToOffset: () => {},
  };
}

interface Harness {
  host: HTMLElement;
  tick: () => HTMLElement | null;
  card: () => HTMLElement | null;
  fireTick: (type: string) => void;
  unmount: () => Promise<void>;
}

async function mountRail(): Promise<Harness> {
  seedStore();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const scrollRef = { current: null };
  const items = [{ key: "k1", kind: "entry", entryId: "e1", interrupted: false, model: null }];
  const props = {
    items,
    sessionId: "s1",
    scrollRef,
    virtualizer: stubVirtualizer(),
  };
  await act(async () => {
    root.render(createElement(NavRail, props));
  });
  const tickEl = () => host.querySelector<HTMLElement>('[data-testid="nav-rail-tick"]');
  const fireTick = (type: string) => {
    const el = tickEl();
    if (!el) throw new Error(`tick 不存在，无法派发 ${type}`);
    act(() => {
      // React 自 onMouseEnter/onMouseLeave 由根节点的 mouseover/mouseout 合成
      if (type === "mouseover") {
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseenter"));
      } else {
        el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseleave"));
      }
    });
  };
  return {
    host,
    tick: tickEl,
    card: () => host.querySelector<HTMLElement>('[data-testid="nav-rail-hover-card"]'),
    fireTick,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("NavRail 悬停浮卡", () => {
  let harness: Harness | null = null;
  const win = (globalThis as { window?: unknown }).window as unknown as { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  let origSetTimeout = win.setTimeout;
  let origClearTimeout = win.clearTimeout;

  afterEach(async () => {
    vi.useRealTimers();
    win.setTimeout = origSetTimeout;
    win.clearTimeout = origClearTimeout;
    if (harness) {
      await harness.unmount();
      harness = null;
    }
  });

  test("悬停刻度即时渲染浮卡：含摘要文本、无原生 title 属性", async () => {
    harness = await mountRail();
    const tickEl = harness.tick();
    expect(tickEl).not.toBeNull();
    expect(tickEl!.getAttribute("title")).toBeNull();

    harness.fireTick("mouseover");

    const card = harness.card();
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("帮我总结一下这段长文本的要点内容");
    expect(card!.querySelector('[data-testid="nav-rail-hover-time"]')?.textContent).toMatch(/^\d{2}:\d{2}$/);
  });

  test("移出后 100ms 内浮卡卸载（fake timers，不真等）", async () => {
    vi.useFakeTimers();
    // happy-dom 的 window.setTimeout 与 globalThis.setTimeout 是两份实现，vitest 假钟只换
    // 全局那份；组件走 window.setTimeout，这里桥接到假钟实现后再驱动
    window.setTimeout = globalThis.setTimeout as unknown as typeof window.setTimeout;
    window.clearTimeout = globalThis.clearTimeout as unknown as typeof window.clearTimeout;
    harness = await mountRail();

    harness.fireTick("mouseover");
    expect(harness.card()).not.toBeNull();

    harness.fireTick("mouseout");
    act(() => vi.advanceTimersByTime(99));
    expect(harness.card()).not.toBeNull(); // 100ms 内不隐藏

    act(() => vi.advanceTimersByTime(1));
    expect(harness.card()).toBeNull(); // 恰在 100ms 边界卸载
  });
});
