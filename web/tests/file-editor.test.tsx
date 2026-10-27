// @ts-nocheck
// CodeMirror 在线编辑组件单测（builtin-file-management 任务 8）。惯例同
// files-page.test.tsx：@happy-dom 全局注册 + createRoot/act 真实点击；api 层走
// recording fetch。code-mirror-loader 整体 mock（happy-dom 不真实加载 CodeMirror
// 本体与语言包，计划口径：语言包动态 import 在 DOM 测试中 mock 规避重载）。
// 覆盖计划验收：资格三条件判定与置灰原因、脏态切走确认、Ctrl+S 保存回调触发、
// 状态条 saving/saved/failed/unavailable 四态。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

// ---- code-mirror-loader mock：假编辑器句柄，type() 模拟输入并触发 onDocChanged ----
interface FakeCall {
  host: HTMLElement;
  doc: string;
  path: string;
}

const fakeCalls: FakeCall[] = [];
let latestHandle: {
  destroyed: boolean;
  text: string;
  onDocChanged: () => void;
  type(text: string): void;
} | null = null;

vi.mock("@/components/files/code-mirror-loader", () => ({
  createEditor: async (host: HTMLElement, doc: string, path: string, onDocChanged: () => void) => {
    fakeCalls.push({ host, doc, path });
    const handle = {
      destroyed: false,
      text: doc,
      onDocChanged,
      type(text: string) {
        this.text = text;
        this.onDocChanged();
      },
    };
    latestHandle = handle;
    return {
      destroy: () => {
        handle.destroyed = true;
      },
      getText: () => handle.text,
    };
  },
}));

const { FileEditor, editBlockReasonKey, isEditableFile, FILE_EDIT_MAX_BYTES } = await import("@/components/files/file-editor");
const { FilesPage } = await import("@/pages/files");
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;
const REAL_MATCH_MEDIA = window.matchMedia.bind(window);
const MOBILE_FILES_QUERY = "(max-width: 768px)";
// happy-dom 无 window.confirm：组件与 files.tsx 守卫均走全局 confirm，测试以 vi.stubGlobal 注入

function fileData(overrides: Partial<{ size: number; truncated: boolean; binary: boolean; content: string | null }> = {}) {
  return { size: 10, truncated: false, binary: false, content: "hello", project: "/data/proj-a", path: "a.ts", ...overrides };
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/** 等 createEditor 被调（编辑器动态加载为异步续体） */
async function waitFor(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !pred(); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!pred()) throw new Error(`timeout: ${what}`);
}

