/**
 * 粘性用户消息与回底判据（docs08-r7 任务 11 建；r9 wave1 改视口锚定）单测与挂载链路：
 * - stickyCandidateAboveViewport：视口上缘上方最近含文本 user 条目（上滚早期历史候选
 *   随视口走，非尾部最新；顶部全量在视口下方时候选=首个可见条目按新函数定义；纯图
 *   user 跳过回退；无 user 文本返回 null＝不渲染；测量缺失返回 null）
 * - shouldShowStickyUser：二值判据矩阵（回底恒隐；上缘/下缘完整滚出显示；跨越不显示）
 * - 挂载链路：真实 MessageList + store 直写 entries，scroll 事件驱动（虚拟化测量缓存
 *   几何，ResizeObserver 置空保估值稳定）——下滚读长回答钉最新提问、上滚早期历史钉
 *   视口上方最近提问（非尾部）、候选跨越上缘不钉、回底消失、>一屏回底钮在场。
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
const { buildMessageItems, mergeMemoryItems, shouldShowStickyUser, stickyCandidateAboveViewport } = await import(
  "@/components/chat/message-items"
);
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
const U2 = "第二个问题：现在怎么样了";
const U3 = "第三个问题：再帮我看看性能";

/** 估值几何（NoopResizeObserver 下 TanStack 落 estimateSize=120）：index i 行
 *  start = i*120；scrollTop 为视口上缘的内容坐标（容器顶垫由调用方扣除）。 */
function estimateMeasurements(count: number): Array<{ start: number; size: number }> {
  return Array.from({ length: count }, (_, i) => ({ start: i * 120, size: 120 }));
}

/** 六条 fixture：u1 a1 u2 a2 u3 a3（u3 为尾部最新提问） */
function sixEntries(): Record<string, unknown>[] {
  return [
    messageEntry("u1", "user", U1),
    messageEntry("a1", "assistant", "第一个回答"),
    messageEntry("u2", "user", U2),
    messageEntry("a2", "assistant", "第二个回答"),
    messageEntry("u3", "user", U3),
    messageEntry("a3", "assistant", "第三个回答"),
  ];
}

// ---------------------------------------------------------------- 纯函数

