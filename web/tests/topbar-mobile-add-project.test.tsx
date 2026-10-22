// @ts-nocheck
// 手机档添加项目双入口（docs08-r7 任务 4）：composer-mobile-layout 惯例——
// @happy-dom 全局注册 + renderToStaticMarkup 静态断言 + createRoot/act 真实点击。
// 覆盖：(1) 最近会话菜单尾「添加项目…」项存在；(2) 设置面板项目管理头部「添加项目」
// 钮存在；(3) 点击后 AddProjectDialog 真实打开（条件挂载弹窗体出现）。
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
const { ProjectManagementSection, RecentSessionsMenuItems } = await import(
  "@/components/layout/topbar"
);
const { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } = await import(
  "@/components/ui/dropdown-menu"
);
const { useUiStore } = await import("@/stores/ui");

beforeEach(() => {
  useUiStore.setState({ projects: [], currentProject: null });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("任务4 手机档添加项目双入口", () => {
  test("最近会话菜单尾含「添加项目…」项", async () => {
    // DropdownMenuItem 须在 Menu 上下文内：defaultOpen 挂载后 portal 中查询
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          DropdownMenu,
          { defaultOpen: true },
          createElement(DropdownMenuTrigger, { asChild: true }, createElement("button", { type: "button" })),
          createElement(
            DropdownMenuContent,
            null,
            createElement(RecentSessionsMenuItems, { onAddProject: () => {} }),
          ),
        ),
      );
    });
    const item = document.querySelector('[data-testid="mobile-add-project"]');
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain("添加项目…");
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
