// @ts-nocheck
// r10 todo 18：设置页「导入旧目录会话」入口 + 扫描预览 + 导入重绑流程。
// 环境说明同 session-list-new-session-icon.test.tsx：@ts-nocheck + 被测模块动态 import +
// @happy-dom 全局注册；标记断言走 renderToStaticMarkup，交互行为走 createRoot 真实 DOM。
// 验收：(a) 设置页渲染含入口；(b) 无当前项目 → 提示且无输入框；(c) 扫描调
// scanRebindSessions 且预览行/alreadyBound 徽标渲染；(d) 导入调 rebindSessions（仅选中
// id）+ 刷新会话列表 + 报告渲染；(e) 扫描失败 ApiError → 错误文案外显。
import { describe, expect, test, vi } from "vitest";
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

// api 整模块代理 mock：rebind 两方法可编程；其余方法名缓存同一 vi.fn（resolve 空形态），
// 挂载期 refreshSessions/bootstrap 等副作用全部吞掉。
const scanFn = vi.fn();
const rebindFn = vi.fn();
const apiFns = new Map();
vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "scanRebindSessions") return scanFn;
        if (key === "rebindSessions") return rebindFn;
        if (!apiFns.has(key))
          apiFns.set(
            key,
            vi.fn(() => Promise.resolve({ global: [], project: [], projects: [], sessions: [], items: [], list: [] })),
          );
        return apiFns.get(key);
      },
    },
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
vi.mock("@/lib/bootstrap", () => ({ loadProjectModels: vi.fn(() => Promise.resolve({})) }));

const { createElement, act } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");
const { SettingsPage } = await import("@/pages/settings");
const { RebindSection } = await import("@/components/settings/rebind-section");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");

const PROJECT = "/tmp/proj";

function mount(Comp: unknown) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Comp));
  });
  return { container, root };
}

/** 点击（happy-dom + React 事件委托惯例：bubbling MouseEvent，与 session-list 测试同款） */
function click(el: Element) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function typeInto(input: HTMLInputElement, value: string) {
  // React 受控 input 的 value tracker 会忽略直接赋值：必须走原生 setter 再派发 input 事件
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const SCAN_FIXTURE = {
  project: PROJECT,
  oldPath: "/data/projects/old-repo",
  totalFiles: 3,
  sessions: [
    { id: "sess-1", name: null, firstMessage: "修复登录 bug", messageCount: 4, created: "2026-10-01T00:00:00.000Z", modified: "2026-10-02T00:00:00.000Z", alreadyBound: false },
    { id: "sess-2", name: "部署重构", firstMessage: "", messageCount: 0, created: "2026-10-01T00:00:00.000Z", modified: "2026-10-03T00:00:00.000Z", alreadyBound: true },
  ],
};

describe("设置页入口（r10 todo 18）", () => {
  test("(a) SettingsPage 渲染含「导入旧目录会话」入口（输入框 + 扫描钮）", () => {
    useUiStore.setState({ currentProject: PROJECT, projects: [{ projectPath: PROJECT, preferredModel: null, lastOpenedAt: null }] });
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).toContain('data-testid="rebind-old-path-input"');
    expect(html).toContain('data-testid="rebind-scan-button"');
    expect(html).toContain("导入旧目录会话");
  });

  test("(b) 无当前项目：提示先选项目，无输入框", () => {
    useUiStore.setState({ currentProject: null, projects: [] });
    const html = renderToStaticMarkup(createElement(RebindSection));
    expect(html).toContain('data-testid="rebind-need-project"');
    expect(html).not.toContain('data-testid="rebind-old-path-input"');
  });
});

