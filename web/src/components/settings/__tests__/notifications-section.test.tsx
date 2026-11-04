// @ts-nocheck
// 设置页「通知记录」分区单测（2026-11-05 #10）。环境说明同 engine-section.test.tsx：
// @ts-nocheck + 被测模块动态 import + @happy-dom 全局注册。本分区纯读 ui store
// notifications（不 mock @/stores/ui，用真实 store setState 驱动）。验收：
// (a) 空态提示与清空钮隐藏；(b) 最新在上、kind 徽标、文本不截断渲染；
// (c) 清空钮点击后历史归零且空态出现。
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
(globalThis as { matchMedia?: unknown }).matchMedia ??= () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
});

vi.mock("@/lib/api", () => ({
  api: new Proxy({}, { get: () => () => Promise.resolve({}) }),
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/i18n/i18n", () => ({
  useT: () => (key: string) => key,
}));
vi.mock("@/i18n/errors", () => ({ apiErrorMessage: (_e: unknown, fallback: string) => fallback }));

const { NotificationsSection } = await import("@/components/settings/notifications-section");
const { useUiStore } = await import("@/stores/ui");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

function mount(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(NotificationsSection));
  });
  return host;
}

beforeEach(() => {
  document.body.innerHTML = "";
  useUiStore.setState({
    notifications: [
      { id: 1, kind: "info", text: "第一条提示", ts: new Date("2026-11-05T10:00:00").getTime() },
      { id: 2, kind: "error", text: "第二条错误", ts: new Date("2026-11-05T10:01:00").getTime() },
    ],
  });
});

afterEach(() => {
  useUiStore.setState({ notifications: [] });
});

describe("通知记录分区", () => {
  test("(a) 空态：提示语在、清空钮不在", () => {
    useUiStore.setState({ notifications: [] });
    const host = mount();
    expect(host.querySelector('[data-testid="notifications-empty"]').textContent).toContain("notificationsEmpty");
    expect(host.querySelector('[data-testid="notifications-clear"]')).toBeNull();
  });

  test("(b) 最新在上，kind 徽标与全文都在（不截断历史文本）", () => {
    const host = mount();
    const rows = [...host.querySelectorAll('[data-testid="notification-row"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("第二条错误"); // 最新在上
    expect(rows[0].textContent).toContain("10:01:00");
    expect(rows[1].textContent).toContain("第一条提示");
    expect(host.querySelectorAll('[data-testid="notification-kind-error"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="notification-kind-info"]')).toHaveLength(1);
  });

  test("(c) 清空钮点击后历史归零、空态出现", () => {
    const host = mount();
    act(() => {
      host.querySelector('[data-testid="notifications-clear"]').dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(useUiStore.getState().notifications).toEqual([]);
    expect(host.querySelector('[data-testid="notifications-empty"]')).not.toBeNull();
  });
});
