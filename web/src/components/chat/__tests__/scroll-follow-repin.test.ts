// 打开后视角跑上面修复（2026-11-25）组件行为：真实 createRoot+act 渲染 MessageList，行为经
// diag 埋点与回底钮 DOM 断言。滚动容器的 clientHeight/scrollHeight/scrollTop 以可控属性注入
// ——happy-dom 无布局，这些数值只是驱动 atBottom/movedUp 判定的状态转移，不以它们断言布局。
// - 内容变高（scrollTop 不动、scrollHeight 涨）引起的 scroll 事件：不解除跟随，回底一次，
//   （旧实现在此记 follow_flip to=false，视角停在旧位置；回底钮几何归真浏览器验证）；
// - 位置真的往上走：解除跟随（src=scroll movedUp=true），回底钮出现，之后内容再变高零回底；
// - 滚回底部：恢复跟随，回底钮消失；
// - 内容尺寸变化无 scroll 事件（ResizeObserver 通知）：跟随态回底，非跟随态零动作；observe
//   起始通知跳过（不与首开定位重复）。ResizeObserver 用登记式 stub（登记回调与 observe 目标）。
// 假定时器仅 fake setTimeout/clearTimeout（首开定位 stage2 的 100ms 补滚），rAF 走 happy-dom
// setImmediate 通道，Date.now 保持真实（程序滚动护栏窗计时语义不变，越窗用 Date.now 拨钟）。
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

window.matchMedia = ((query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MessageList } = await import("@/components/chat/message-list");
const { useMessagesStore } = await import("@/stores/messages");
const { diag } = await import("@/lib/diag");

const SID = "test-follow-repin";
const item = (key: string) => ({ key, kind: "streaming" as const });

/** 登记式 ResizeObserver：记录回调与 observe 目标，通知由测试显式触发 */
type RoCallback = (entries: unknown[], observer: ResizeObserver) => void;
class CapturingResizeObserver {
  static instances: CapturingResizeObserver[] = [];
  readonly targets: Element[] = [];
  readonly cb: RoCallback;
  constructor(cb: RoCallback) {
    this.cb = cb;
    CapturingResizeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {}
}

/** 可控滚动几何：clientHeight 固定 500，scrollHeight 可改，scrollTop 可写；初态贴底 */
function instrument(el: HTMLElement): { setScrollHeight: (h: number) => void } {
  let scrollHeight = 1000;
  let scrollTop = 500;
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 500 });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  return { setScrollHeight: (h) => {
    scrollHeight = h;
  } };
}

/** 越过程序滚动护栏窗（600ms，Date.now 计时）：确定性地把时钟拨过护栏，无真实等待 */
async function withGuardExpired(fn: () => void): Promise<void> {
  const realNow = Date.now;
  const spy = vi.spyOn(Date, "now").mockReturnValue(realNow() + 700);
  try {
    await act(async () => fn());
  } finally {
    spy.mockRestore();
  }
}

