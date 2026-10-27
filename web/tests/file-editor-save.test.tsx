// @ts-nocheck
// 任务 9 保存接线单测：PUT /api/fs/file 期望值流与 409 file_changed 冲突 UI。
// 惯例同 file-editor.test.tsx：@happy-dom 全局注册 + createRoot/act 真实点击，
// api 层走 recording fetch；code-mirror-loader 整体 mock（fakeCalls 记录每次
// createEditor 的 doc——重载路径内容替换以「第二次 createEditor 调用」为断言面）。
// 覆盖计划验收：期望值从 GET 捕获并随保存回执滚动；409 冲突弹窗两选
// （重载=重拉内容+期望值+脏态作废；取消=保留本地修改继续编辑）；
// FilesPage 集成：PUT 请求体形状（content/expectedMtimeNs/expectedSize）与
// 冲突弹窗→重载全链。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

// ---- code-mirror-loader mock：同 file-editor.test.tsx ----
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

const { FileEditor } = await import("@/components/files/file-editor");
const { FilesPage } = await import("@/pages/files");
const { FileConflictError } = await import("@/lib/api");
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;
const REAL_MATCH_MEDIA = window.matchMedia.bind(window);
const MOBILE_FILES_QUERY = "(max-width: 768px)";

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !pred(); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!pred()) throw new Error(`timeout: ${what}`);
}

