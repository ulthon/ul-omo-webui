// 右栏"文件"页签（files-panel-oc 任务 1）：页签注册（TAB_IDS/按钮/标签）+ 面板挂载
// + 基础能力面（列表渲染/新建对话框/删除确认弹窗）。环境同 layout 既有测试：
// happy-dom 全局注册 + 动态 import（保证 mock 晚于 preload 生效）+ api 桩。
import { afterEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ResizeObserver 桩（#36 响应式测试）：happy-dom 不自动触发，装可控桩——挂载时记录
// 回调，测试用 fireResize 直发容器宽（contentRect）。未 fire 时宽为 0（窄档），
// 既有窄栏用例不受影响。
type RoEntry = { contentRect: { width: number } };
type RoCallback = (entries: RoEntry[]) => void;
const roInstances: { cb: RoCallback }[] = [];
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  cb: RoCallback;
  constructor(cb: RoCallback) {
    this.cb = cb;
    roInstances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
async function fireResize(width: number): Promise<void> {
  const ro = roInstances[roInstances.length - 1];
  if (!ro) throw new Error("no ResizeObserver registered");
  await act(async () => {
    ro.cb([{ contentRect: { width } }]);
    await Promise.resolve();
  });
}

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

describe("rail files panel responsive layout (#36)", () => {
  test("纯函数：宽度档与拖宽钳制计算", async () => {
    const { filesRailLayout } = await import("@/components/layout/rail-files-panel");
    const { clampRailWidth, railWidthMax } = await import("@/components/layout/rail-resize");
    expect(filesRailLayout(0)).toBe("stacked");
    expect(filesRailLayout(600)).toBe("stacked");
    expect(filesRailLayout(601)).toBe("split");
    expect(filesRailLayout(899)).toBe("split");
    expect(filesRailLayout(900)).toBe("columns");
    // 上限 = min(视口 70%, 1400, 视口-360)，下限 320 兜底
    expect(railWidthMax(1024)).toBe(664);
    expect(railWidthMax(1920)).toBe(1344);
    expect(railWidthMax(2400)).toBe(1400);
    expect(clampRailWidth(800, 1024)).toBe(664);
    expect(clampRailWidth(100, 1920)).toBe(320);
    expect(clampRailWidth(384.4, 1920)).toBe(384);
    expect(clampRailWidth(9999, 1920)).toBe(1344);
  });

  test("宽容器 601-899：切横向两栏（新 testid rail-files-columns），原有结构 testid 保留", async () => {
    await renderPanelDirectly();
    await fireResize(700);
    const panel = q("[data-testid='rail-files-panel']");
    expect(panel?.getAttribute("data-layout")).toBe("split");
    expect(q("[data-testid='rail-files-columns']")).not.toBeNull();
    // 窄档结构 testid 全保留
    for (const id of ["rail-files-tree-pane", "rail-files-list-pane", "rail-files-preview-pane", "rail-files-row-src", "rail-files-row-README.md"]) {
      expect(q(`[data-testid='${id}']`)).not.toBeNull();
    }
    // 树列默认宽（14rem = 224px，inline style，可拖拽记忆）
    expect((q("[data-testid='rail-files-tree-pane']") as HTMLElement | null)?.style.width).toBe("224px");
  });

  test("宽容器 ≥900：三列横排，列表列带右边框分隔", async () => {
    await renderPanelDirectly();
    await fireResize(950);
    const panel = q("[data-testid='rail-files-panel']");
    expect(panel?.getAttribute("data-layout")).toBe("columns");
    expect(q("[data-testid='rail-files-columns']")).not.toBeNull();
    expect(q("[data-testid='rail-files-list-pane']")?.className).toContain("border-r");
  });

  test("横向档手柄存在性：split 仅树手柄，columns 双手柄，stacked 无手柄", async () => {
    await renderPanelDirectly();
    await fireResize(700);
    expect(q("[data-testid='rail-files-resize-handle-tree']")).not.toBeNull();
    expect(q("[data-testid='rail-files-resize-handle-list']")).toBeNull();
    await fireResize(950);
    expect(q("[data-testid='rail-files-resize-handle-tree']")).not.toBeNull();
    expect(q("[data-testid='rail-files-resize-handle-list']")).not.toBeNull();
    // 三列档：列表列默认 20rem（320px，inline style），预览列自适应
    expect((q("[data-testid='rail-files-list-pane']") as HTMLElement | null)?.style.width).toBe("320px");
    await fireResize(400);
    expect(q("[data-testid='rail-files-resize-handle-tree']")).toBeNull();
    expect(q("[data-testid='rail-files-resize-handle-list']")).toBeNull();
  });

  test("手柄记忆：越界记录读回归默认（默认档不受污染）", async () => {
    const { RAIL_FILES_TREE_KEY, RAIL_FILES_TREE_DEFAULT } = await import("@/components/layout/rail-files-resize");
    window.localStorage.setItem(RAIL_FILES_TREE_KEY, "9999");
    const { readRailFilesTreeWidthPreference } = await import("@/components/layout/rail-files-resize");
    expect(readRailFilesTreeWidthPreference()).toBe(RAIL_FILES_TREE_DEFAULT);
  });

  test("回窄 ≤600：回到纵向堆叠，横向容器 testid 移除", async () => {
    await renderPanelDirectly();
    await fireResize(700);
    expect(q("[data-testid='rail-files-columns']")).not.toBeNull();
    await fireResize(400);
    expect(q("[data-testid='rail-files-panel']")?.getAttribute("data-layout")).toBe("stacked");
    expect(q("[data-testid='rail-files-columns']")).toBeNull();
    expect(q("[data-testid='rail-files-preview-pane']")?.className).toContain("border-t");
  });
});
