// @ts-nocheck
// 顶栏站点名小字（engine-upgrade 2026-10-30 批次 todo3）两档两态渲染。
// 环境说明同 topbar-mobile-declutter.test.tsx：@ts-nocheck + 被测模块动态 import +
// @happy-dom 全局注册；渲染断言走 createRoot 真实 DOM（Radix 需真实挂载）。
// 验收：(a) 设置时手机档标题区（身份钮）渲染小字站点名且图标钮计数不变；
//       (b) 未设置时手机档不渲染；(c) 设置时桌面档标题钮内渲染小字且桌面入口原样；
//       (d) 未设置时桌面档不渲染。
import { describe, expect, test, vi, beforeEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

// 档位开关：mobileMatches 置 true（<lg 手机档）/false（桌面档），同减负测试先例
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

// api 整模块代理 mock（同 topbar-mobile-declutter 先例）：方法名缓存同一 vi.fn
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
const { Topbar } = await import("../topbar");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");

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

async function mount(ui) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  await act(async () => {}); // 冲刷挂载期微任务
  return { container, root };
}

beforeEach(() => {
  document.body.innerHTML = "";
  mobileMatches = false;
  resetStores();
  apiFns.clear();
  delete window.__SITE_NAME__;
});

describe("顶栏站点名小字（todo3）", () => {
  test("(a) 设置时手机档标题区渲染小字，图标钮计数与减负基线一致", async () => {
    mobileMatches = true;
    window.__SITE_NAME__ = "测试站";
    const { container } = await mount(createElement(Topbar, { onToggleTodoPanel: () => {} }));
    const el = container.querySelector('[data-testid="topbar-site-name"]');
    expect(el).toBeTruthy();
    expect(el.textContent).toBe("测试站");
    // 小字位于会话身份钮内（标题区）
    const identity = container.querySelector('[data-testid="mobile-session-identity"]');
    expect(identity.contains(el)).toBe(true);
    // 图标布局不变：可点按钮计数与 topbar-mobile-declutter 基线同口径 == 2
    const header = container.querySelector("header");
    const buttons = [...header.querySelectorAll("button")].filter(
      (b) => !b.hasAttribute("data-testid") || b.dataset.testid === "todo-panel-toggle",
    );
    expect(buttons).toHaveLength(2);
  });

  test("(b) 未设置时手机档不渲染站点名", async () => {
    mobileMatches = true;
    const { container } = await mount(createElement(Topbar, { onToggleTodoPanel: () => {} }));
    expect(container.querySelector('[data-testid="topbar-site-name"]')).toBeNull();
  });

  test("(c) 设置时桌面档标题钮内渲染小字，桌面入口原样", async () => {
    window.__SITE_NAME__ = "生产甲实例";
    const { container } = await mount(createElement(Topbar, { onToggleTodoPanel: () => {} }));
    const el = container.querySelector('[data-testid="topbar-site-name"]');
    expect(el).toBeTruthy();
    expect(el.textContent).toBe("生产甲实例");
    expect(container.querySelector('[data-testid="model-switch"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="settings-button"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="files-button"]')).toBeTruthy();
  });

  test("(d) 未设置时桌面档不渲染站点名", async () => {
    const { container } = await mount(createElement(Topbar, { onToggleTodoPanel: () => {} }));
    expect(container.querySelector('[data-testid="topbar-site-name"]')).toBeNull();
  });
});
