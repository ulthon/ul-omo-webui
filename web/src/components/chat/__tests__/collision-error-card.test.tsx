// @ts-nocheck
// multi-session-parallel T7（IS-4/GAP-5）：外部撞车 409 常驻错误卡 + active 多行徽标透传。
// - collisionCardText：服务端详情（含被占会话 sessionPath）原样呈现（misleading_success_output
//   防护：断言卡文案含路径与处置指引，非泛化文案）；详情缺席回退词典文案；
// - 进流：mergeStreamErrors 尾部追加（错误=最新事实，接在全部条目/事件行之后）；
// - 常驻不自动消失：fake timers 推进 30 分钟（远超任何自动清理窗口）后 store 仍持有、
//   订阅渲染仍在——零真实等待（flaky_tests 防护，定时器全 fake）；
// - 非 toast：撞车路径零 toast 入队（会话内错误不走 toast 既有约定）；
// - 唯一移除路径=卡片关闭钮（createRoot+act 真实 DOM 点击）；
// - active 多行：两行会话同时运行态（一行 SSE runStates 权威链、一行服务端探询 active
//   透传）→ 两个「运行中」徽标；空闲对照行不计（多会话并行不再单值假设）。
// 环境（activity-bar / session-item-expand-removed 惯例）：@happy-dom 全局注册 +
// 被测模块动态 import（晚于全局注册）；渲染断言 renderToStaticMarkup，点击行为走
// createRoot+act 真实 DOM；setup-locale 锁 zh-CN（断言文案经 t() 取词非硬编码英文）。
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
const { renderToStaticMarkup } = await import("react-dom/server");
const { collisionCardText } = await import("@/components/composer/composer-logic");
const { mergeStreamErrors } = await import("@/components/chat/message-items");
const { StreamErrorCardBlock } = await import("../message-list");
const { SessionItem } = await import("@/components/session-list/session-item");
const { useMessagesStore } = await import("@/stores/messages");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");
const { t: tSnap } = await import("@/i18n/i18n");

const T0 = 1_000_000;
const SESSION_PATH = "/tmp/proj/.omo-agent/sessions/enc/2026-11-05T10-00-00-000-zzz.jsonl";
// 服务端 engine-runtime.ts 撞车映射点文案形态（T7 改后：sessionPath + 处置指引）
const COLLISION_DETAIL = `会话文件被外部回合占用：${SESSION_PATH}（等外部回合落定，或去 CLI 侧中断）`;
const FALLBACK = tSnap("chat.streamError.sessionBusy");
const RUNNING_TITLE = tSnap("sessionList.item.statusRunning");

/** 服务端撞车 409 的 ApiError 结构形状（免 import lib/api 全模块） */
function collision409(): Error {
  const err = new Error(COLLISION_DETAIL);
  err.name = "ApiError";
  Object.assign(err, { status: 409, code: "already_processing" });
  return err;
}

/** store 订阅宿主（镜像 MessageList 的 streamErrors 选择器→尾部并入→卡渲染链） */
function ErrorCardHost({ sessionId }: { sessionId: string }) {
  const errors = useMessagesStore((s) => s.bySession[sessionId]?.errors);
  const last = errors && errors.length > 0 ? errors[errors.length - 1] : null;
  if (!last) return null;
  return createElement(StreamErrorCardBlock, { sessionId, error: last });
}

function renderCardStatic(sessionId: string): string {
  return renderToStaticMarkup(createElement(ErrorCardHost, { sessionId }));
}

function mountCard(sessionId: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(ErrorCardHost, { sessionId }));
  });
  return { container, root };
}

function makeSession(overrides = {}) {
  return {
    id: "s1",
    path: "/tmp/p/2026-01-01T00-00-00-000-abcd",
    project: "/tmp/p",
    title: "示例会话",
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: null,
    runState: null,
    tags: [],
    ...overrides,
  };
}

beforeEach(() => {
  useMessagesStore.setState({ bySession: {} });
  useSessionsStore.setState({ runStates: {} });
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers(); // 防跨文件泄漏
  useMessagesStore.setState({ bySession: {} });
  useSessionsStore.setState({ runStates: {} });
  useUiStore.setState({ toasts: [] });
  document.body.innerHTML = "";
});

