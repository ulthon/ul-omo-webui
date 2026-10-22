/**
 * 粘性用户消息与回底判据（docs08-r7 任务 11）单测与挂载链路：
 * - stickyUserOf：最近一条含文本 user 条目摘要（连排 user 取末条；纯图 user 回退上一条；
 *   无 user 消息返回 null＝不渲染）
 * - shouldShowStickyUser：二值判据矩阵（回底恒隐；上缘/下缘完整滚出显示；跨越不显示）
 * - 挂载链路：真实 MessageList + store 直写 entries，scroll 事件驱动（虚拟化测量缓存几何，
 *   ResizeObserver 置空保估值稳定）——下滚滚出顶部钉摘要、上滚滚出底部钉当前提问（OC 行为）、
 *   回底消失、>一屏回底钮在场（二值判据的测试形态）、无 user 消息不渲染。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// 置空 ResizeObserver：虚拟化测量保持 estimateSize 估值（几何断言确定性，不受 happy-dom
// 观察时序影响）；本测试的滚动几何全部走显式 mock，不依赖布局引擎。
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { MessageList } = await import("@/components/chat/message-list");
const { buildMessageItems, mergeMemoryItems, shouldShowStickyUser, stickyUserOf } = await import("@/components/chat/message-items");
const { useMessagesStore } = await import("@/stores/messages");
import type { ChatListItem } from "@/components/chat/message-items";

const SID = "t11-sticky-fixture";

function messageEntry(id: string, role: "user" | "assistant", text: string): Record<string, unknown> {
  return { type: "message", id, message: { role, content: [{ type: "text", text }] } };
}

function imageUserEntry(id: string): Record<string, unknown> {
  return { type: "message", id, message: { role: "user", content: [{ type: "image", mime: "image/png", data: "x" }] } };
}

const U1 = "第一个问题：帮我写一个排序算法";
const U3 = "第三个问题：现在怎么样了";

// ---------------------------------------------------------------- 纯函数

describe("stickyUserOf：最近一条含文本 user 条目", () => {
  test("连排 user 取末条（index/key/text 对齐 items 下标）", () => {
    const entries = [
      messageEntry("u1", "user", U1),
      messageEntry("u2", "user", "第二个问题"),
      messageEntry("u3", "user", U3),
      messageEntry("a1", "assistant", "回答"),
    ];
    const items = buildMessageItems(entries as never, { hasStreamingMessage: false, interrupted: false });
    const cand = stickyUserOf(items, entries as never);
    expect(cand).not.toBeNull();
    expect(cand!.index).toBe(2);
    expect(cand!.key).toBe("u3");
    expect(cand!.text).toBe(U3);
  });

  test("无 user 消息返回 null（不渲染）", () => {
    const entries = [messageEntry("a1", "assistant", "只有回答")];
    const items = buildMessageItems(entries as never, { hasStreamingMessage: false, interrupted: false });
    expect(stickyUserOf(items, entries as never)).toBeNull();
    expect(stickyUserOf([], [])).toBeNull();
  });

  test("末条 user 纯图（无文本）跳过，回退上一条文本提问", () => {
    const entries = [messageEntry("u1", "user", U1), imageUserEntry("u-img"), messageEntry("a1", "assistant", "收到图片")];
    const items = buildMessageItems(entries as never, { hasStreamingMessage: false, interrupted: false });
    const cand = stickyUserOf(items, entries as never);
    expect(cand).not.toBeNull();
    expect(cand!.key).toBe("u1");
    expect(cand!.text).toBe(U1);
  });

  test("非 entry 项（streaming 等）不参与候选", () => {
    const items: ChatListItem[] = [
      { key: "__streaming", kind: "streaming" },
      { key: "u3", kind: "entry", entryId: "u3", interrupted: false },
    ];
    const cand = stickyUserOf(items, [messageEntry("u3", "user", U3)] as never);
    expect(cand).not.toBeNull();
    expect(cand!.index).toBe(1);
    expect(cand!.text).toBe(U3);
  });
});

describe("shouldShowStickyUser：二值判据矩阵", () => {
  const vt = 0;
  const vb = 200;
  test("回底（atBottom）恒隐藏，即便气泡已滚出视口", () => {
    expect(shouldShowStickyUser(true, -500, -400, vt, vb)).toBe(false);
    expect(shouldShowStickyUser(true, 300, 400, vt, vb)).toBe(false);
  });
  test("上缘完整滚出顶部（下滚读长回答）显示", () => {
    expect(shouldShowStickyUser(false, -500, -400, vt, vb)).toBe(true);
  });
  test("下缘完整滚出底部（上滚浏览历史）显示", () => {
    expect(shouldShowStickyUser(false, 300, 400, vt, vb)).toBe(true);
  });
  test("跨越边缘与完整在视口内不钉", () => {
    expect(shouldShowStickyUser(false, -50, 50, vt, vb)).toBe(false);
    expect(shouldShowStickyUser(false, 150, 250, vt, vb)).toBe(false);
    expect(shouldShowStickyUser(false, 10, 100, vt, vb)).toBe(false);
  });
});

// ---------------------------------------------------------------- 挂载链路

let root: ReturnType<typeof createRoot> | null = null;
const CONTAINERS: HTMLElement[] = [];

/** 滚动几何 mock：scrollHeight 6000 / clientHeight 200（u3 行内容区 376..496，
 *  静止时完整在初始视口下方）。估值几何：index i 行 start = i*120，内容 Y = 16+start。 */
