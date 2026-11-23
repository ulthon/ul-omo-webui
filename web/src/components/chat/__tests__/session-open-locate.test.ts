// session_open 定位 effect 收敛（重取风暴 GAP-2/4，fix 2026-11-23）：
// - happy：mount 后注入 items → session_open 诊断仅 1 行，两段式定位照旧（stage1 rAF
//   即滚、stage2 100ms 补滚）；items 增长不重发定位（无新 session_open、无新定位 setTimeout）；
// - failure：followRef=false（wheel 向上解除）时首条到达与增长 → 零 to_anchor、零
//   el.scrollTo（两段式执行前均尊重跟随态；不以 scrollTop 断言——happy-dom 无布局，
//   程序滚动调用统一以 diag to_anchor 埋点与滚动容器 scrollTo spy 为代理断言）；
// - cleanup：100ms 窗口内卸载 → stage2 setTimeout 已清理（getTimerCount 归零，无悬空
//   回调）；同窗口切会话 → 旧会话 pending stage2 被 cleanup 清除，新会话只补一次定位。
// 环境（user-scroll-disengage 惯例）：@happy-dom 全局注册 + 被测模块动态 import +
// createRoot/act 渲染 MessageList，行为经 diag 埋点断言。假定时器仅 fake
// setTimeout/clearTimeout：rAF 走 happy-dom 的 setImmediate 通道（不受影响），
// Date.now 保持真实（程序滚动护栏窗计时语义不变）。
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

const SID_A = "test-open-sa";
const SID_B = "test-open-sb";
const streamingItem = (key: string) => ({ key, kind: "streaming" as const });
type StreamItem = ReturnType<typeof streamingItem>;

/** 兼容派发：happy-dom 无 WheelEvent 构造器时用普通 Event 携带 deltaY */
function fireWheel(el: HTMLElement, deltaY: number): void {
  let ev: Event;
  try {
    ev = new WheelEvent("wheel", { bubbles: true, deltaY });
  } catch {
    ev = new Event("wheel", { bubbles: true });
    Object.defineProperty(ev, "deltaY", { value: deltaY });
  }
  el.dispatchEvent(ev);
}

describe("session_open 定位 effect 收敛（GAP-2/GAP-4）", () => {
  let host: HTMLElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  let diagSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scrollToSpy: ReturnType<typeof vi.fn> | null = null;

  const evCount = (ev: string): number => {
    const calls = (diagSpy?.mock.calls ?? []) as unknown as Array<Array<unknown>>;
    return calls.filter((c) => c[1] === ev).length;
  };

  /** 等一帧 rAF（happy-dom 走 setImmediate 通道），让定位 effect 的 stage1 执行完毕 */
  async function flushFrame(): Promise<void> {
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
  }

  async function renderAt(sessionId: string, items: StreamItem[]): Promise<void> {
    const r = root!;
    await act(async () => {
      r.render(createElement(MessageList, { items, sessionId, syncing: false, onReachTop: () => {} }));
    });
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    diagSpy = vi.spyOn(diag, "info");
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await renderAt(SID_A, []);
    const scrollEl = host.querySelector<HTMLElement>('[data-testid="chat-scroll"]')!;
    scrollToSpy = vi.fn();
    scrollEl.scrollTo = scrollToSpy as unknown as typeof scrollEl.scrollTo;
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    diagSpy?.mockRestore();
    scrollToSpy = null;
    vi.useRealTimers();
    useMessagesStore.setState({ bySession: {}, followAnchors: {} });
  });

  test("happy：首条到达定位一次（session_open 仅 1 行），两段式照旧；items 增长不重发", async () => {
    // 空列表：不执行定位
    expect(evCount("session_open")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // 首条到达：session_open 快照 1 行 + stage1 滚锚 + stage2 100ms 待发
    await renderAt(SID_A, [streamingItem("st1")]);
    await flushFrame();
    expect(evCount("session_open")).toBe(1);
    expect(evCount("to_anchor")).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(evCount("to_anchor")).toBe(2);
    expect(vi.getTimerCount()).toBe(0);

    // items 增长：不重发定位（无新 session_open、无新定位 setTimeout）
    await renderAt(SID_A, [streamingItem("st1"), streamingItem("st2")]);
    expect(evCount("session_open")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(300);
    expect(evCount("session_open")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("failure：followRef=false 时首条到达与增长均零程序滚动（stage1/stage2 尊重跟随态）", async () => {
    // wheel 向上解除跟随
    const scrollEl = host!.querySelector<HTMLElement>('[data-testid="chat-scroll"]')!;
    fireWheel(scrollEl, -120);
    expect(evCount("to_anchor")).toBe(0);

    // 首条到达：快照仍记 follow=false 的事实，但两段式均不滚动
    await renderAt(SID_A, [streamingItem("st1")]);
    await flushFrame();
    expect(evCount("session_open")).toBe(1);
    expect(evCount("to_anchor")).toBe(0);
    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(evCount("to_anchor")).toBe(0);
    expect(scrollToSpy).not.toHaveBeenCalled();

    // 增长：旧实现会经 effect 重跑（scrollToAnchor identity 漂移）强拉滚底，收敛后零调用
    await renderAt(SID_A, [streamingItem("st1"), streamingItem("st2")]);
    vi.advanceTimersByTime(300);
    expect(evCount("session_open")).toBe(1);
    expect(evCount("to_anchor")).toBe(0);
    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("cleanup：100ms 窗口内卸载 → stage2 setTimeout 已清理，无悬空回调", async () => {
    await renderAt(SID_A, [streamingItem("st1")]);
    await flushFrame();
    expect(vi.getTimerCount()).toBe(1);
    const toAnchorBeforeUnmount = evCount("to_anchor");

    await act(async () => root!.unmount());
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(evCount("to_anchor")).toBe(toAnchorBeforeUnmount);
  });

  test("cleanup：同窗口切会话 → 旧会话 pending stage2 清除，新会话只补一次定位", async () => {
    await renderAt(SID_A, [streamingItem("st1")]);
    await flushFrame();
    expect(vi.getTimerCount()).toBe(1);

    // 预置两会话锚点：B 侧避免 rerender 触发 setFollowAnchor 写 store 的自动跟随噪声；
    // 预置自身触发的自动跟随滚锚冲掉后取基线
    useMessagesStore.setState({ followAnchors: { [SID_A]: "st1", [SID_B]: "b1" } });
    await flushFrame();
    const base = evCount("to_anchor");

    await renderAt(SID_B, [streamingItem("b1")]);
    await flushFrame();
    expect(evCount("session_open")).toBe(2);
    expect(evCount("to_anchor")).toBe(base + 1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(evCount("to_anchor")).toBe(base + 2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
