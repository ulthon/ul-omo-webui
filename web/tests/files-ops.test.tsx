// @ts-nocheck
// 文件管理页操作面单测（builtin-file-management 任务 6）。惯例同 files-page.test.tsx：
// @happy-dom 全局注册 + createRoot/act 真实点击，api 层走 recording fetch/XHR。
// 覆盖计划验收：工具栏渲染；列表/树右键菜单项（目录多"在此上传"）；上传进度回调触发
// 与队列结果态；操作成功后重取当前目录与树（recording 断言）；409/403 失败 toast。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FilesPage } = await import("@/pages/files");
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_XHR = globalThis.XMLHttpRequest;

const PROJECTS = [
  { projectPath: "/data/proj-a", preferredModel: null, lastOpenedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-02T00:00:00.000Z" },
];

const TREE_FIXTURE: Record<string, Array<{ name: string; type: string; size: number | null; mtime: number | null }>> = {
  "": [
    { name: "docs", type: "directory", size: null, mtime: 1700000000000 },
    { name: "alpha.txt", type: "file", size: 10, mtime: 1700000000000 },
  ],
};

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function errJson(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } });
}

interface Calls {
  tree: string[];
  move: Array<{ from: string; to: string }>;
  del: string[];
  createFile: string[];
  createDir: string[];
  fail: { deleteCode?: string; createFileStatus?: number; createFileCode?: string };
}

function installFetch(calls: Calls): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/projects")) return okJson({ projects: PROJECTS });
    if (url.includes("/api/fs/tree")) {
      const qs = new URL(url, "http://localhost").searchParams;
      calls.tree.push(qs.get("path") ?? "");
      return okJson({ project: qs.get("project"), path: qs.get("path") ?? "", entries: TREE_FIXTURE[(qs.get("path") ?? "").replace(/\/+$/, "")] ?? [] });
    }
    if (url.includes("/api/fs/file") && init?.method === "POST") {
      const body = JSON.parse(String(init.body) || "{}") as { path: string };
      calls.createFile.push(body.path);
      if (calls.fail.createFileStatus) {
        return errJson(calls.fail.createFileStatus, calls.fail.createFileCode ?? "path_escape", "写入后回查出界");
      }
      return new Response(JSON.stringify({ path: body.path, size: 0, mtimeNs: "0" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/fs/dir")) {
      const body = JSON.parse(String(init.body) || "{}") as { path: string };
      calls.createDir.push(body.path);
      return new Response(JSON.stringify({ path: body.path }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/fs/entry") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body) || "{}") as { from: string; to: string };
      calls.move.push({ from: body.from, to: body.to });
      return okJson({ ok: true, path: body.to });
    }
    if (url.includes("/api/fs/entry") && init?.method === "DELETE") {
      const qs = new URL(url, "http://localhost").searchParams;
      calls.del.push(qs.get("path") ?? "");
      if (calls.fail.deleteCode) return errJson(409, calls.fail.deleteCode, "引擎正在此项目工作，稍后再试");
      return okJson({ ok: true });
    }
    return okJson({ ok: true });
  }) as typeof fetch;
}

/** 可编程假 XHR（fsUpload 走 XHR 取上传进度）：send 时先触发 onprogress，再按配置回状态 */
class FakeXHR {
  status = 0;
  responseText = "";
  upload: Record<string, never> = {};
  onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null = null;
  onload: () => void = () => {};
  onerror: () => void = () => {};
  method = "";
  url = "";
  body: unknown = null;
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(): void {}
  send(body: unknown): void {
    this.body = body;
    (this.upload as { onprogress?: (e: unknown) => void }).onprogress?.({ lengthComputable: true, loaded: 60, total: 100 });
    const conflict = this.url.includes("overwrite=false-conflict") || (this.url.includes("/api/fs/upload") && uploadConflictNext);
    this.status = conflict ? 409 : 201;
    this.responseText = conflict
      ? JSON.stringify({
          error: { code: "target_exists", message: "目标已存在" },
          existing: { path: "/data/proj-a/alpha.txt", kind: "file", size: 1, mtimeNs: "0" },
        })
      : JSON.stringify({ path: "/data/proj-a/x", bytes: 100, mtimeNs: "0" });
    this.onload();
  }
}

let uploadConflictNext = false;
let fakeXhrLog: FakeXHR[] = [];

function stubXHR(): void {
  fakeXhrLog = [];
  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = class extends FakeXHR {
    constructor() {
      super();
      fakeXhrLog.push(this);
    }
  };
}

beforeEach(() => {
  useUiStore.setState({ filesPageOpen: true, projects: PROJECTS as never, currentProject: "/data/proj-a" });
  uploadConflictNext = false;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = ORIGINAL_XHR;
  document.body.innerHTML = "";
});

async function mountPage(calls: Calls) {
  installFetch(calls);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(FilesPage));
  });
  return { container, root };
}

