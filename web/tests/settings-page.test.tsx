// @ts-nocheck
// 设置独立全屏页集成测试（r9 2026-10-26 批次任务 9，弹层退役）：
// (1) 顶栏设置入口点击进入设置页；(2) 原有设置项在页上可用（权限预设改值、排序档位
// 切换各至少一条真实链路断言）；(3) 设置弹层不再渲染（页面打开态无任何 dialog）；
// (4) 返回按钮回原视图。惯例同 project-removal.test.tsx：@happy-dom 全局注册 +
// createRoot/act 真实点击，radix Dialog 原语 mock 为条件容器，api 层 mock fetch。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// radix Dialog 原语透传化：Dialog 按 open 条件渲染 children，其余原语为普通容器
vi.mock("@/components/ui/dialog", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Conditional = ({
    open,
    children,
  }: {
    open?: boolean;
    children?: React.ReactNode;
  }) => (open ? <div data-testid="dialog-root" role="dialog">{children}</div> : null);
  return {
    Dialog: Conditional,
    DialogContent: Passthrough,
    DialogDescription: Passthrough,
    DialogFooter: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
  };
});

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Topbar } = await import("@/components/layout/topbar");
const { SettingsPage } = await import("@/pages/settings");
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;

function project(path: string, extra?: Partial<{ permissionPreset: string | null }>): Record<string, unknown> {
  return {
    projectPath: path,
    preferredModel: null,
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/** 设置页首屏各分区的只读拉取（空集合最小快照，契约字段齐全） */
function readback(path: string): unknown {
  if (path === "/api/models/discover") return { providers: [] };
  if (path === "/api/stats/traffic") return { day: "2026-01-01", generatedAt: "2026-01-01T00:00:00.000Z", endpoints: [], system: { available: false } };
  if (path === "/api/extensions") return { items: [], cliAvailable: false };
  if (path === "/api/auth/status") return { status: "not_configured", provider: null, checkedAt: 0, detail: null };
  if (path === "/api/schedule") return { jobs: [], runner: { alive: false }, invalid: [] };
  if (path === "/api/projects/tools") return { tools: [{ name: "read", builtin: true }, { name: "bash", builtin: true }, { name: "edit", builtin: true }, { name: "write", builtin: true }, { name: "grep", builtin: true }] };
  return { ok: true };
}

function recordingFetch(calls: Array<{ path: string; method: string; body?: unknown }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ path, method, body });
    if (method === "GET") return okJson(readback(path));
    return okJson({ ok: true });
  }) as typeof fetch;
}

/** 微任务 + 宏任务双重冲刷（设置链路为 fetch → store 更新） */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 最小壳：复刻 shell 的接线——顶栏常驻，settingsPageOpen 为真时渲染设置页 */
function Probe() {
  const open = useUiStore((s) => s.settingsPageOpen);
  return createElement("div", null, createElement(Topbar, { onToggleTodoPanel: () => {} }), open ? createElement(SettingsPage) : null);
}

beforeEach(() => {
  useUiStore.setState({
    projects: [project("/p1", { permissionPreset: null })],
    currentProject: "/p1",
    settingsPageOpen: false,
    toast: null,
    projectSort: "activity",
  });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

async function mountProbe(): Promise<{ container: HTMLElement; root: ReturnType<typeof createRoot> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe));
  });
  return { container, root };
}

describe("设置独立全屏页（弹层退役）", () => {
  test("顶栏入口进入设置页；权限预设改值落 PATCH；返回回原视图；打开态无设置弹层", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    globalThis.fetch = recordingFetch(calls);

    const { container, root } = await mountProbe();

    // 初始态：无设置页、无任何 dialog（设置弹层已退役）
    expect(container.querySelector('[data-testid="settings-page"]')).toBeNull();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);

    // (1) 顶栏设置入口点击进入设置页
    const settingsButton = container.querySelector('[data-testid="settings-button"]') as HTMLButtonElement;
    expect(settingsButton).not.toBeNull();
    await act(async () => {
      settingsButton.click();
    });
    const page = container.querySelector('[data-testid="settings-page"]');
    expect(page).not.toBeNull();
    expect(useUiStore.getState().settingsPageOpen).toBe(true);
    // 分组收拢：项目区/全局区两个分区标题在页上
    expect(page.textContent).toContain("项目区");
    expect(page.textContent).toContain("全局区");
    // (3) 设置页打开态仍无任何 dialog（弹层退役；确认类弹层仅在动作时挂载）
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);

    // (2a) 权限预设改值：PATCH /api/projects/meta + store 同步
    const presetSelect = container.querySelector('[data-testid="permission-preset-select"]') as HTMLSelectElement;
    expect(presetSelect).not.toBeNull();
    await act(async () => {
      presetSelect.value = "workspace";
      presetSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch.body).toMatchObject({ permissionPreset: "workspace" });
    expect(useUiStore.getState().projects[0].permissionPreset).toBe("workspace");

    // (2b) 侧栏排序档位切换：PUT /api/settings + store 同步
    const sortLabel = container.querySelector('[data-testid="project-sort-option-added"]') as HTMLLabelElement;
    expect(sortLabel).not.toBeNull();
    await act(async () => {
      sortLabel.click();
    });
    await flush();
    const putSettings = calls.find((c) => c.method === "PUT" && c.path === "/api/settings");
    expect(putSettings).toBeDefined();
    expect(putSettings.body).toMatchObject({ "sidebar.projectSort": "added" });
    expect(useUiStore.getState().projectSort).toBe("added");

    // (4) 返回按钮回原视图
    const backButton = container.querySelector('[data-testid="settings-back-button"]') as HTMLButtonElement;
    expect(backButton).not.toBeNull();
    await act(async () => {
      backButton.click();
    });
    expect(useUiStore.getState().settingsPageOpen).toBe(false);
    expect(container.querySelector('[data-testid="settings-page"]')).toBeNull();

    await act(async () => {});
    root.unmount();
  });

  test("重复进出设置页状态干净：关闭后再开设置项仍可用（标签展示档切换链路）", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    globalThis.fetch = recordingFetch(calls);

    const { container, root } = await mountProbe();
    const openPage = async () => {
      await act(async () => {
        (container.querySelector('[data-testid="settings-button"]') as HTMLButtonElement).click();
      });
    };
    await openPage();
    expect(container.querySelector('[data-testid="settings-page"]')).not.toBeNull();
    // 返回后再开
    await act(async () => {
      (container.querySelector('[data-testid="settings-back-button"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="settings-page"]')).toBeNull();
    await openPage();

    // 标签展示档（第二轮打开仍可用）：切到色格
    const gridOption = container.querySelector('[data-testid="tag-display-mode-option-grid"]') as HTMLLabelElement;
    expect(gridOption).not.toBeNull();
    await act(async () => {
      gridOption.click();
    });
    await flush();
    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/settings");
    expect(put).toBeDefined();
    expect(put.body).toMatchObject({ "tags.displayMode": "grid" });
    expect(useUiStore.getState().tagDisplayMode).toBe("grid");

    await act(async () => {});
    root.unmount();
  });
});
