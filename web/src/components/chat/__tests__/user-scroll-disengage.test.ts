// fix 2026-11-11 用户输入直接解除流式跟随：输出中/思考中向上滚动被拽回的修复。
// - 基线：跟随态（followRef=true）下流式 store 更新触发 scrollToAnchor（diag to_anchor）；
// - wheel 向上：解除跟随（follow_flip src=user-wheel），后续 store 更新不再滚锚；
// - 滚回底部：scroll 判定重新置 true，store 更新恢复滚锚；
// - 触摸：手指向下拖（dy>8 主纵向）解除；横向位移为主/位移不足不解除；
// - 键盘：PageUp/ArrowUp/Home 全局解除；input 内按键不解除（编辑场景误关防护）。
// 环境（collision-error-card 惯例）：@happy-dom 全局注册 + 被测模块动态 import；
// 真实 createRoot+act 渲染 MessageList（空列表），行为经 diag 埋点断言。
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

const SID = "test-follow-s1";

/** 模拟流式 store 更新（触发跟随订阅），等 rAF 后 scrollToAnchor 执行 */
async function streamTick(): Promise<void> {
  await act(async () => {
    useMessagesStore.setState({});
    await new Promise((r) => requestAnimationFrame(r));
  });
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

/** 兼容派发：happy-dom 无 TouchEvent 构造器时用普通 Event 携带 touches */
function fire(el: HTMLElement, type: string, props: Record<string, unknown>): void {
  let ev: Event;
  try {
    const Ctor = (globalThis as Record<string, unknown>)[type === "wheel" ? "WheelEvent" : type === "keydown" ? "KeyboardEvent" : "Event"] as
      | (new (type: string, init: Record<string, unknown>) => Event)
      | undefined;
    ev = Ctor ? new Ctor(type, { bubbles: true, ...props }) : new Event(type, { bubbles: true });
  } catch {
    ev = new Event(type, { bubbles: true });
  }
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(ev, k, { value: v });
  }
  el.dispatchEvent(ev);
}

const touch = (x: number, y: number): Touch[] => [{ clientX: x, clientY: y } as unknown as Touch];

describe("用户输入直接解除流式跟随（fix 2026-11-11）", () => {
  let host: HTMLElement | null = null;
  let root: { unmount(): void } | null = null;
  let diagSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scrollEl: HTMLElement;

  const flips = (): Array<Record<string, unknown>> => {
    const calls = (diagSpy?.mock.calls ?? []) as unknown as Array<Array<unknown>>;
    return calls.filter((c: Array<unknown>) => c[1] === "follow_flip").map((c: Array<unknown>) => c[2] as Record<string, unknown>);
  };
  const toAnchorCount = (): number => {
    const calls = (diagSpy?.mock.calls ?? []) as unknown as Array<Array<unknown>>;
    return calls.filter((c: Array<unknown>) => c[1] === "to_anchor").length;
  };

  beforeEach(async () => {
    diagSpy = vi.spyOn(diag, "info");
    host = document.body.appendChild(document.createElement("div"));
    const r = createRoot(host);
    root = r;
    await act(async () => {
      r.render(createElement(MessageList, { items: [], sessionId: SID, syncing: false, onReachTop: () => {} }));
    });
    scrollEl = host.querySelector<HTMLElement>('[data-testid="chat-scroll"]')!;
    scrollEl.scrollTo = (() => {}) as typeof scrollEl.scrollTo;
    // 基线校验：跟随态下流式更新触发滚锚
    const before = toAnchorCount();
    await streamTick();
    expect(toAnchorCount()).toBeGreaterThan(before);
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    diagSpy?.mockRestore();
    useMessagesStore.setState({ bySession: {}, followAnchors: {} });
  });

  test("wheel 向上解除：解除后流式 store 更新不再滚锚（修复拉拽症状）", () => {
    const before = toAnchorCount();
    fire(scrollEl, "wheel", { deltaY: -120 });
    const f = flips();
    expect(f.some((x) => x.src === "user-wheel" && x.to === false)).toBe(true);
    return streamTick().then(() => {
      expect(toAnchorCount()).toBe(before);
    });
  });

  test("wheel 向下不解除（滚回底部由 scroll 判定恢复）", () => {
    fire(scrollEl, "wheel", { deltaY: 120 });
    expect(flips().some((x) => x.src === "user-wheel")).toBe(false);
  });

  test("解除后滚回底部：scroll 判定重新置 true，流式更新恢复滚锚", async () => {
    fire(scrollEl, "wheel", { deltaY: -100 });
    expect(flips().some((x) => x.src === "user-wheel")).toBe(true);
    // 滚回底部：空列表下容器恒在底（remaining 0），scroll 事件应重新置 true（越过护栏窗）
    await withGuardExpired(() => scrollEl.dispatchEvent(new Event("scroll")));
    expect(flips().some((x) => x.to === true && x.src === "scroll")).toBe(true);
    const before = toAnchorCount();
    await streamTick();
    expect(toAnchorCount()).toBeGreaterThan(before);
  });

  test("触摸向上拖（手指向下 dy>8 主纵向）解除；横向为主/位移不足不解除", () => {
    // 横向为主：不解除
    fire(scrollEl, "touchstart", { touches: touch(100, 300) });
    fire(scrollEl, "touchmove", { touches: touch(130, 306) });
    expect(flips().some((x) => x.src === "user-touch")).toBe(false);
    // 位移不足：不解除
    fire(scrollEl, "touchstart", { touches: touch(100, 300) });
    fire(scrollEl, "touchmove", { touches: touch(101, 306) });
    expect(flips().some((x) => x.src === "user-touch")).toBe(false);
    // 手指向下拖 20px（内容上滚=往回看）：解除
    fire(scrollEl, "touchstart", { touches: touch(100, 300) });
    fire(scrollEl, "touchmove", { touches: touch(101, 320) });
    expect(flips().some((x) => x.src === "user-touch" && x.to === false)).toBe(true);
  });

  test("键盘 PageUp/ArrowUp 全局解除；input 内 ArrowUp 不解除", async () => {
    fire(scrollEl, "keydown", { key: "PageUp" });
    expect(flips().some((x) => x.src === "user-key")).toBe(true);
    // 滚回底部恢复跟随再验证 ArrowUp 与 input 排除（越过护栏窗）
    await withGuardExpired(() => scrollEl.dispatchEvent(new Event("scroll")));
    const before = flips().length;
    const input = document.createElement("input");
    document.body.appendChild(input);
    fire(input, "keydown", { key: "ArrowUp" });
    expect(flips().length).toBe(before);
    fire(scrollEl, "keydown", { key: "ArrowUp" });
    expect(flips().some((x) => x.src === "user-key" && x.to === false)).toBe(true);
    input.remove();
  });
});
