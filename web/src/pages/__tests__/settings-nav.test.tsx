// @ts-nocheck
// settings-page-nav 任务 5：设置页五组导航行为测试（页面级，4 例）。
// 骨架同 rebind-section.test.tsx：@ts-nocheck + @happy-dom/global-registrator 全局注册 +
// matchMedia stub + api 整模块 Proxy mock + 被测模块动态 import + createRoot/act
// （业务模块导入必须放在 happy-dom 注册之后：locale/ui store 初始化读 DOM 全局）。
// api 罐头照 task3 渲染验证脚本（/tmp/task3-api-mock.mjs，已真实渲染调通）写死：
// 空集合 { global/project/projects/sessions/items/list/providers/engines/settings } +
// auth/schedule/traffic/diagnostics/update 定向形态照搬；model 组真实挂载跑 effect 需要
// engines/settings/providers 字段，缺则 TypeError（ToolsSection 自带 Array.isArray 兜底）。
// 每例开头显式重置 ui store：zustand 单例跨用例污染防护，且 permission-preset-select
// 需 currentProject 才渲染。只断言 data-testid 与 aria 属性，不断言 i18n 文案。
// 验收：(a) 默认 project 组单组渲染；(b) 点 model 组单组切换；(c) aria-selected 精确
// 字符串（IS-6）；(d) 关开设置页组记忆保持（IS-5）。
import { afterEach, describe, expect, test, vi } from "vitest";
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// api 整模块代理 mock：罐头照 /tmp/task3-api-mock.mjs 照搬（定向键给专形，其余同罐头）
const canned = { global: [], project: [], projects: [], sessions: [], items: [], list: [], providers: [], engines: [], settings: {} };
const apiShape = (key: string) => {
  if (key === "listProjects") return { projects: canned.projects };
  if (key === "listModels") return { models: canned.items };
  if (key === "getAuthStatus") return { status: "not_configured" };
  if (key === "listSchedule") return { runner: { alive: true }, jobs: [], invalid: [] };
  if (key === "getTraffic") return { day: "", generatedAt: "", endpoints: [], system: { available: false } };
  if (key === "diagnosticsLogs") return { logs: [] };
  if (key === "diagnosticsSummary") return {};
  if (key === "getDiagnosticsFlags") return {};
  if (key === "updateCheck") return { webui: { latest: "0.0.0", current: "0.0.0", updateAvailable: false } };
  return canned;
};
vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    { get: (_t, key) => () => Promise.resolve(apiShape(String(key))) },
  ),
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SettingsPage } = await import("@/pages/settings");
const { useUiStore } = await import("@/stores/ui");

const PROJECT = "/tmp/proj";

/** 每例显式重置 ui store（zustand 单例跨用例污染防护） */
function resetUiStore() {
  useUiStore.setState({
    settingsGroup: "project",
    currentProject: PROJECT,
    projects: [{ projectPath: PROJECT, preferredModel: null, lastOpenedAt: null }],
  });
}

/** 挂载后冲刷挂载期 effect 微任务（api promise resolve 不落在 act 外，免 act 告警） */
async function mountPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SettingsPage));
  });
  await act(async () => {});
  return { container, root };
}

/** 点击（happy-dom + React 事件委托惯例：bubbling MouseEvent，与 rebind 测试同款） */
function click(el: Element) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/** 切到 model 组并冲刷挂载期 effect 微任务（listEngines/listProviders 等） */
async function switchToModel(container: HTMLElement) {
  await act(async () => {
    click(container.querySelector('[data-testid="settings-group-tab-model"]'));
  });
  await act(async () => {});
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("设置页五组导航（settings-page-nav 任务 5）", () => {
  test("(a) 默认 project 组：权限预设在场、语言组不在场、project tab 选中", async () => {
    resetUiStore();
    const { container, root } = await mountPage();
    expect(container.querySelector('[data-testid="permission-preset-select"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="language-group"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="settings-group-tab-project"]').getAttribute("aria-selected"),
    ).toBe("true");
    root.unmount();
  });

  test("(b) 点 model 组：引擎与模型发现在场、project 组内容退场", async () => {
    resetUiStore();
    const { container, root } = await mountPage();
    await switchToModel(container);
    expect(container.querySelector('[data-testid="engine-idle-group"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="models-discover-section"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="permission-preset-select"]')).toBeNull();
    root.unmount();
  });

  test("(c) 切 model 后 aria-selected 字符串精确比较：model true / project false", async () => {
    resetUiStore();
    const { container, root } = await mountPage();
    await switchToModel(container);
    expect(
      container.querySelector('[data-testid="settings-group-tab-model"]').getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="settings-group-tab-project"]').getAttribute("aria-selected"),
    ).toBe("false");
    root.unmount();
  });

  test("(d) 关开设置页：组记忆保持（setSettingsPageOpen 不重置 settingsGroup）", async () => {
    resetUiStore();
    const { container, root } = await mountPage();
    await switchToModel(container);
    act(() => {
      useUiStore.getState().setSettingsPageOpen(false);
      useUiStore.getState().setSettingsPageOpen(true);
    });
    expect(container.querySelector('[data-testid="engine-idle-group"]')).toBeTruthy();
    expect(useUiStore.getState().settingsGroup).toBe("model");
    root.unmount();
  });
});