function q(container: HTMLElement | Document, sel: string): HTMLElement {
  const el = container.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as HTMLElement;
}

function contextmenu(el: Element): MouseEvent {
  return new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 });
}

function toastTexts(): string[] {
  return useUiStore.getState().toasts.map((t) => t.text);
}

/** 受控 input 赋值：React value tracker 会吞同值 input 事件，需走原型 setter */
function typeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("builtin-file-management 任务 6：文件操作面", () => {
  test("工具栏渲染四个操作钮（新建文件/新建目录/上传/刷新）与隐藏多选文件 input", async () => {
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: {} };
    const { container, root } = await mountPage(calls);
    for (const id of ["files-toolbar-new-file", "files-toolbar-new-dir", "files-toolbar-upload", "files-toolbar-refresh"]) {
      expect(q(container, `[data-testid="${id}"]`)).not.toBeNull();
    }
    const input = q(container, '[data-testid="files-upload-input"]') as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.multiple).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });

  test("列表行右键菜单：文件为下载/重命名/移动/删除；目录加在此上传", async () => {
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: {} };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="files-row-alpha.txt"]').dispatchEvent(contextmenu(null));
    });
    const menu = q(document, '[data-testid="files-context-menu"]');
    for (const id of ["files-menu-download", "files-menu-rename", "files-menu-move", "files-menu-delete"]) {
      expect(menu.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    expect(menu.querySelector('[data-testid="files-menu-upload-here"]')).toBeNull();
    // 关闭后对目录行开菜单：多出"在此上传"，无下载
    await act(async () => {
      q(document, '[data-testid="files-menu-overlay"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      q(container, '[data-testid="files-row-docs"]').dispatchEvent(contextmenu(null));
    });
    const menu2 = q(document, '[data-testid="files-context-menu"]');
    expect(menu2.querySelector('[data-testid="files-menu-upload-here"]')).not.toBeNull();
    expect(menu2.querySelector('[data-testid="files-menu-download"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  test("树行右键菜单可用（aria-expanded 判目录）；目录项含在此上传", async () => {
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: {} };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="tree-row-docs"]').dispatchEvent(contextmenu(null));
    });
    const menu = q(document, '[data-testid="files-context-menu"]');
    expect(menu.querySelector('[data-testid="files-menu-upload-here"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="files-menu-rename"]')).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  test("重命名对话框：预填原名、提交 PATCH fsMove、成功后重取当前目录（不乐观更新）", async () => {
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: {} };
    const { container, root } = await mountPage(calls);
    const treeCallsBefore = calls.tree.length;
    await act(async () => {
      q(container, '[data-testid="files-row-alpha.txt"]').dispatchEvent(contextmenu(null));
    });
    await act(async () => {
      q(document, '[data-testid="files-menu-rename"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = q(document, '[data-testid="files-dialog-input"]') as HTMLInputElement;
    expect(input.value).toBe("alpha.txt");
    await act(async () => {
      typeValue(input, "gamma.txt");
    });
    await act(async () => {
      q(document, '[data-testid="files-dialog-confirm"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(calls.move).toEqual([{ from: "alpha.txt", to: "gamma.txt" }]);
    // 成功后重取当前目录：列表重拉 + FileTree 重挂载自拉，均同路径
    expect(calls.tree.length).toBe(treeCallsBefore + 2);
    expect(calls.tree.at(-1)).toBe("");
    await act(async () => {
      root.unmount();
    });
  });

  test("新建文件对话框：拼接当前目录相对路径提交 POST /api/fs/file 并重取", async () => {
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: {} };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="files-toolbar-new-file"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = q(document, '[data-testid="files-dialog-input"]') as HTMLInputElement;
    await act(async () => {
      typeValue(input, "docs/new.txt");
    });
    await act(async () => {
      q(document, '[data-testid="files-dialog-confirm"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(calls.createFile).toEqual(["docs/new.txt"]);
    expect(calls.tree.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      root.unmount();
    });
  });

  test("上传：多选逐个排队，进度回调触发并写入进度条，完成后重取目录", async () => {
    stubXHR();
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: {} };
    const { container, root } = await mountPage(calls);
    const treeCallsBefore = calls.tree.length;
    const input = q(container, '[data-testid="files-upload-input"]') as HTMLInputElement;
    const files = [new File(["aaa"], "u1.txt"), new File(["bbbbbb"], "u2.txt")];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // 队列渲染且最终全部 done
    expect(q(container, '[data-testid="files-upload-queue"]')).not.toBeNull();
    expect(q(container, '[data-testid="files-upload-item-u1.txt"]').getAttribute("data-status")).toBe("done");
    expect(q(container, '[data-testid="files-upload-item-u2.txt"]').getAttribute("data-status")).toBe("done");
    // 进度回调触发过（假 XHR onprogress(60/100)），终态后无残留 uploading 进度条
    expect(fakeXhrLog.length).toBe(2);
    expect((fakeXhrLog[0] as unknown as { upload: { onprogress?: unknown } }).upload.onprogress).not.toBeNull();
    expect(fakeXhrLog[0]!.url).toContain("/api/fs/upload?");
    expect(fakeXhrLog[0]!.url).toContain("name=u1.txt");
    expect(fakeXhrLog[1]!.url).toContain("name=u2.txt");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    // 上传完成后重取目录：列表重拉 + FileTree 重挂载自拉
    expect(calls.tree.length).toBe(treeCallsBefore + 2);
    await act(async () => {
      root.unmount();
    });
  });

  test("上传 409 冲突：队列项置 failed，existing 信息随 FsUploadConflictError 上抛（toast 提示目标已存在）", async () => {
    stubXHR();
    uploadConflictNext = true;
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: {} };
    const { container, root } = await mountPage(calls);
    const input = q(container, '[data-testid="files-upload-input"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["x"], "c.txt")], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-upload-item-c.txt"]').getAttribute("data-status")).toBe("failed");
    expect(toastTexts()).toContain("目标已存在");
    await act(async () => {
      root.unmount();
    });
  });

  test("失败 toast：删除 409 engine_busy 走错误码词典文案；新建文件 403 走 toast 不重取", async () => {
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: { deleteCode: "engine_busy", createFileStatus: 403, createFileCode: "path_escape" } };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="files-row-alpha.txt"]').dispatchEvent(contextmenu(null));
    });
    await act(async () => {
      q(document, '[data-testid="files-menu-delete"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const toasts = useUiStore.getState().toasts;
    expect(toasts.at(-1)?.kind).toBe("error");
    expect(toasts.at(-1)?.text).toContain("引擎");
    // 新建文件 403 path_escape → toast 兜底键文案，且不重取目录
    const treeCallsBefore = calls.tree.length;
    await act(async () => {
      q(container, '[data-testid="files-toolbar-new-file"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = q(document, '[data-testid="files-dialog-input"]') as HTMLInputElement;
    await act(async () => {
      typeValue(input, "esc/../x");
    });
    await act(async () => {
      q(document, '[data-testid="files-dialog-confirm"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const toasts2 = useUiStore.getState().toasts;
    expect(toasts2.at(-1)?.kind).toBe("error");
    expect(calls.createFile.length).toBe(1);
    expect(calls.tree.length).toBe(treeCallsBefore);
    await act(async () => {
      root.unmount();
    });
  });
});
