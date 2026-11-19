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

// api 桩：fsTree 返回固定条目；listProjects 提供项目表兜底（含第二个项目供 X2 切换）；
// fsFile/gitStatus 供预览层；fsMove 供重命名写操作
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
      listProjects: () => Promise.resolve({ projects: [{ projectPath: "/repo/alpha", name: "alpha" }, { projectPath: "/repo/beta", name: "beta" }] }),
      fsTree: (project: string, path?: string) => {
        apiState.calls.push({ method: "fsTree", args: [project, path] });
        return Promise.resolve({ project, path: path ?? "", entries: apiState.treeEntries });
      },
      fsDownloadUrl: (project: string, path: string) => `/api/fs/download?project=${project}&path=${path}`,
      fsFile: (project: string, path: string) =>
        Promise.resolve({ project, path, size: 5, truncated: false, binary: false, content: "hello" }),
      gitStatus: (project: string) => {
        apiState.calls.push({ method: "gitStatus", args: [project] });
        return Promise.resolve({ project, entries: [] });
      },
      fsMove: (project: string, from: string, to: string) => {
        apiState.calls.push({ method: "fsMove", args: [project, from, to] });
        return Promise.resolve({ ok: true, path: to });
      },
    },
  };
});

// 会话派生项目桩：可控模块变量驱动（X2 用例切换派生项目）；缺省 null = 面板回退项目表首个
let activeProjectMock: string | null = null;
vi.mock("@/stores/sessions", () => ({
  useActiveProject: () => activeProjectMock,
}));

// code-mirror-loader mock（files-ux-revamp 任务 5）：X2 用例进入编辑层，
// happy-dom 不真实加载 CodeMirror
vi.mock("@/components/files/code-mirror-loader", () => ({
  createEditor: async () => ({ destroy: () => {}, getText: () => "" }),
}));

// preview-git-badge 包装 mock：透传真实实现，仅拦截 invalidateGitStatusCache
// 供写操作失效断言（工厂情性执行，引用的模块级数组在首个动态 import 前已初始化）
const gitInvalidateCalls: unknown[][] = [];
vi.mock("@/components/file-tree/preview-git-badge", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    invalidateGitStatusCache: (...args: unknown[]) => {
      gitInvalidateCalls.push(args);
    },
  };
});

// 其余右栏面板桩：本单只验页签注册与文件面板，无关面板不渲染（避免其 api 依赖）
vi.mock("@/components/layout/overview-panel", () => ({ OverviewPanel: () => null }));
vi.mock("@/components/chat/memory-panel", () => ({ MemoryPanel: () => null }));
vi.mock("@/components/chat/stat-panel", () => ({ StatPanel: () => null }));
vi.mock("@/components/chat/subagent-panel", () => ({ SubagentPanel: () => null }));
vi.mock("@/components/chat/todo-panel", () => ({ TodoPanel: () => null }));

