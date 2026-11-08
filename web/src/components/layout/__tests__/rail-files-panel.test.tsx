// 右栏"文件"页签（files-panel-oc 任务 1）：页签注册（TAB_IDS/按钮/标签）+ 面板挂载
// + 基础能力面（列表渲染/新建对话框/删除确认弹窗）。环境同 layout 既有测试：
// happy-dom 全局注册 + 动态 import（保证 mock 晚于 preload 生效）+ api 桩。
import { afterEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");

// api 桩：fsTree 返回固定条目；listProjects 提供项目表兜底
const apiState = {
  treeEntries: [
    { name: "src", type: "directory" },
    { name: "README.md", type: "file" },
  ],
  calls: [] as { method: string; args: unknown[] }[],
};

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  class FsUploadConflictError extends ApiError {
    existing: unknown;
    constructor(message: string, existing: unknown) {
      super(409, "target_exists", message);
      this.existing = existing;
    }
  }
  return {
    ApiError,
    FsUploadConflictError,
    api: {
      listProjects: () => Promise.resolve({ projects: [{ projectPath: "/repo/alpha", name: "alpha" }] }),
      fsTree: (project: string, path?: string) => {
        apiState.calls.push({ method: "fsTree", args: [project, path] });
        return Promise.resolve({ project, path: path ?? "", entries: apiState.treeEntries });
      },
      fsDownloadUrl: (project: string, path: string) => `/api/fs/download?project=${project}&path=${path}`,
    },
  };
});

// 会话派生项目桩：无选中会话 → null（面板回退项目表首个）
vi.mock("@/stores/sessions", () => ({
  useActiveProject: () => null,
}));

// 其余右栏面板桩：本单只验页签注册与文件面板，无关面板不渲染（避免其 api 依赖）
vi.mock("@/components/layout/overview-panel", () => ({ OverviewPanel: () => null }));
vi.mock("@/components/chat/memory-panel", () => ({ MemoryPanel: () => null }));
vi.mock("@/components/chat/stat-panel", () => ({ StatPanel: () => null }));
vi.mock("@/components/chat/subagent-panel", () => ({ SubagentPanel: () => null }));
vi.mock("@/components/chat/todo-panel", () => ({ TodoPanel: () => null }));

const q = (sel: string): Element | null => document.querySelector(sel);
const all = (sel: string): Element[] => Array.from(document.querySelectorAll(sel));

async function clickButton(testid: string): Promise<void> {
  const btn = q(`[data-testid="${testid}"]`);
  if (!btn) throw new Error(`missing button: ${testid}`);
  await act(async () => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderPanelDirectly(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const { RailFilesPanel } = await import("@/components/layout/rail-files-panel");
  let root: ReturnType<typeof createRoot> | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(RailFilesPanel, {}));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = "";
  apiState.calls = [];
  vi.resetModules();
});

describe("right rail files tab", () => {
  test("页签注册：文件页签钮存在且位于笔记之后统计之前", async () => {
    window.localStorage.setItem("ul-omo-webui:right-rail-tab", "files");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { RightRail } = await import("@/components/layout/right-rail");
    await act(async () => {
      const root = createRoot(container);
      root.render(createElement(RightRail, { open: true, onToggle: () => {}, sessionId: null }));
    });
    const tabIds = all("[data-testid='right-rail'] [role='tab']").map((el) => el.getAttribute("data-testid"));
    expect(tabIds).toEqual([
      "right-rail-tab-overview",
      "right-rail-tab-todo",
      "right-rail-tab-changes",
      "right-rail-tab-notes",
      "right-rail-tab-files",
      "right-rail-tab-stats",
      "right-rail-tab-memory",
      "right-rail-tab-agents",
    ]);
    const filesTab = q("[data-testid='right-rail-tab-files']");
    expect(filesTab?.textContent).toBe("文件");
  });

  test("点击文件页签后挂载 rail-files-panel 并拉取目录列表", async () => {
    window.localStorage.setItem("ul-omo-webui:right-rail-tab", "overview");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { RightRail } = await import("@/components/layout/right-rail");
    await act(async () => {
      const root = createRoot(container);
      root.render(createElement(RightRail, { open: true, onToggle: () => {}, sessionId: null }));
    });
    await clickButton("right-rail-tab-files");
    expect(q("[data-testid='rail-files-panel']")).not.toBeNull();
    expect(apiState.calls.some((c) => c.method === "fsTree")).toBe(true);
    expect(apiState.calls[0]?.args[0]).toBe("/repo/alpha");
  });
});

describe("rail files panel", () => {
  test("面板挂载：工具栏/面包屑/树与列表渲染", async () => {
    await renderPanelDirectly();
    expect(q("[data-testid='rail-files-panel']")).not.toBeNull();
    for (const id of ["rail-files-toolbar-new-file", "rail-files-toolbar-new-dir", "rail-files-toolbar-upload", "rail-files-toolbar-refresh"]) {
      expect(q(`[data-testid='${id}']`)).not.toBeNull();
    }
    expect(q("[data-testid='rail-files-breadcrumb-root']")?.textContent).toBe("alpha");
    expect(q("[data-testid='rail-files-tree-pane']")).not.toBeNull();
    expect(q("[data-testid='rail-files-row-src']")).not.toBeNull();
    expect(q("[data-testid='rail-files-row-README.md']")).not.toBeNull();
    expect(q("[data-testid='rail-files-preview-pane']")?.textContent).toContain("选择文件以预览");
  });

  test("新建文件：工具栏按钮打开对话框", async () => {
    await renderPanelDirectly();
    await clickButton("rail-files-toolbar-new-file");
    expect(q("[data-testid='rail-files-dialog']")).not.toBeNull();
    expect(q("[data-testid='rail-files-dialog-input']")).not.toBeNull();
  });

  test("删除：行内删除钮打开确认弹窗", async () => {
    await renderPanelDirectly();
    await clickButton("rail-files-delete-README.md");
    expect(q("[data-testid='files-delete-dialog']")).not.toBeNull();
  });

  test("重命名：行内重命名钮打开移动/重命名对话框并预填当前路径", async () => {
    await renderPanelDirectly();
    await clickButton("rail-files-rename-README.md");
    const input = q("[data-testid='rail-files-dialog-input']") as HTMLInputElement | null;
    expect(input?.value).toBe("README.md");
  });
});