async function mountList(entries: Record<string, unknown>[]): Promise<HTMLElement> {
  useMessagesStore.getState().setEntries(SID, entries as never, null, null);
  const container = document.createElement("div");
  document.body.appendChild(container);
  CONTAINERS.push(container);
  root = createRoot(container);
  await act(async () => {
    const storeEntries = useMessagesStore.getState().bySession[SID]?.entries ?? [];
    const items = buildMessageItems(storeEntries as never, { hasStreamingMessage: false, interrupted: false });
    const merged = mergeMemoryItems(items, storeEntries);
    root!.render(
      createElement(MessageList, { items: merged, sessionId: SID, syncing: false, onReachTop: () => {} }),
    );
  });
  const scrollEl = container.querySelector("[data-testid=chat-scroll]") as HTMLElement;
  (scrollEl as { scrollTo?: unknown }).scrollTo = () => {}; // 关挂载自动滚底干扰
  let top = 0;
  Object.defineProperty(scrollEl, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  Object.defineProperty(scrollEl, "scrollHeight", { configurable: true, get: () => 6000 });
  Object.defineProperty(scrollEl, "clientHeight", { configurable: true, get: () => 200 });
  return scrollEl;
}

async function scrollTo(scrollEl: HTMLElement, top: number): Promise<void> {
  scrollEl.scrollTop = top;
  await act(async () => {
    scrollEl.dispatchEvent(new Event("scroll"));
  });
}

beforeEach(() => {
  useMessagesStore.setState({ bySession: {} });
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  for (const c of CONTAINERS.splice(0)) c.remove();
  useMessagesStore.setState({ bySession: {} });
});

describe("挂载链路：scroll 驱动粘性条与回底钮", () => {
  // u1 a1 u2 u3 a3：u3 为最近 user（index 3，内容 Y 376..496）
  const FIXTURE = () => [
    messageEntry("u1", "user", U1),
    messageEntry("a1", "assistant", "第一个回答"),
    messageEntry("u2", "user", "第二个问题"),
    messageEntry("u3", "user", U3),
    messageEntry("a3", "assistant", "第三个回答"),
  ];

  test("下滚最近 user 气泡滚出顶部：钉摘要条；>一屏回底钮在场（二值判据）", async () => {
    const scrollEl = await mountList(FIXTURE());
    await scrollTo(scrollEl, 2000);
    const bar = document.querySelector('[data-testid="sticky-user-message"]');
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("aria-hidden")).toBe("true");
    expect(bar!.className).toContain("pointer-events-none");
    expect(bar!.textContent).toBe(U3);
    expect(bar!.querySelectorAll("button, a, input").length).toBe(0); // 不承载交互
    expect(document.querySelector('[data-testid="jump-bottom"]')).not.toBeNull();
  });

  test("上滚最近 user 气泡滚出底部：同样钉当前提问（OC 行为）", async () => {
    const scrollEl = await mountList(FIXTURE());
    await scrollTo(scrollEl, 50);
    const bar = document.querySelector('[data-testid="sticky-user-message"]');
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toBe(U3);
  });

  test("回底：粘性条与回底钮同时消失（回底消失）", async () => {
    const scrollEl = await mountList(FIXTURE());
    await scrollTo(scrollEl, 2000);
    expect(document.querySelector('[data-testid="sticky-user-message"]')).not.toBeNull();
    await scrollTo(scrollEl, 5800); // 距底 0 < 阈值
    expect(document.querySelector('[data-testid="sticky-user-message"]')).toBeNull();
    expect(document.querySelector('[data-testid="jump-bottom"]')).toBeNull();
  });

  test("气泡跨越视口边缘或完整可见时不钉", async () => {
    const scrollEl = await mountList(FIXTURE());
    await scrollTo(scrollEl, 420); // 行 [-44, 76] 跨上缘
    expect(document.querySelector('[data-testid="sticky-user-message"]')).toBeNull();
    await scrollTo(scrollEl, 320); // 行 [56, 176] 完整在视口 [0,200] 内
    expect(document.querySelector('[data-testid="sticky-user-message"]')).toBeNull();
  });

  test("无 user 消息不渲染粘性条（回底钮仍按判据出现）", async () => {
    const scrollEl = await mountList([
      messageEntry("a1", "assistant", "只有回答一"),
      messageEntry("a2", "assistant", "只有回答二"),
    ]);
    await scrollTo(scrollEl, 2000);
    expect(document.querySelector('[data-testid="sticky-user-message"]')).toBeNull();
    expect(document.querySelector('[data-testid="jump-bottom"]')).not.toBeNull();
  });

  test("末条 user 纯图：回退上一条文本提问作为摘要", async () => {
    const scrollEl = await mountList([
      messageEntry("u1", "user", U1),
      imageUserEntry("u-img"),
      messageEntry("a1", "assistant", "收到图片"),
    ]);
    await scrollTo(scrollEl, 2000);
    const bar = document.querySelector('[data-testid="sticky-user-message"]');
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toBe(U1);
  });
});