const q = (sel: string): Element | null => document.querySelector(sel);
const all = (sel: string): Element[] => Array.from(document.querySelectorAll(sel));
let panelRoot: ReturnType<typeof createRoot> | null = null;

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
  await act(async () => {
    panelRoot = createRoot(container);
    panelRoot.render(createElement(RailFilesPanel, {}));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

/** 以同一次挂载的 root 重渲染（驱动可控 useActiveProject 桩切换派生项目，X2 用例） */
async function rerenderPanel(): Promise<void> {
  const { RailFilesPanel } = await import("@/components/layout/rail-files-panel");
  await act(async () => {
    panelRoot?.render(createElement(RailFilesPanel, {}));
  });
}

/** 受控 input 赋值：React value tracker 会吞同值 input 事件，需走原型 setter */
function typeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 等异步条件成立（预览路径/编辑钮等拉完才渲染的元素） */
async function waitFor(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !pred(); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!pred()) throw new Error(`timeout: ${what}`);
}

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = "";
  apiState.calls = [];
  activeProjectMock = null;
  gitInvalidateCalls.length = 0;
  panelRoot = null;
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
  test("面板挂载：窄栈 list 层渲染工具栏/面包屑/列表，树不在窄档渲染", async () => {
    await renderPanelDirectly();
    const stack = q("[data-testid='rail-files-narrow-stack']");
    expect(stack?.getAttribute("data-level")).toBe("list");
    for (const id of ["rail-files-toolbar-new-file", "rail-files-toolbar-new-dir", "rail-files-toolbar-upload", "rail-files-toolbar-refresh"]) {
      expect(q(`[data-testid='${id}']`)).not.toBeNull();
    }
    expect(q("[data-testid='rail-files-breadcrumb-root']")?.textContent).toBe("alpha");
    // 树不在窄档渲染：无树容器也无树行
    expect(q("[data-testid='rail-files-tree-pane']")).toBeNull();
    expect(stack?.querySelector("[data-testid^='tree-row-']")).toBeNull();
    expect(q("[data-testid='rail-files-row-src']")).not.toBeNull();
    expect(q("[data-testid='rail-files-row-README.md']")).not.toBeNull();
  });

  test("行点击推入 preview 层；返回钮回 list；重按同一行再次推入（openSeq 回归）", async () => {
    await renderPanelDirectly();
    await clickButton("rail-files-row-name-README.md");
    expect(q("[data-testid='rail-files-narrow-stack']")?.getAttribute("data-level")).toBe("preview");
    await waitFor(() => q("[data-testid='preview-path']") !== null, "preview path");
    expect(q("[data-testid='preview-path']")?.textContent).toContain("README.md");
    await clickButton("rail-files-narrow-stack-back");
    expect(q("[data-testid='rail-files-narrow-stack']")?.getAttribute("data-level")).toBe("list");
    // 重按同一行：openSeq 自增换新复合键 => 再次推入（若忘记自增则停在 list，本断言变红）
    await clickButton("rail-files-row-name-README.md");
    expect(q("[data-testid='rail-files-narrow-stack']")?.getAttribute("data-level")).toBe("preview");
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

  test("写操作后失效 git 徽标缓存：重命名成功后 invalidateGitStatusCache 以当前项目调用（files-ux-revamp 任务 5）", async () => {
    await renderPanelDirectly();
    await clickButton("rail-files-rename-README.md");
    const input = q("[data-testid='rail-files-dialog-input']") as HTMLInputElement;
    await act(async () => {
      typeValue(input, "RENAMED.md");
    });
    await clickButton("rail-files-dialog-confirm");
    expect(apiState.calls.some((c) => c.method === "fsMove")).toBe(true);
    // 写操作成功收口里失效当前项目的 git 角标缓存（未接线则空数组，本断言变红）
    expect(gitInvalidateCalls).toContainEqual(["/repo/alpha"]);
  });

  test("X2：编辑中派生项目随会话切换 → 强制清编辑态回 list 并 toast 告知（不可确认）", async () => {
    const { useUiStore } = await import("@/stores/ui");
    const zhFilesMod = await import("@/i18n/zh/files");
    useUiStore.setState({ toasts: [] });
    await renderPanelDirectly();
    // 打开文件进入预览层，再进编辑层
    await clickButton("rail-files-row-name-README.md");
    expect(q("[data-testid='rail-files-narrow-stack']")?.getAttribute("data-level")).toBe("preview");
    await waitFor(() => q("[data-testid='rail-files-edit-button']") !== null, "edit button");
    await clickButton("rail-files-edit-button");
    expect(q("[data-testid='rail-files-narrow-stack']")?.getAttribute("data-level")).toBe("edit");
    // 切会话 → 派生项目切到 /repo/beta：编辑中内容无法迁移，强制清弃并 toast（不弹 confirm）
    activeProjectMock = "/repo/beta";
    await rerenderPanel();
    expect(q("[data-testid='rail-files-narrow-stack']")?.getAttribute("data-level")).toBe("list");
    expect(q("[data-testid='rail-files-narrow-stack-edit']")).toBeNull();
    const zhText = zhFilesMod.files.edit.projectSwitchDiscard;
    expect(useUiStore.getState().toasts.some((tt) => tt.text === zhText)).toBe(true);
    // 新项目根目录已拉取
    expect(apiState.calls.some((c) => c.method === "fsTree" && c.args[0] === "/repo/beta")).toBe(true);
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

  test("回窄 ≤600：回到窄栈堆叠，横向容器 testid 移除，落在当前最深活动层", async () => {
    await renderPanelDirectly();
    await fireResize(700);
    expect(q("[data-testid='rail-files-columns']")).not.toBeNull();
    // 宽档选中文件（预览落在右列）
    await clickButton("rail-files-row-name-README.md");
    await waitFor(() => q("[data-testid='preview-path']") !== null, "preview path");
    await fireResize(400);
    expect(q("[data-testid='rail-files-panel']")?.getAttribute("data-layout")).toBe("stacked");
    expect(q("[data-testid='rail-files-columns']")).toBeNull();
    // 选中未消 → 落在 preview 层；返回钮可回 list
    expect(q("[data-testid='rail-files-narrow-stack']")?.getAttribute("data-level")).toBe("preview");
    await clickButton("rail-files-narrow-stack-back");
    expect(q("[data-testid='rail-files-narrow-stack']")?.getAttribute("data-level")).toBe("list");
  });
});

describe("files-ux-revamp 任务 6：噪音目录切换（rail 工具栏）", () => {
  test("眼睛开关：存在、aria-pressed 翻转、localStorage 记忆重挂载回读", async () => {
    const c1 = await renderPanelDirectly();
    const btn1 = c1.querySelector('[data-testid="rail-files-toggle-hidden"]');
    if (!btn1) throw new Error("missing rail-files-toggle-hidden");
    expect(btn1.getAttribute("aria-pressed")).toBe("false");
    await clickButton("rail-files-toggle-hidden");
    expect(btn1.getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem("ul-omo-webui:files:show-hidden")).toBe("1");
    // 重挂载回读记忆
    window.localStorage.clear();
    window.localStorage.setItem("ul-omo-webui:files:show-hidden", "1");
    const c2 = await renderPanelDirectly();
    const btn2 = c2.querySelector('[data-testid="rail-files-toggle-hidden"]');
    if (!btn2) throw new Error("missing rail-files-toggle-hidden (remount)");
    expect(btn2.getAttribute("aria-pressed")).toBe("true");
  });
});
