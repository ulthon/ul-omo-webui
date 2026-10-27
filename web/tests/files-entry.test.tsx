// @ts-nocheck
// 文件管理入口单测（builtin-file-management 任务 1）。环境惯例同 tests/topbar-mobile-
// add-project.test.tsx：@happy-dom 全局注册 + createRoot/act 真实点击。覆盖：
// (1) 顶栏桌面档 files-button 存在，点击后 ui store filesPageOpen 为 true；
// (2) 手机档 files-button 同样存在且可点击置位；
// (3) 占位页（files-page）渲染域名标题；返回钮点击后 filesPageOpen 复位 false。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Topbar } = await import("@/components/layout/topbar");
const { FilesPagePlaceholder } = await import("@/pages/shell");
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
  useUiStore.setState({ filesPageOpen: false });
});

afterEach(() => {
  window.matchMedia = REAL_MATCH_MEDIA;
  document.body.innerHTML = "";
});

async function mountTopbar() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Topbar, { onToggleTodoPanel: () => {} }));
  });
  return { container, root };
}

describe("builtin-file-management 任务 1：顶栏文件管理入口与占位页", () => {
  test("桌面档 files-button 存在，点击后 filesPageOpen 置 true", async () => {
    stubMatchMedia(false);
    const { container, root } = await mountTopbar();
    const button = container.querySelector('[data-testid="files-button"]');
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("打开文件管理");
    expect(useUiStore.getState().filesPageOpen).toBe(false);
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useUiStore.getState().filesPageOpen).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });

  test("手机档 files-button 存在，点击后 filesPageOpen 置 true", async () => {
    stubMatchMedia(true);
    const { container, root } = await mountTopbar();
    const button = container.querySelector('[data-testid="files-button"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useUiStore.getState().filesPageOpen).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });

  test("占位页渲染 files-page 与域名标题，返回钮点击后 filesPageOpen 复位 false", async () => {
    const html = renderToStaticMarkup(createElement(FilesPagePlaceholder));
    expect(html).toContain('data-testid="files-page"');
    expect(html).toContain("文件管理");
    useUiStore.setState({ filesPageOpen: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(FilesPagePlaceholder));
    });
    const close = container.querySelector('[data-testid="files-page-close"]');
    expect(close).not.toBeNull();
    await act(async () => {
      close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useUiStore.getState().filesPageOpen).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
});