describe("builtin-file-management 任务 8：编辑资格三条件", () => {
  test("size≤2MB 且未截断且非二进制才可编辑；三个不满足条件各自给原因键", () => {
    expect(FILE_EDIT_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(isEditableFile(fileData())).toBe(true);
    // 恰好 2MB 合格；超一字节不合格
    expect(isEditableFile(fileData({ size: 2 * 1024 * 1024 }))).toBe(true);
    expect(isEditableFile(fileData({ size: 2 * 1024 * 1024 + 1 }))).toBe(false);
    expect(isEditableFile(fileData({ truncated: true }))).toBe(false);
    expect(isEditableFile(fileData({ binary: true }))).toBe(false);
    // 原因键：binary 优先（二进制时 size/truncated 不构成真实障碍）
    expect(editBlockReasonKey(fileData({ binary: true }))).toBe("files.edit.reasonBinary");
    expect(editBlockReasonKey(fileData({ truncated: true }))).toBe("files.edit.reasonTruncated");
    expect(editBlockReasonKey(fileData({ size: 3 * 1024 * 1024 }))).toBe("files.edit.reasonTooLarge");
  });
});

describe("builtin-file-management 任务 8：FileEditor 组件", () => {
  beforeEach(() => {
    fakeCalls.length = 0;
    latestHandle = null;
    vi.stubGlobal("confirm", () => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = ORIGINAL_FETCH;
    document.body.innerHTML = "";
  });

  interface EditorCalls {
    filePayload?: Record<string, unknown>;
    failFile?: boolean;
  }

  function installFetch(calls: EditorCalls): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/fs/file")) {
        if (calls.failFile) {
          return new Response(JSON.stringify({ error: { code: "internal", message: "boom" } }), { status: 500 });
        }
        return okJson(calls.filePayload ?? fileData());
      }
      return okJson({ ok: true });
    }) as typeof fetch;
  }

  async function mountEditor(props: Partial<{ onSave: ((content: string) => Promise<void>) | null; dirtyRef: { current: boolean }; onBack: () => void }> = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const dirtyRef = props.dirtyRef ?? { current: false };
    await act(async () => {
      root.render(
        createElement(FileEditor, {
          project: "/data/proj-a",
          path: "src/a.ts",
          dirtyRef,
          onBack: props.onBack ?? (() => {}),
          onSave: "onSave" in props ? props.onSave : null,
        }),
      );
    });
    return { container, root, dirtyRef };
  }

  function q(container: HTMLElement, sel: string): HTMLElement {
    const el = container.querySelector(sel);
    if (!el) throw new Error(`missing ${sel}`);
    return el as HTMLElement;
  }

  test("内容就绪后动态创建编辑器，path 传入语言包加载；输入置脏（dirtyRef+标记）", async () => {
    installFetch({});
    const { container, root, dirtyRef } = await mountEditor();
    await waitFor(() => fakeCalls.length > 0, "editor created");
    expect(fakeCalls[0]).toMatchObject({ doc: "hello", path: "src/a.ts" });
    expect(dirtyRef.current).toBe(false);
    await act(async () => {
      latestHandle!.type("hello world");
    });
    expect(dirtyRef.current).toBe(true);
    expect(container.querySelector('[data-testid="file-editor-dirty"]')).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
    expect(latestHandle!.destroyed).toBe(true);
  });

  test("Ctrl+S 触发保存回调并显示已保存；无保存回调显示「保存不可用」", async () => {
    installFetch({});
    const onSave = vi.fn(async () => {});
    const { container, root } = await mountEditor({ onSave });
    await waitFor(() => latestHandle !== null, "editor created");
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledWith("hello");
    await waitFor(() => container.querySelector('[data-testid="file-editor-status"]')?.getAttribute("data-status") === "saved", "saved status");
    // 保存成功后脏态清零
    expect(container.querySelector('[data-testid="file-editor-dirty"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });

    // 无保存回调（任务 9 前形态）：Ctrl+S 不发起，状态条 unavailable
    fakeCalls.length = 0;
    latestHandle = null;
    const second = await mountEditor({ onSave: null });
    await waitFor(() => latestHandle !== null, "editor created 2");
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    });
    expect(q(second.container, '[data-testid="file-editor-status"]').getAttribute("data-status")).toBe("unavailable");
    expect(q(second.container, '[data-testid="file-editor-status"]').textContent).toContain("保存不可用");
    await act(async () => {
      second.root.unmount();
    });
  });

  test("保存回调拒绝显示失败态；保存中显示保存中", async () => {
    installFetch({});
    let rejectSave: ((err: unknown) => void) | null = null;
    const onSave = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const { container, root } = await mountEditor({ onSave });
    await waitFor(() => latestHandle !== null, "editor created");
    await act(async () => {
      q(container, '[data-testid="file-editor-save"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="file-editor-status"]').getAttribute("data-status")).toBe("saving");
    await act(async () => {
      rejectSave!(new Error("no endpoint"));
    });
    expect(q(container, '[data-testid="file-editor-status"]').getAttribute("data-status")).toBe("failed");
    await act(async () => {
      root.unmount();
    });
  });

  test("脏态返回钮弹确认：取消停留、确认返回；非脏直接返回", async () => {
    installFetch({});
    let confirmCalls = 0;
    vi.stubGlobal("confirm", () => {
      confirmCalls += 1;
      return false;
    });
    let backs = 0;
    const { container, root, dirtyRef } = await mountEditor({ onBack: () => (backs += 1) });
    await waitFor(() => latestHandle !== null, "editor created");
    // 非脏：直接返回不弹确认
    await act(async () => {
      q(container, '[data-testid="file-editor-back"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(backs).toBe(1);
    expect(confirmCalls).toBe(0);
    // 脏 + 确认取消：停留原地
    await act(async () => {
      latestHandle!.type("changed");
    });
    await act(async () => {
      q(container, '[data-testid="file-editor-back"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(backs).toBe(1);
    expect(confirmCalls).toBe(1);
    // 脏 + 确认放行：返回
    vi.stubGlobal("confirm", () => true);
    await act(async () => {
      q(container, '[data-testid="file-editor-back"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(backs).toBe(2);
    expect(dirtyRef.current).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });

  test("资格失效兜底：编辑器内对二进制/截断/超限文件渲染不可编辑占位", async () => {
    installFetch({ filePayload: fileData({ binary: true, content: null }) });
    const { container, root } = await mountEditor();
    await waitFor(() => container.querySelector('[data-testid="file-editor-ineligible"]') !== null, "ineligible placeholder");
    expect(fakeCalls.length).toBe(0);
    await act(async () => {
      root.unmount();
    });
  });

  test("内容加载失败渲染错误态不崩溃", async () => {
    installFetch({ failFile: true });
    const { container, root } = await mountEditor();
    await waitFor(() => container.querySelector('[data-testid="file-editor-error"]') !== null, "error state");
    await act(async () => {
      root.unmount();
    });
  });
});

// ---- FilesPage 集成：预览面板编辑钮与编辑区挂载（任务 8 独占区域） ----
describe("builtin-file-management 任务 8：预览面板编辑入口集成", () => {
  beforeEach(() => {
    stubMatchMedia(false);
    useUiStore.setState({ filesPageOpen: true, projects: PROJECTS as never, currentProject: "/data/proj-a" });
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    window.matchMedia = REAL_MATCH_MEDIA;
    document.body.innerHTML = "";
  });

  function project(path: string, lastOpenedAt: string): Record<string, unknown> {
    return { projectPath: path, preferredModel: null, lastOpenedAt, createdAt: lastOpenedAt };
  }

  const PROJECTS = [project("/data/proj-a", "2026-01-02T00:00:00.000Z")];

  const TREE_FIXTURE: Record<string, Array<{ name: string; type: string; size: number | null; mtime: number | null }>> = {
    "": [
      { name: "a.ts", type: "file", size: 5, mtime: 1700000000000 },
      { name: "huge.ts", type: "file", size: 3 * 1024 * 1024, mtime: 1700000000000 },
      { name: "blob.bin", type: "file", size: 4, mtime: 1700000000000 },
    ],
  };

  /** /api/fs/file 按 path 回不同资格样本（huge 超限、blob 二进制） */
  function installPageFetch(fileByPath: Record<string, Record<string, unknown>>): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/projects")) return okJson({ projects: PROJECTS });
      if (url.includes("/api/fs/tree")) {
        const qs = new URL(url, "http://localhost").searchParams;
        const path = (qs.get("path") ?? "").replace(/\/+$/, "");
        return okJson({ project: qs.get("project"), path, entries: TREE_FIXTURE[path] ?? [] });
      }
      if (url.includes("/api/fs/file")) {
        const qs = new URL(url, "http://localhost").searchParams;
        return okJson(fileByPath[qs.get("path") ?? ""] ?? fileData());
      }
      return okJson({ ok: true });
    }) as typeof fetch;
  }

  function stubMatchMedia(matches768: boolean): void {
    window.matchMedia = ((query: string) =>
      ({
        matches: matches768 && query === MOBILE_FILES_QUERY,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
  }

  async function mountPage(fileByPath: Record<string, Record<string, unknown>>) {
    installPageFetch(fileByPath);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(FilesPage));
    });
    return { container, root };
  }

  function q(container: HTMLElement, sel: string): HTMLElement {
    const el = container.querySelector(sel);
    if (!el) throw new Error(`missing ${sel}`);
    return el as HTMLElement;
  }

  test("合格文件点编辑进入编辑器；超限/二进制文件编辑钮置灰带原因提示", async () => {
    const { container, root } = await mountPage({
      "huge.ts": fileData({ size: 3 * 1024 * 1024, content: "x".repeat(8) }),
      "blob.bin": fileData({ binary: true, content: null }),
    });
    // 打开合格文件 a.ts → 编辑钮可点 → 编辑器挂载
    await act(async () => {
      q(container, '[data-testid="files-row-a.ts"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const editBtn = q(container, '[data-testid="files-edit-button"]');
    expect(editBtn.getAttribute("data-ineligible")).toBeNull();
    await act(async () => {
      editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => container.querySelector('[data-testid="file-editor"]') !== null, "editor mounted");
    expect(container.querySelector('[data-testid="file-preview"]')).toBeNull();
    // 返回预览（非脏直接返回）
    await act(async () => {
      q(container, '[data-testid="file-editor-back"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="file-preview"]')).not.toBeNull();
    await act(async () => {
      root.unmount();
    });

    // 超限样本：编辑钮置灰，title/aria 带原因
    fakeCalls.length = 0;
    latestHandle = null;
    const second = await mountPage({
      "huge.ts": fileData({ size: 3 * 1024 * 1024 }),
      "blob.bin": fileData({ binary: true, content: null }),
    });
    await act(async () => {
      q(second.container, '[data-testid="files-row-huge.ts"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => second.container.querySelector('[data-testid="files-edit-button"]') !== null, "edit button");
    const disabledBtn = q(second.container, '[data-testid="files-edit-button"]') as HTMLButtonElement;
    expect(disabledBtn.disabled).toBe(true);
    expect(disabledBtn.getAttribute("data-ineligible")).toBe("true");
    expect(disabledBtn.getAttribute("title")).toContain("2MB");
    // 二进制样本：原因切换为二进制文案
    await act(async () => {
      q(second.container, '[data-testid="files-row-blob.bin"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(
      () => q(second.container, '[data-testid="files-edit-button"]').getAttribute("title")?.includes("二进制") === true,
      "binary reason",
    );
    await act(async () => {
      second.root.unmount();
    });
  });

  test("编辑中切其他文件/关页弹确认：取消停留编辑，确认放行", async () => {
    vi.stubGlobal("confirm", () => false);
    const { container, root } = await mountPage({});
    await act(async () => {
      q(container, '[data-testid="files-row-a.ts"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      q(container, '[data-testid="files-edit-button"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => container.querySelector('[data-testid="file-editor"]') !== null, "editor mounted");
    // 输入置脏
    await act(async () => {
      latestHandle!.type("dirty content");
    });
    // 切其他文件：确认取消 → 停留编辑器
    await act(async () => {
      q(container, '[data-testid="files-row-huge.ts"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="file-editor"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="file-preview"]')).toBeNull();
    // 关页：确认取消 → 页面不关
    await act(async () => {
      q(container, '[data-testid="files-page-close"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="files-page"]')).not.toBeNull();
    // 放行确认：切文件成功退出编辑
    vi.stubGlobal("confirm", () => true);
    await act(async () => {
      q(container, '[data-testid="files-row-huge.ts"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="file-editor"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
