// 通知中心组件单测（全局错误改通知中心，方案 A）。环境说明同 notifications-section.test.tsx：
// @ts-nocheck + 被测模块动态 import + @happy-dom 全局注册；真实 ui store setState 驱动。
// 验收：(a) 无通知入口置灰不可点、无角标；(b) 有通知角标计数、点入口开面板（testid 齐）；
// (c) 条目点按展开详情（完整文本 + 复制）；(d) 单条关闭；(e) 清空钮清空并空态。
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

vi.mock("@/i18n/i18n", () => ({
  useT: () => (key: string) => key,
}));
vi.mock("@/lib/clipboard", () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
}));

const { NotificationCenter } = await import("@/components/layout/notification-center");
const { useUiStore } = await import("@/stores/ui");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

function mount(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(NotificationCenter));
  });
  return host;
}

function setNotifs(items: { text: string; count: number }[]) {
  useUiStore.setState({
    globalNotifs: items.map((it, i) => ({ ...it, ts: 1700000000000 + i })),
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  useUiStore.setState({ globalNotifs: [], notifCenterOpen: false });
});

afterEach(() => {
  useUiStore.setState({ globalNotifs: [], notifCenterOpen: false });
});

describe("通知中心组件", () => {
  test("(a) 无通知：入口禁用、无角标、点按不开面板", () => {
    const host = mount();
    const toggle = host.querySelector('[data-testid="notif-center-toggle"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(host.querySelector('[data-testid="notif-badge"]')).toBeNull();
    act(() => toggle.dispatchEvent(new Event("click", { bubbles: true })));
    expect(host.querySelector('[data-testid="notif-panel"]')).toBeNull();
  });

  test("(b) 有通知：角标显示合计次数，点入口开面板", () => {
    setNotifs([{ text: "错误一", count: 2 }, { text: "错误二", count: 3 }]);
    const host = mount();
    const badge = host.querySelector('[data-testid="notif-badge"]');
    expect(badge?.textContent).toBe("5");
    const toggle = host.querySelector('[data-testid="notif-center-toggle"]') as HTMLButtonElement;
    act(() => toggle.dispatchEvent(new Event("click", { bubbles: true })));
    const panel = host.querySelector('[data-testid="notif-panel"]');
    expect(panel).not.toBeNull();
    const items = [...host.querySelectorAll('[data-testid="notif-item"]')];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("错误一");
    expect(items[0].textContent).toContain("×2");
  });

  test("(c) 条目点按展开详情：完整文本可复制", async () => {
    setNotifs([{ text: "很长的错误详情\n第二行", count: 1 }]);
    const host = mount();
    act(() => {
      (host.querySelector('[data-testid="notif-center-toggle"]') as HTMLButtonElement)
        .dispatchEvent(new Event("click", { bubbles: true }));
    });
    const item = host.querySelector('[data-testid="notif-item"]') as HTMLElement;
    // 展开前长文本换行不整体渲染（truncate）
    expect(item.querySelector("textarea, .whitespace-pre-wrap")).toBeNull();
    act(() => item.dispatchEvent(new Event("click", { bubbles: true })));
    const detail = item.querySelector(".whitespace-pre-wrap");
    expect(detail?.textContent).toContain("第二行");
    expect(item.querySelector('[data-testid="notif-item-copy"]')).not.toBeNull();
  });

  test("(d) 单条关闭：目标条消失其余保留", () => {
    setNotifs([{ text: "e1", count: 1 }, { text: "e2", count: 1 }]);
    const host = mount();
    act(() => {
      (host.querySelector('[data-testid="notif-center-toggle"]') as HTMLButtonElement)
        .dispatchEvent(new Event("click", { bubbles: true }));
    });
    const dismiss = host.querySelector('[data-testid="notif-item"] button[aria-label="login.topbar.notifDismiss"]') as HTMLButtonElement;
    act(() => dismiss.dispatchEvent(new Event("click", { bubbles: true })));
    expect(useUiStore.getState().globalNotifs.map((n: { text: string }) => n.text)).toEqual(["e2"]);
  });

  test("(e) 清空钮：全部清空、面板收起", () => {
    setNotifs([{ text: "e1", count: 4 }]);
    const host = mount();
    act(() => {
      (host.querySelector('[data-testid="notif-center-toggle"]') as HTMLButtonElement)
        .dispatchEvent(new Event("click", { bubbles: true }));
    });
    const clear = host.querySelector('[data-testid="notif-clear"]') as HTMLButtonElement;
    act(() => clear.dispatchEvent(new Event("click", { bubbles: true })));
    expect(useUiStore.getState().globalNotifs).toEqual([]);
    expect(useUiStore.getState().notifCenterOpen).toBe(false);
    expect(host.querySelector('[data-testid="notif-badge"]')).toBeNull();
  });
});