describe("stickyCandidateAboveViewport：视口上缘上方最近 user 条目", () => {
  test("断言1 上滚早期历史：候选=视口上方最近 user 条，非尾部最新", () => {
    const entries = sixEntries();
    const items = buildMessageItems(entries as never, { hasStreamingMessage: false, interrupted: false });
    // 视口上缘 364 落在 a2（360..480）内：候选为其上方最近的 u2，而非尾部 u3
    const cand = stickyCandidateAboveViewport(items, entries as never, estimateMeasurements(items.length), 364);
    expect(cand).not.toBeNull();
    expect(cand!.index).toBe(2);
    expect(cand!.key).toBe("u2");
    expect(cand!.text).toBe(U2);
    expect(cand!.index).not.toBe(4); // 尾部最新 u3（index 4）不得当选
    // 上缘 520 落在 u3（480..600）行内更深处：候选切换为其自身（随视口走）
    const cand2 = stickyCandidateAboveViewport(items, entries as never, estimateMeasurements(items.length), 520);
    expect(cand2!.key).toBe("u3");
  });

  test("断言2 顶部位置全量在视口下方：候选=首个可见条目按新函数定义（u1）", () => {
    const entries = sixEntries();
    const items = buildMessageItems(entries as never, { hasStreamingMessage: false, interrupted: false });
    // scrollTop 0 / -50（上缘未进内容区）：首个可见条目即 index 0，为含文本 user 时返回它
    // （任务规格允许"null 或最新按新函数定义"；本函数定义取首个可见 user 条；
    // 该候选整行可见，渲染层 shouldShowStickyUser 判不钉，观测与 null 等价）
    const cand = stickyCandidateAboveViewport(items, entries as never, estimateMeasurements(items.length), 0);
    expect(cand).not.toBeNull();
    expect(cand!.index).toBe(0);
    expect(cand!.key).toBe("u1");
    expect(stickyCandidateAboveViewport(items, entries as never, estimateMeasurements(items.length), -50)!.key).toBe("u1");
  });

  test("断言3 回底门控：候选在场时 atBottom 恒不显示（shouldShowStickyUser）", () => {
    // 回底（atBottom=true）即便候选已滚出视口也恒隐——二值矩阵的回底行保持
    expect(shouldShowStickyUser(true, -500, -400, 0, 200)).toBe(false);
    expect(shouldShowStickyUser(true, 300, 400, 0, 200)).toBe(false);
  });

  test("上缘落在 assistant 行内：向上跳过 assistant 取其上 user（下滚读长回答）", () => {
    const entries = sixEntries();
    const items = buildMessageItems(entries as never, { hasStreamingMessage: false, interrupted: false });
    // 上缘 500 落在 a3 起点后、u3（480..600）行内：候选 u3——新语义下最新提问自然保真
    const cand = stickyCandidateAboveViewport(items, entries as never, estimateMeasurements(items.length), 500);
    expect(cand!.key).toBe("u3");
    // 上缘落在 a1（120..240）内：候选 u1
    const cand2 = stickyCandidateAboveViewport(items, entries as never, estimateMeasurements(items.length), 200);
    expect(cand2!.key).toBe("u1");
  });

  test("纯图 user 跳过，回退上一条文本提问", () => {
    const entries = [messageEntry("u1", "user", U1), imageUserEntry("u-img"), messageEntry("a1", "assistant", "收到图片")];
    const items = buildMessageItems(entries as never, { hasStreamingMessage: false, interrupted: false });
    // 上缘 164 落在 u-img（120..240）行内：纯图不可作摘要，回退 u1
    const cand = stickyCandidateAboveViewport(items, entries as never, estimateMeasurements(items.length), 164);
    expect(cand).not.toBeNull();
    expect(cand!.key).toBe("u1");
    expect(cand!.text).toBe(U1);
  });

  test("非 entry 项（streaming 等）不当选也不阻断向上反查", () => {
    const items: ChatListItem[] = [
      { key: "u1", kind: "entry", entryId: "u1", interrupted: false },
      { key: "__streaming", kind: "streaming" },
      { key: "u3", kind: "entry", entryId: "u3", interrupted: false },
    ];
    const entries = [messageEntry("u1", "user", U1), messageEntry("u3", "user", U3)];
    // 上缘 150 落在 streaming（120..240）行内：streaming 不当选也不阻断，候选=其上方 u1；
    // 视口下方的 u3（240..360）在新语义下不可当选（旧尾部语义正是此处被废除）
    const cand = stickyCandidateAboveViewport(items, entries as never, estimateMeasurements(items.length), 150);
    expect(cand).not.toBeNull();
    expect(cand!.index).toBe(0);
    expect(cand!.key).toBe("u1");
    expect(cand!.text).toBe(U1);
  });

  test("无 user 文本条目 / 空 items / 测量缺失返回 null（不渲染）", () => {
    const entries = [messageEntry("a1", "assistant", "只有回答")];
    const items = buildMessageItems(entries as never, { hasStreamingMessage: false, interrupted: false });
    expect(stickyCandidateAboveViewport(items, entries as never, estimateMeasurements(items.length), 100)).toBeNull();
    expect(stickyCandidateAboveViewport([], [], estimateMeasurements(0), 100)).toBeNull();
    expect(stickyCandidateAboveViewport(items, entries as never, undefined, 100)).toBeNull();
  });

  test("测量数组含空洞（未同步瞬间）：空洞跳过不误判", () => {
    const entries = sixEntries();
    const items = buildMessageItems(entries as never, { hasStreamingMessage: false, interrupted: false });
    const holey = estimateMeasurements(items.length) as Array<{ start: number; size: number } | undefined>;
    holey[3] = undefined; // a2 测量缺失
    // 上缘 364：a2 无测量跳过，首个可见落到 u3（480..600），候选其上方最近 user = u3
    const cand = stickyCandidateAboveViewport(items, entries as never, holey, 364);
    expect(cand!.key).toBe("u3");
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
  test("下缘完整滚出底部显示（函数契约保留；视口锚定后调用侧不再触达该分支）", () => {
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

/** 滚动几何 mock：scrollHeight 6000 / clientHeight 200（估值几何：index i 行内容区
 *  Y = 16+i*120 .. 16+(i+1)*120）。 */
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

describe("挂载链路：scroll 驱动视口锚定粘性条与回底钮", () => {
  // u1 a1 u2 a2 u3 a3 a4 a5：估值行 u2=240..360 / a2=360..480 / u3=480..600 / a3=600..720
  const FIXTURE = () => [
    messageEntry("u1", "user", U1),
    messageEntry("a1", "assistant", "第一个回答"),
    messageEntry("u2", "user", U2),
    messageEntry("a2", "assistant", "第二个回答"),
    messageEntry("u3", "user", U3),
    messageEntry("a3", "assistant", "第三个回答"),
    messageEntry("a4", "assistant", "第四个回答"),
    messageEntry("a5", "assistant", "第五个回答"),
  ];

  test("下滚读长回答（视口落在 a3 长答段）：钉最新提问 U3；回底钮在场", async () => {
    const scrollEl = await mountList(FIXTURE());
    await scrollTo(scrollEl, 640); // 上缘内容坐标 624 落在 a3（600..720）内
    const bar = document.querySelector('[data-testid="sticky-user-message"]');
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("aria-hidden")).toBe("true");
    expect(bar!.className).toContain("pointer-events-none");
    expect(bar!.textContent).toBe(U3);
    expect(bar!.querySelectorAll("button, a, input").length).toBe(0); // 不承载交互
    expect(document.querySelector('[data-testid="jump-bottom"]')).not.toBeNull();
  });

  test("上滚早期历史（视口落在 a2 段）：钉视口上方最近提问 U2，非尾部 U3", async () => {
    const scrollEl = await mountList(FIXTURE());
    await scrollTo(scrollEl, 380); // 上缘 364 落在 a2（360..480）内
    const bar = document.querySelector('[data-testid="sticky-user-message"]');
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toBe(U2); // 旧语义此处钉尾部 U3——回归断言
  });

  test("候选跨越视口上缘或完整可见时不钉", async () => {
    const scrollEl = await mountList(FIXTURE());
    await scrollTo(scrollEl, 540); // 上缘 524 落在 u3（480..600）行内：候选跨上缘
    expect(document.querySelector('[data-testid="sticky-user-message"]')).toBeNull();
    await scrollTo(scrollEl, 0); // 顶部：候选 u1 完整可见
    expect(document.querySelector('[data-testid="sticky-user-message"]')).toBeNull();
  });

  test("回底：粘性条与回底钮同时消失（回底消失）", async () => {
    const scrollEl = await mountList(FIXTURE());
    await scrollTo(scrollEl, 380);
    expect(document.querySelector('[data-testid="sticky-user-message"]')).not.toBeNull();
    await scrollTo(scrollEl, 5800); // 距底 0 < 阈值
    expect(document.querySelector('[data-testid="sticky-user-message"]')).toBeNull();
    expect(document.querySelector('[data-testid="jump-bottom"]')).toBeNull();
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
    await scrollTo(scrollEl, 180); // 上缘 164 落在 u-img（120..240）行内
    const bar = document.querySelector('[data-testid="sticky-user-message"]');
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toBe(U1);
  });
});
