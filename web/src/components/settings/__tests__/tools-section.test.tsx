// @ts-nocheck
// r10 todo 17：设置页「工具启停」分区组件测试。
// 环境说明同 rebind-section.test.tsx：@ts-nocheck + 被测模块动态 import + @happy-dom
// 全局注册；交互行为走 createRoot 真实 DOM。
// 验收：(a) 从工具目录枚举渲染逐工具开关；(b) 保存调 patchProjectMeta（excludedTools
// 排序回传）+ 重启提示弹出，确认调 restartProject；(c) 全部关闭出降级提示；(d) 无当前
// 项目 → 提示且无开关。
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

// api 整模块代理 mock：目录/保存/重启三方法可编程；其余方法名缓存同一 vi.fn
const catalogFn = vi.fn();
const patchFn = vi.fn();
const restartFn = vi.fn();
const apiFns = new Map();
vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "listToolCatalog") return catalogFn;
        if (key === "patchProjectMeta") return patchFn;
        if (key === "restartProject") return restartFn;
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
      this.code = this.code ?? code;
    }
  },
}));
vi.mock("@/lib/bootstrap", () => ({ loadProjectModels: vi.fn(() => Promise.resolve({})) }));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ToolsSection } = await import("@/components/settings/tools-section");
const { useUiStore } = await import("@/stores/ui");

const PROJECT = "/tmp/proj";
const CATALOG = {
  tools: [
    { name: "read", builtin: true },
    { name: "bash", builtin: true },
    { name: "edit", builtin: true },
    { name: "write", builtin: true },
    { name: "grep", builtin: true },
  ],
};

function mount(Comp: unknown) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Comp));
  });
  return { container, root };
}

function click(el: Element) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function projectState(excludedTools: string[] | null = null) {
  return {
    currentProject: PROJECT,
    projects: [{ projectPath: PROJECT, preferredModel: null, lastOpenedAt: null, excludedTools }],
  };
}

describe("ToolsSection（r10 todo 17）", () => {
  test("(a) 从工具目录渲染逐工具开关；已禁用项 aria-checked=false", async () => {
    catalogFn.mockReset().mockResolvedValue(CATALOG);
    patchFn.mockReset();
    restartFn.mockReset();
    useUiStore.setState(projectState(["bash"]));
    const { container } = mount(ToolsSection);
    await act(async () => {});
    expect(container.querySelectorAll('[data-testid^="tools-toggle-"]').length).toBe(5);
    expect(container.querySelector('[data-testid="tools-toggle-read"]').getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[data-testid="tools-toggle-bash"]').getAttribute("aria-checked")).toBe("false");
    // 未保存改动前保存钮禁用（脏检查）
    expect((container.querySelector('[data-testid="tools-save-button"]') as HTMLButtonElement).disabled).toBe(true);
  });

  test("(b) 关闭工具保存：调 patchProjectMeta（排序数组）+ 重启提示出现，确认调 restartProject", async () => {
    catalogFn.mockReset().mockResolvedValue(CATALOG);
    patchFn.mockReset().mockResolvedValue({ ok: true, project: null });
    restartFn.mockReset().mockResolvedValue({ ok: true, project: PROJECT });
    useUiStore.setState(projectState(null));
    const { container } = mount(ToolsSection);
    await act(async () => {});
    await act(async () => {
      click(container.querySelector('[data-testid="tools-toggle-write"]'));
      click(container.querySelector('[data-testid="tools-toggle-bash"]'));
    });
    await act(async () => {
      click(container.querySelector('[data-testid="tools-save-button"]'));
    });
    expect(patchFn).toHaveBeenCalledWith({ path: PROJECT, excludedTools: ["bash", "write"] });
    // 保存成功后 flush 异步 setState（setRestartOpen）再断言提示弹出
    await act(async () => {});
    // Dialog 内容经 portal 渲染到 document.body，非 container 子树
    const confirm = document.body.querySelector('[data-testid="tools-restart-confirm"]');
    expect(confirm).toBeTruthy();
    await act(async () => {
      click(confirm);
    });
    expect(restartFn).toHaveBeenCalledWith(PROJECT);
  });

  test("(c) 全部关闭 → 降级提示外显", async () => {
    catalogFn.mockReset().mockResolvedValue(CATALOG);
    patchFn.mockReset();
    restartFn.mockReset();
    useUiStore.setState(projectState(null));
    const { container } = mount(ToolsSection);
    await act(async () => {});
    for (const name of ["read", "bash", "edit", "write", "grep"]) {
      await act(async () => {
        click(container.querySelector(`[data-testid="tools-toggle-${name}"]`));
      });
    }
    expect(container.querySelector('[data-testid="tools-degraded-notice"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="tools-disabled-count"]').textContent).toContain("5");
  });

  test("(d) 无当前项目：提示且无开关列表", async () => {
    catalogFn.mockReset().mockResolvedValue(CATALOG);
    useUiStore.setState({ currentProject: null, projects: [] });
    const { container } = mount(ToolsSection);
    await act(async () => {});
    expect(container.querySelector('[data-testid^="tools-toggle-"]')).toBeNull();
    expect(container.textContent).toContain("未选择项目");
  });
});