describe("扫描预览与导入重绑流程", () => {
  test("(c) 输入旧路径点扫描：调 scanRebindSessions(project, oldPath)，预览行与 alreadyBound 徽标渲染", async () => {
    scanFn.mockReset();
    scanFn.mockResolvedValue(SCAN_FIXTURE);
    useUiStore.setState({ currentProject: PROJECT, projects: [{ projectPath: PROJECT, preferredModel: null, lastOpenedAt: null }] });
    useSessionsStore.setState({ byProject: {}, archived: "false", loading: false });

    const { container } = mount(RebindSection);
    const input = container.querySelector('[data-testid="rebind-old-path-input"]');
    const scanBtn = container.querySelector('[data-testid="rebind-scan-button"]');
    typeInto(input, "/data/projects/old-repo");
    await act(async () => {
      click(scanBtn);
    });
    expect(container.querySelector('[data-testid="rebind-scan-result"]')).toBeTruthy();

    expect(scanFn).toHaveBeenCalledWith(PROJECT, "/data/projects/old-repo");
    expect(container.textContent).toContain("修复登录 bug");
    expect(container.textContent).toContain("部署重构");
    // alreadyBound 行带徽标且勾选禁用；可导入行默认勾选
    expect(container.querySelector('[data-testid="rebound-bound-sess-2"]')).toBeTruthy();
    const check1 = container.querySelector('[data-testid="rebind-check-sess-1"]');
    const check2 = container.querySelector('[data-testid="rebind-check-sess-2"]');
    expect(check1.checked).toBe(true);
    expect(check2.checked).toBe(false);
    expect(check2.disabled).toBe(true);
    // totalFiles(3) 与 sessions(2) 差值 → 损坏跳过提示
    expect(container.querySelector('[data-testid="rebind-corrupt-hint"]').textContent).toContain("1");
  });

  test("(d) 点导入：调 rebindSessions（仅选中 id）+ refreshSessions + 报告渲染", async () => {
    scanFn.mockReset();
    rebindFn.mockReset();
    scanFn.mockResolvedValue(SCAN_FIXTURE);
    rebindFn.mockResolvedValue({
      project: PROJECT,
      oldPath: "/data/projects/old-repo",
      imported: [{ id: "sess-1", path: "/x/sess-1.jsonl", disposition: "moved" }],
      skipped: [{ id: "sess-9", reason: "rebind_conflict", message: "同名" }],
    });
    const refreshSpy = vi.spyOn(useSessionsStore.getState(), "refreshSessions").mockResolvedValue(undefined);
    useUiStore.setState({ currentProject: PROJECT, projects: [{ projectPath: PROJECT, preferredModel: null, lastOpenedAt: null }] });

    const { container } = mount(RebindSection);
    typeInto(container.querySelector('[data-testid="rebind-old-path-input"]'), "/data/projects/old-repo");
    await act(async () => {
      click(container.querySelector('[data-testid="rebind-scan-button"]'));
    });
    expect(container.querySelector('[data-testid="rebind-import-button"]')).toBeTruthy();
    await act(async () => {
      click(container.querySelector('[data-testid="rebind-import-button"]'));
    });
    expect(container.querySelector('[data-testid="rebind-report"]')).toBeTruthy();

    expect(rebindFn).toHaveBeenCalledWith(PROJECT, "/data/projects/old-repo", ["sess-1"]);
    expect(refreshSpy).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="rebind-report"]').textContent).toContain("1");
    expect(container.textContent).toContain("sess-9");
    refreshSpy.mockRestore();
  });

  test("(e) 扫描失败（400 invalid_old_path）：错误文案外显不崩", async () => {
    scanFn.mockReset();
    const { ApiError } = await import("@/lib/api");
    scanFn.mockRejectedValue(new ApiError(400, "invalid_old_path", "oldPath 必须是绝对路径：rel/path"));
    useUiStore.setState({ currentProject: PROJECT, projects: [{ projectPath: PROJECT, preferredModel: null, lastOpenedAt: null }] });

    const { container } = mount(RebindSection);
    typeInto(container.querySelector('[data-testid="rebind-old-path-input"]'), "rel/path");
    await act(async () => {
      click(container.querySelector('[data-testid="rebind-scan-button"]'));
    });
    expect(container.querySelector('[data-testid="rebind-error"]')).toBeTruthy();
    // 命中 errors.invalidOldPath 词典文案（zh 档）
    expect(container.querySelector('[data-testid="rebind-error"]').textContent).toContain("旧目录路径无效");
    // 预览区不出现（未成功扫描）
    expect(container.querySelector('[data-testid="rebind-scan-result"]')).toBeNull();
  });

  test("(f) 空清单：无会话目录提示，无导入钮", async () => {
    scanFn.mockReset();
    scanFn.mockResolvedValue({ project: PROJECT, oldPath: "/data/projects/none", totalFiles: 0, sessions: [] });
    useUiStore.setState({ currentProject: PROJECT, projects: [{ projectPath: PROJECT, preferredModel: null, lastOpenedAt: null }] });

    const { container } = mount(RebindSection);
    typeInto(container.querySelector('[data-testid="rebind-old-path-input"]'), "/data/projects/none");
    await act(async () => {
      click(container.querySelector('[data-testid="rebind-scan-button"]'));
    });
    expect(container.querySelector('[data-testid="rebind-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="rebind-import-button"]')).toBeNull();
  });
});