// ---- 编辑器级：期望值捕获 / 滚动 / 冲突弹窗两选 ----
describe("builtin-file-management 任务 9：FileEditor 保存期望值流", () => {
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

  /** GET /api/fs/file 回可变夹具（重载路径改 fileFixture 后重取即回新值） */
  const fileFixture = { box: null as Record<string, unknown> | null };
  function installFileFetch(): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/fs/file")) {
        return okJson(
          fileFixture.box ?? {
            project: "/data/proj-a",
            path: "src/a.ts",
            size: 10,
            mtimeNs: "111",
            truncated: false,
            binary: false,
            content: "hello",
          },
        );
      }
      return okJson({ ok: true });
    }) as typeof fetch;
  }

  async function mountEditor(props: Partial<{ onSave: unknown; dirtyRef: { current: boolean }; onBack: () => void }> = {}) {
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

  function ctrlS(): void {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
  }

  test("期望值从 GET 捕获（mtimeNs+size），保存回执滚动为下轮期望值", async () => {
    installFileFetch();
    fileFixture.box = { project: "/data/proj-a", path: "src/a.ts", size: 10, mtimeNs: "111", truncated: false, binary: false, content: "hello" };
    const onSave = vi.fn(async () => ({ mtimeNs: "222", size: 15 }));
    const { container, root } = await mountEditor({ onSave });
    await waitFor(() => fakeCalls.length > 0, "editor created");
    await act(async () => {
      latestHandle!.type("hello world");
    });
    await act(async () => {
      ctrlS();
    });
    // 首存：期望值 = GET 回传的 mtimeNs/size
    expect(onSave).toHaveBeenCalledWith("hello world", { mtimeNs: "111", size: 10 });
    await waitFor(() => q(container, '[data-testid="file-editor-status"]').getAttribute("data-status") === "saved", "saved");
    // 二存：期望值已滚动为上次回执
    await act(async () => {
      latestHandle!.type("hello world again");
    });
    await act(async () => {
      ctrlS();
    });
    expect(onSave).toHaveBeenLastCalledWith("hello world again", { mtimeNs: "222", size: 15 });
    expect(container.querySelector('[data-testid="file-editor-dirty"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  test("409 冲突弹窗（file_changed）：重载重拉内容与期望值并清脏态", async () => {
    installFileFetch();
    fileFixture.box = { project: "/data/proj-a", path: "src/a.ts", size: 2, mtimeNs: "111", truncated: false, binary: false, content: "v1" };
    const onSave = vi.fn(() =>
      Promise.reject(new FileConflictError("文件已被修改（引擎或其他来源），请重载后再保存", { mtimeNs: "333", size: 9 })),
    );
    const { container, root } = await mountEditor({ onSave });
    await waitFor(() => fakeCalls.length > 0, "editor created");
    await act(async () => {
      latestHandle!.type("local edit");
    });
    await act(async () => {
      ctrlS();
    });
    // 冲突弹窗出现（Radix Portal 挂 document.body，故查 document）：标题/描述含
    // 任务口径文案，状态条失败，脏态保留
    const dialog = document.querySelector('[data-testid="files-save-conflict-dialog"]');
    if (!dialog) throw new Error("missing files-save-conflict-dialog");
    expect(dialog.textContent).toContain("文件已被修改（引擎或其他来源）");
    expect(q(container, '[data-testid="file-editor-status"]').getAttribute("data-status")).toBe("failed");
    expect(container.querySelector('[data-testid="file-editor-dirty"]')).not.toBeNull();
    // 服务端侧并发修改已发生：重载应取回新内容与新期望值
    fileFixture.box = { project: "/data/proj-a", path: "src/a.ts", size: 9, mtimeNs: "333", truncated: false, binary: false, content: "v2-server" };
    await act(async () => {
      (document.querySelector('[data-testid="files-save-conflict-reload"]') as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => fakeCalls.length === 2, "editor recreated on reload");
    expect(fakeCalls[1].doc).toBe("v2-server");
    await waitFor(() => document.querySelector('[data-testid="files-save-conflict-dialog"]') === null, "dialog closed");
    // 重载后：脏态作废；期望值为重载内容的新 mtimeNs/size
    expect(container.querySelector('[data-testid="file-editor-dirty"]')).toBeNull();
    await act(async () => {
      latestHandle!.type("v2-server+");
    });
    await act(async () => {
      ctrlS();
    });
    expect(onSave).toHaveBeenLastCalledWith("v2-server+", { mtimeNs: "333", size: 9 });
    await act(async () => {
      root.unmount();
    });
  });

  test("409 冲突弹窗：取消保留本地内容与脏态（不重拉）", async () => {
    installFileFetch();
    fileFixture.box = { project: "/data/proj-a", path: "src/a.ts", size: 2, mtimeNs: "111", truncated: false, binary: false, content: "v1" };
    const onSave = vi.fn(() =>
      Promise.reject(new FileConflictError("文件已被修改（引擎或其他来源），请重载后再保存", { mtimeNs: "333", size: 9 })),
    );
    const { container, root, dirtyRef } = await mountEditor({ onSave });
    await waitFor(() => fakeCalls.length > 0, "editor created");
    await act(async () => {
      latestHandle!.type("kept locally");
    });
    await act(async () => {
      ctrlS();
    });
    if (!document.querySelector('[data-testid="files-save-conflict-dialog"]')) throw new Error("missing conflict dialog");
    await act(async () => {
      (document.querySelector('[data-testid="files-save-conflict-cancel"]') as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => document.querySelector('[data-testid="files-save-conflict-dialog"]') === null, "dialog closed");
    // 取消：不重拉（仍一次 createEditor）、本地内容与脏态原样保留、状态条失败
    expect(fakeCalls.length).toBe(1);
    expect(latestHandle!.text).toBe("kept locally");
    expect(container.querySelector('[data-testid="file-editor-dirty"]')).not.toBeNull();
    expect(dirtyRef.current).toBe(true);
    expect(q(container, '[data-testid="file-editor-status"]').getAttribute("data-status")).toBe("failed");
    await act(async () => {
      root.unmount();
    });
  });
});

// ---- FilesPage 集成：真实接线（files.tsx 传 fsSaveFile 保存回调） ----
describe("builtin-file-management 任务 9：FilesPage 保存接线", () => {
  beforeEach(() => {
    fakeCalls.length = 0;
    latestHandle = null;
    stubMatchMedia(false);
    vi.stubGlobal("confirm", () => true);
    useUiStore.setState({ filesPageOpen: true, projects: PROJECTS as never, currentProject: "/data/proj-a" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = ORIGINAL_FETCH;
    window.matchMedia = REAL_MATCH_MEDIA;
    document.body.innerHTML = "";
  });

  const PROJECTS = [{ projectPath: "/data/proj-a", preferredModel: null, lastOpenedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-02T00:00:00.000Z" }];

  const TREE_FIXTURE: Record<string, Array<{ name: string; type: string; size: number | null; mtime: number | null }>> = {
    "": [
      { name: "a.ts", type: "file", size: 5, mtime: 1700000000000 },
      { name: "b.txt", type: "file", size: 4, mtime: 1700000000000 },
    ],
  };

  /** PUT 记录：{body} 数组；fileByPath 可变夹具；putImpl 决定 PUT 响应（成功/409） */
  interface PageCalls {
    fileGets: string[];
    puts: Array<Record<string, unknown>>;
    putRespond: (() => Response) | null;
    fileByPath: Record<string, Record<string, unknown>>;
  }

  function installPageFetch(calls: PageCalls): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const qs = new URL(url, "http://localhost").searchParams;
      if (url.includes("/api/projects")) return okJson({ projects: PROJECTS });
      if (url.includes("/api/fs/tree")) {
        const path = (qs.get("path") ?? "").replace(/\/+$/, "");
        return okJson({ project: qs.get("project"), path, entries: TREE_FIXTURE[path] ?? [] });
      }
      if (url.includes("/api/fs/file") && (!init || init.method === undefined || init.method === "GET")) {
        calls.fileGets.push(qs.get("path") ?? "");
        return okJson(calls.fileByPath[qs.get("path") ?? ""] ?? { project: "/data/proj-a", path: "a.ts", size: 5, mtimeNs: "111", truncated: false, binary: false, content: "hello" });
      }
      if (url.includes("/api/fs/file") && init?.method === "PUT") {
        calls.puts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return calls.putRespond ? calls.putRespond() : okJson({ mtimeNs: "222", size: 11 });
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

  async function mountPage(calls: PageCalls) {
    installPageFetch(calls);
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

  async function openEditor(container: HTMLElement, row: string): Promise<void> {
    await act(async () => {
      q(container, `[data-testid="files-row-${row}"]`).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      q(container, '[data-testid="files-edit-button"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => container.querySelector('[data-testid="file-editor"]') !== null, "editor mounted");
    await waitFor(() => fakeCalls.length > 0, "editor created");
  }

  test("Ctrl+S 发起 PUT：query project/path + body {content,expectedMtimeNs,expectedSize}，成功态滚动", async () => {
    const calls: PageCalls = {
      fileGets: [],
      puts: [],
      putRespond: null,
      fileByPath: { "a.ts": { project: "/data/proj-a", path: "a.ts", size: 5, mtimeNs: "111", truncated: false, binary: false, content: "hello" } },
    };
    const { container, root } = await mountPage(calls);
    await openEditor(container, "a.ts");
    await act(async () => {
      latestHandle!.type("hello saved");
    });
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    });
    await waitFor(() => calls.puts.length === 1, "PUT issued");
    expect(calls.puts[0]).toEqual({ content: "hello saved", expectedMtimeNs: "111", expectedSize: 5 });
    await waitFor(() => q(container, '[data-testid="file-editor-status"]').getAttribute("data-status") === "saved", "saved");
    expect(container.querySelector('[data-testid="file-editor-dirty"]')).toBeNull();
    // 二轮保存：期望值已滚动为回执 {mtimeNs:"222", size:11}
    await act(async () => {
      latestHandle!.type("hello saved twice");
    });
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    });
    await waitFor(() => calls.puts.length === 2, "second PUT");
    expect(calls.puts[1]).toEqual({ content: "hello saved twice", expectedMtimeNs: "222", expectedSize: 11 });
    await act(async () => {
      root.unmount();
    });
  });

  test("服务端 409 file_changed → 冲突弹窗 → 重载：GET 重拉、内容替换、脏态清零", async () => {
    const calls: PageCalls = {
      fileGets: [],
      puts: [],
      putRespond: () =>
        new Response(
          JSON.stringify({
            error: { code: "file_changed", message: "文件已被修改（引擎或其他来源），请重载后再保存" },
            mtimeNs: "333",
            size: 8,
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      fileByPath: { "b.txt": { project: "/data/proj-a", path: "b.txt", size: 4, mtimeNs: "111", truncated: false, binary: false, content: "base" } },
    };
    const { container, root } = await mountPage(calls);
    await openEditor(container, "b.txt");
    const getsBefore = calls.fileGets.length;
    await act(async () => {
      latestHandle!.type("local");
    });
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    });
    await waitFor(() => document.querySelector('[data-testid="files-save-conflict-dialog"]') !== null, "conflict dialog");
    expect(calls.puts.length).toBe(1);
    // 冲突已发生：服务端侧内容更新（引擎改写），重载应取回新内容
    calls.fileByPath["b.txt"] = { project: "/data/proj-a", path: "b.txt", size: 8, mtimeNs: "333", truncated: false, binary: false, content: "engine-v2" };
    await act(async () => {
      (document.querySelector('[data-testid="files-save-conflict-reload"]') as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => calls.fileGets.length > getsBefore, "GET re-issued on reload");
    await waitFor(() => fakeCalls.length === 2, "editor recreated");
    expect(fakeCalls[1].doc).toBe("engine-v2");
    await waitFor(() => document.querySelector('[data-testid="files-save-conflict-dialog"]') === null, "dialog closed");
    expect(container.querySelector('[data-testid="file-editor-dirty"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
