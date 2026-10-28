// @ts-nocheck
// 手机档隐藏快捷键帮助图标（docs08-2026-10-23-24 任务 16）：
// (1) 手机档渲染 → 不存在 shortcuts-help-button；(2) 桌面档渲染 → 钮存在且点击后
// 快捷键帮助对话框真实打开（回归保护）。惯例同 topbar-mobile-add-project.test.tsx：
// @happy-dom 全局注册 + createRoot/act 真实点击，matchMedia 探针控制 isMobile。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Topbar } = await import("@/components/layout/topbar");
const { useUiStore } = await import("@/stores/ui");

const TOPBAR_MOBILE_QUERY = "(max-width: 1023.98px)";
const REAL_MATCH_MEDIA = window.matchMedia.bind(window);

function stubMatchMedia(mobile: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: mobile && query === TOPBAR_MOBILE_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  useUiStore.setState({ projects: [], currentProject: null, shortcutsHelpOpen: false });
});

afterEach(() => {
  window.matchMedia = REAL_MATCH_MEDIA;
  document.body.innerHTML = "";
});

async function mountTopbar(mobile: boolean): Promise<HTMLDivElement> {
  stubMatchMedia(mobile);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Topbar, { onToggleTodoPanel: () => {} }));
  });
  return container;
}

describe("任务16 手机档隐藏快捷键帮助图标", () => {
  test("手机档渲染：快捷键帮助钮不存在（r10 todo 6 后设置钮亦入抽屉，顶栏仅 2 图标）", async () => {
    const container = await mountTopbar(true);
    expect(container.querySelector('[data-testid="shortcuts-help-button"]')).toBeNull();
    // r10 todo 6：设置入口迁汉堡抽屉（shell.tsx AppSidebar drawer-settings），顶栏 DOM 消失
    expect(container.querySelector('[data-testid="settings-button"]')).toBeNull();
    // 卸载（act 内清理，避免悬挂渲染）
    await act(async () => {});
  });

  test("桌面档渲染：帮助钮存在且点击打开快捷键对话框（回归）", async () => {
    const container = await mountTopbar(false);
    const button = container.querySelector('[data-testid="shortcuts-help-button"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(useUiStore.getState().shortcutsHelpOpen).toBe(false);
    await act(async () => {
      button.click();
    });
    expect(useUiStore.getState().shortcutsHelpOpen).toBe(true);
    const dialog = document.querySelector('[data-testid="shortcuts-dialog"], [role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent ?? "").toContain("快捷键");
    await act(async () => {});
  });
});
