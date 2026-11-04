/**
 * 手机抽屉头部重整回归测试（openchamber 形态对齐批次）：
 * - 头部不再渲染项目名（项目名重复且常驻旧名易误导，切换入口在顶栏/会话切换 sheet）
 * - 关闭钮存在于标题行内、自然居中规格（h-12 行 + size-10 圆形，无负 margin 矫正类）
 * - 抽屉功能入口不回退：底部菜单（文件/设置）仍在
 * 场景走真实组件（happy-dom + react-dom/client，sidebar-single-list.test.tsx 同款基建）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// bun test 单进程跑多文件：其他测试可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { AppSidebar } = await import("@/pages/shell");
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useUiStore.setState({ currentProject: "/home/user/photo", drawerOpen: true });
  // SessionList 挂载会拉会话聚合，统一空响应
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ projects: {}, tags: { global: [], project: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("mobile drawer header", () => {
  test("头部不渲染项目名（photo 残留去除）", () => {
    act(() => root.render(createElement(AppSidebar, { drawerOpen: true })));
    expect(container.textContent).not.toContain("photo");
    // 头部语义仍在
    expect(container.querySelector('[data-testid="sidebar-close"]')).not.toBeNull();
  });

  test("关闭钮位于标题行内、自然居中规格（结构断言）", () => {
    act(() => root.render(createElement(AppSidebar, { drawerOpen: true })));
    const close = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-close"]');
    expect(close).not.toBeNull();
    // 行内直属标题行（非浮动/负 margin 挤入）
    const row = close?.parentElement;
    expect(row?.className).toContain("h-12");
    expect(row?.className).toContain("items-center");
    // 圆形 ghost 规格，无负 margin 矫正类
    const cls = close?.className ?? "";
    expect(cls).toContain("size-10");
    expect(cls).toContain("rounded-full");
    expect(cls).not.toMatch(/-mt-|-mb-|mt-1|^-m/);
  });

  test("抽屉功能入口仍在：底部文件/设置菜单", () => {
    act(() => root.render(createElement(AppSidebar, { drawerOpen: true })));
    expect(container.querySelector('[data-testid="drawer-menu"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="drawer-files"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="drawer-settings"]')).not.toBeNull();
  });
});
