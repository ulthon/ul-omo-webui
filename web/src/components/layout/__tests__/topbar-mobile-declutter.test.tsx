// @ts-nocheck
// r10 todo 6：手机顶栏减负——设置入口迁抽屉、水位环迁输入框下方细条。
// 环境说明同 session-item-expand-removed.test.tsx：@ts-nocheck + 被测模块动态 import +
// @happy-dom 全局注册；渲染断言走 createRoot 真实 DOM（Radix Popover 需真实挂载）。
// 验收：(a) 手机档顶栏图标计数==2（汉堡+右栏入口），设置/文件/水位环 DOM 消失；
//       (b) 抽屉含设置/文件项，点击开对应全屏页并收抽屉；
//       (c) 水位细条在 Composer 下方渲染且百分比与水位环同源同值；无数据整条隐藏；
//       (d) 桌面档顶栏设置/文件/帮助钮原样保留（lg+ 零变化锁定）。
import { describe, expect, test, vi, beforeEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

// 档位开关：mobileFixture() 置 matches:true（<lg 手机档），desktopFixture() 恢复 false
let mobileMatches = false;
window.matchMedia = ((query: string) =>
  ({
    matches: mobileMatches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

// api 整模块代理 mock（同 session-list-new-session-icon 先例）：方法名缓存同一 vi.fn
const apiFns = new Map();
vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (!apiFns.has(key))
          apiFns.set(
            key,
            vi.fn(() =>
              Promise.resolve({
                global: [],
                project: [],
                projects: [],
                sessions: [],
                items: [],
                list: [],
                usage: {},
              }),
            ),
          );
        return apiFns.get(key);
      },
    },
  ),
  ApiError: class ApiError extends Error {},
  shortModelName: (m: string) => m,
}));
vi.mock("@/lib/bootstrap", () => ({ loadProjectModels: vi.fn(() => Promise.resolve({})) }));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@/lib/api");
const { Topbar } = await import("../topbar");
const { AppSidebar } = await import("@/pages/shell");
const { ContextUsageBar } = await import("../context-usage-bar");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");
const { calibrateContextPercent } = await import("@/components/layout/context-percent");
const { toUsageStats } = await import("@/components/chat/status-bar-data");
const { t: tSnap } = await import("@/i18n/i18n");

const HAMBURGER_LABEL = tSnap("login.topbar.openSidebar");

const USAGE_PAYLOAD = {
  usage: {
    cost: 0.12,
    tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
    contextUsage: { tokens: 2000, contextWindow: 10000, percent: 20 },
  },
};

function resetStores() {
  useUiStore.setState({
    currentProject: "/tmp/p",
    projects: [{ projectPath: "/tmp/p", preferredModel: null, lastOpenedAt: null }],
    models: [],
    modelsLoaded: false,
    selectedModel: null,
    drawerOpen: false,
    settingsPageOpen: false,
    filesPageOpen: false,
    connection: "online",
  });
  useSessionsStore.setState({
    byProject: {
      "/tmp/p": [{ id: "s1", title: "会话一", project: "/tmp/p", modified: 1, modifiedAt: 1, pinned: false, archived: false, unreadCount: 0 }],
    },
    selectedId: "s1",
    archived: "false",
    loading: false,
    runStates: {},
    appliedModels: {},
  });
}

async function mount(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  await act(async () => {}); // 冲刷挂载期微任务（getUsage 等副作用）
  return { container, root };
}

beforeEach(() => {
  document.body.innerHTML = "";
  mobileMatches = false;
  resetStores();
  apiFns.clear();
});

describe("手机顶栏减负（r10 todo 6）", () => {
  test("(a) 手机档顶栏图标计数 == 2：汉堡 + 右栏入口；设置/文件/水位环 DOM 消失", async () => {
    mobileMatches = true;
    const { container } = await mount(createElement(Topbar, { onToggleTodoPanel: () => {} }));
    const header = container.querySelector("header");
    expect(header).toBeTruthy();
    // 图标类元素 = header 内全部 button（手机档身份区是 button 但带 flex 文本两行——
    // 仍按可点击元素计：计划口径「仅剩 2 图标」以 icon 变体钮计）
    const iconButtons = [...header.querySelectorAll("button")].filter(
      (b) => !b.hasAttribute("data-testid") || b.dataset.testid === "todo-panel-toggle",
    );
    expect(iconButtons).toHaveLength(2);
    const labels = iconButtons.map((b) => b.getAttribute("aria-label"));
    expect(labels).toContain(HAMBURGER_LABEL);
    expect(labels).toContain(tSnap("login.topbar.openTodoPanel"));
    // 旧入口 DOM 不存在
    expect(header.querySelector('[data-testid="settings-button"]')).toBeNull();
    expect(header.querySelector('[data-testid="files-button"]')).toBeNull();
    expect(header.querySelector('[data-testid="context-ring"]')).toBeNull();
  });

  test("(b) 抽屉菜单含设置/文件项，点击开设置页并收抽屉", async () => {
    useUiStore.setState({ drawerOpen: true });
    const { container } = await mount(createElement(AppSidebar, { drawerOpen: true }));
    const settingsItem = container.querySelector('[data-testid="drawer-settings"]');
    const filesItem = container.querySelector('[data-testid="drawer-files"]');
    expect(settingsItem).toBeTruthy();
    expect(filesItem).toBeTruthy();
    expect(settingsItem.textContent).toContain(tSnap("login.topbar.settings"));
    await act(async () => {
      settingsItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(useUiStore.getState().settingsPageOpen).toBe(true);
    expect(useUiStore.getState().drawerOpen).toBe(false);
  });

  test("(c1) 水位细条在 Composer 落位组件中渲染，百分比与数据源一致", async () => {
    mobileMatches = true;
    api.getUsage.mockImplementation(() => Promise.resolve(USAGE_PAYLOAD));
    const expectedPct = Math.round(
      calibrateContextPercent(toUsageStats(USAGE_PAYLOAD.usage).context, null),
    );
    // 细条单测：同源数据驱动
    const { container } = await mount(createElement(ContextUsageBar, { sessionId: "s1" }));
    const bar = container.querySelector('[data-testid="context-usage-bar"]');
    expect(bar).toBeTruthy();
    const fill = container.querySelector('[data-testid="context-usage-bar-fill"]');
    expect(fill.getAttribute("data-percent")).toBe(String(expectedPct));
    expect(Number(bar.getAttribute("aria-valuenow"))).toBe(expectedPct);
  });

  test("(c2) 水位数据缺失时细条隐藏不占位", async () => {
    api.getUsage.mockImplementation(() => Promise.resolve({ usage: {} }));
    const { container } = await mount(createElement(ContextUsageBar, { sessionId: "s1" }));
    expect(container.querySelector('[data-testid="context-usage-bar"]')).toBeNull();
  });

  test("(d) 桌面档顶栏设置/文件/帮助钮与模型下拉原样保留（lg+ 零变化）", async () => {
    mobileMatches = false;
    const { container } = await mount(createElement(Topbar, { onToggleTodoPanel: () => {} }));
    expect(container.querySelector('[data-testid="settings-button"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="files-button"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="shortcuts-help-button"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="model-switch"]')).toBeTruthy();
    // 桌面档本就无水位环（StatusBar 承担），顶栏不变式保持
    expect(container.querySelector('[data-testid="context-ring"]')).toBeNull();
  });
});