describe("scroll 事件下的跟随决策（2026-11-25 打开后视角跑上面修复）", () => {
  let host: HTMLElement | null = null;
  let root: { unmount(): void } | null = null;
  let diagSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scrollEl: HTMLElement;
  let geometry: ReturnType<typeof instrument>;

  const flips = (): Array<Record<string, unknown>> => {
    const calls = (diagSpy?.mock.calls ?? []) as unknown as Array<Array<unknown>>;
    return calls.filter((c: Array<unknown>) => c[1] === "follow_flip").map((c: Array<unknown>) => c[2] as Record<string, unknown>);
  };
  const toAnchorCount = (): number => {
    const calls = (diagSpy?.mock.calls ?? []) as unknown as Array<Array<unknown>>;
    return calls.filter((c: Array<unknown>) => c[1] === "to_anchor").length;
  };
  const jumpButton = (): Element | null => host!.querySelector('[data-testid="jump-bottom"]');
  /** 等一帧 rAF（happy-dom 走 setImmediate 通道），让共享调度器的回底执行 */
  async function flushFrame(): Promise<void> {
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
  }
  /** 一次用户/布局滚动事件：写位置（驱动 atBottom/movedUp）并派发 scroll，越过程序护栏窗 */
  async function scrollEvent(top: number): Promise<void> {
    await withGuardExpired(() => {
      scrollEl.scrollTop = top;
      scrollEl.dispatchEvent(new Event("scroll"));
    });
  }
  const contentObserver = (): CapturingResizeObserver | undefined => {
    const content = host!.querySelector('[data-testid="chat-scroll-content"]')!;
    return CapturingResizeObserver.instances.find((o) => o.targets.includes(content));
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    CapturingResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
    diagSpy = vi.spyOn(diag, "info");
    host = document.body.appendChild(document.createElement("div"));
    const r = createRoot(host);
    root = r;
    await act(async () => {
      r.render(createElement(MessageList, { items: [item("m1")], sessionId: SID, syncing: false, onReachTop: () => {} }));
    });
    scrollEl = host.querySelector<HTMLElement>('[data-testid="chat-scroll"]')!;
    scrollEl.scrollTo = (() => {}) as typeof scrollEl.scrollTo;
    geometry = instrument(scrollEl);
    // 首开定位两段式（stage1 rAF + stage2 100ms 补滚）走完，之后的事件都在护栏窗外
    await flushFrame();
    vi.advanceTimersByTime(100);
    await flushFrame();
    expect(toAnchorCount()).toBe(2);
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    diagSpy?.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useMessagesStore.setState({ bySession: {}, followAnchors: {} });
  });

  test("内容变高引起的 scroll 事件：不解除跟随，回底一次", async () => {
    await scrollEvent(500); // 贴底事件：建立位置基线
    expect(flips().length).toBe(0);
    const before = toAnchorCount();
    geometry.setScrollHeight(1200); // 行高晚到：scrollHeight 涨、位置不动
    await scrollEvent(500);
    expect(flips().length).toBe(0); // 旧实现在此记 to=false
    await flushFrame();
    expect(toAnchorCount()).toBe(before + 1);
  });

  test("位置真的往上走才解除：回底钮出现，之后内容变高零回底", async () => {
    await scrollEvent(500);
    await scrollEvent(300); // 拖滚动条/滚轮：位置回退 200
    expect(flips().some((x) => x.to === false && x.src === "scroll" && x.movedUp === true)).toBe(true);
    expect(jumpButton()).not.toBeNull();
    const before = toAnchorCount();
    geometry.setScrollHeight(1400);
    await scrollEvent(300);
    await flushFrame();
    expect(toAnchorCount()).toBe(before);
    expect(jumpButton()).not.toBeNull();
  });

  test("滚回底部恢复跟随：回底钮消失", async () => {
    await scrollEvent(500);
    await scrollEvent(300);
    expect(jumpButton()).not.toBeNull();
    await scrollEvent(500);
    expect(flips().some((x) => x.to === true && x.src === "scroll")).toBe(true);
    expect(jumpButton()).toBeNull();
  });

  test("内容尺寸变化无 scroll 事件：起始通知跳过；跟随态回底，非跟随态零动作", async () => {
    const observer = contentObserver();
    expect(observer).toBeDefined();
    const notify = (): void => observer!.cb([], observer as unknown as ResizeObserver);
    const before = toAnchorCount();
    notify(); // observe 起始通知：不是尺寸变化
    await flushFrame();
    expect(toAnchorCount()).toBe(before);
    notify(); // 行高晚到
    await flushFrame();
    expect(toAnchorCount()).toBe(before + 1);
    await scrollEvent(500); // 贴底事件：建立位置基线
    await scrollEvent(300); // 用户回看：解除跟随
    const after = toAnchorCount();
    notify();
    await flushFrame();
    expect(toAnchorCount()).toBe(after);
  });
});
