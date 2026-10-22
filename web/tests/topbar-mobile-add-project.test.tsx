// @ts-nocheck
// 手机档添加项目双入口（docs08-r7 任务 4 → 任务 19 迁移为全屏 sheet）：composer-mobile-
// layout 惯例——@happy-dom 全局注册 + renderToStaticMarkup 静态断言 + createRoot/act
// 真实点击。覆盖：(1) 全屏会话切换 sheet 尾部「添加项目…」项存在且点击后 AddProjectDialog
// 真实打开（Radix Dialog 真实原语，sheet 先关、对话框随后出现）；(2) 设置面板项目管理
// 头部「添加项目」钮存在；(3) 点击后 AddProjectDialog 真实打开。
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
const { ProjectManagementSection, Topbar } = await import("@/components/layout/topbar");
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
  useUiStore.setState({ projects: [], currentProject: null });
  stubMatchMedia(true);
});

afterEach(() => {
  window.matchMedia = REAL_MATCH_MEDIA;
  document.body.innerHTML = "";
});

describe("任务4 手机档添加项目双入口", () => {
  test("会话切换 sheet 尾含「添加项目…」项，点击后 AddProjectDialog 打开", async () => {
    useUiStore.setState({ projects: [], currentProject: null });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Topbar, { onToggleTodoPanel: () => {} }));
    });
    // 手机档身份区触发钮开 sheet，尾部「添加项目…」可达
    const trigger = container.querySelector('[data-testid="mobile-session-identity"]') as HTMLElement;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const item = document.querySelector('[data-testid="mobile-add-project"]');
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain("添加项目…");
    // 点击：sheet 关闭 + AddProjectDialog 打开（Topbar onAddProject 通道）
    await act(async () => {
      item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="session-switcher-sheet"]')).toBeNull();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent ?? "").toContain("添加项目");
    await act(async () => {
      root.unmount();
    });
  });

  test("设置面板项目管理头部含「添加项目」钮", () => {
    const html = renderToStaticMarkup(createElement(ProjectManagementSection));
    expect(html).toContain('data-testid="project-add-button"');
    expect(html).toContain("添加项目");
  });

  test("点击「添加项目」钮后 AddProjectDialog 打开", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ProjectManagementSection));
    });
    const button = container.querySelector('[data-testid="project-add-button"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    await act(async () => {
      button.click();
    });
    // 弹窗条件挂载：标题出现即对话框真实打开
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent ?? "").toContain("添加项目");
    await act(async () => {
      root.unmount();
    });
  });
});