describe("撞车 409 常驻错误卡（multi-session-parallel T7）", () => {
  test("详情原样呈现：卡文案含被占会话 sessionPath 与处置指引；详情缺席回退词典文案", () => {
    const text = collisionCardText(collision409(), FALLBACK);
    expect(text).toContain(SESSION_PATH);
    expect(text).toContain("等外部回合落定");
    expect(text).toContain("去 CLI 侧中断");
    // 回退路径：message 空白/非 Error → 词典文案（错误码已映射时 apiErrorMessage 丢详情，
    // 撞车卡不走它——本函数兜底）
    expect(collisionCardText(new Error("   "), FALLBACK)).toBe(FALLBACK);
    expect(collisionCardText(null, FALLBACK)).toBe(FALLBACK);
  });

  test("进流：store 错误经 mergeStreamErrors 尾部追加；撞车路径零 toast（非 toast 约定）", () => {
    const text = collisionCardText(collision409(), FALLBACK);
    useMessagesStore.getState().pushError("d-1", text);
    const errors = useMessagesStore.getState().bySession["d-1"].errors;
    expect(errors).toHaveLength(1);
    const items = mergeStreamErrors([{ key: "e1", kind: "entry", entryId: "x", interrupted: false, model: null }], errors);
    expect(items).toHaveLength(2);
    expect(items[items.length - 1]).toMatchObject({ kind: "streamError" });
    // 会话内错误不走 toast：store 无任何 toast 入队
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });

  test("常驻不自动消失：fake timers 推进 30 分钟后 store 仍持有、订阅渲染仍在", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(T0);
    useMessagesStore.getState().pushError("d-1", collisionCardText(collision409(), FALLBACK));
    expect(renderCardStatic("d-1")).toContain('data-testid="stream-error-card"');
    // 推进远超任何自动清理窗口（消息 store / 清扫节拍的一切 interval/timeout 全 fake）
    act(() => {
      vi.advanceTimersByTime(30 * 60_000);
    });
    expect(useMessagesStore.getState().bySession["d-1"].errors).toHaveLength(1);
    const html = renderCardStatic("d-1");
    expect(html).toContain('data-testid="stream-error-card"');
    expect(html).toContain(SESSION_PATH);
  });

  test("唯一移除路径=关闭钮：真实 DOM 点击后卡片与 store 同步移除（可回看不误删）", () => {
    useMessagesStore.getState().pushError("d-1", collisionCardText(collision409(), FALLBACK));
    const { container, root } = mountCard("d-1");
    expect(container.querySelector('[data-testid="stream-error-card"]')).not.toBeNull();
    const btn = container.querySelector('[data-testid="stream-error-dismiss"]');
    expect(btn).not.toBeNull();
    act(() => {
      (btn as unknown as HTMLElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector('[data-testid="stream-error-card"]')).toBeNull();
    expect(useMessagesStore.getState().bySession["d-1"].errors).toHaveLength(0);
    act(() => {
      root.unmount();
    });
  });
});

describe("active 多行徽标透传（multi-session-parallel T7 / IS-5）", () => {
  test("两行同时运行（SSE 权威链 + 服务端 active 探询）→ 两个运行中徽标，空闲行不计", () => {
    const rows = [
      makeSession({ id: "s1", runState: null, active: true }), // 服务端探询 active 透传
      makeSession({ id: "s2", runState: "running", active: false }), // SSE runStates 权威链
      makeSession({ id: "s3" }), // 空闲对照
    ];
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        rows.map((session) =>
          createElement(SessionItem, {
            session,
            forkIndexes: new Map(),
            onDialog: () => {},
            onChanged: () => {},
          }),
        ),
      ),
    );
    const running = html.match(new RegExp(`title="${RUNNING_TITLE}"`, "g")) ?? [];
    expect(running).toHaveLength(2);
    // 三行都在场（StatusDot 点类名计数：运行中天蓝点 ×2、空闲灰点 ×1——行标题在
    // 静态标记内出现多次不可作计数基，改用状态点专属类名精确计数）
    expect((html.match(/rounded-full bg-sky-500/g) ?? []).length).toBe(2);
    expect((html.match(/rounded-full bg-muted-foreground\/30/g) ?? []).length).toBe(1);
  });
});
