// @ts-nocheck
// 写操作确认弹窗 / 冲突三选 / 位图预览解锁单测（builtin-file-management 任务 7）。
// 惯例同 files-ops.test.tsx：@happy-dom 全局注册 + createRoot/act 真实点击，
// api 层走 recording fetch/XHR。覆盖计划验收：
// (1) 删除确认弹窗文案与目录直接子条目数渲染；engine_busy 409 专用提示文案；
// (2) move 409 target_exists 三选各自的重试参数（断言 PATCH body 的 overwrite/conflict）；
// (3) upload 409 三选：保留两者置灰带原因、覆盖以 overwrite:true 重传、取消置 canceled；
// (4) FilePreview enableImageInline：缺省关闭占位不变；开启后 binary 位图渲染
//     <img src=fsDownloadUrl>。
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
const { FilePreview } = await import("@/components/file-tree/file-preview");
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
  docs: [
    { name: "a.md", type: "file", size: 1, mtime: 1700000000000 },
    { name: "b.md", type: "file", size: 2, mtime: 1700000000000 },
    { name: "sub", type: "directory", size: null, mtime: 1700000000000 },
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
  /** 每次 PATCH 的完整 body（含 overwrite/conflict 重试参数） */
  move: Array<Record<string, unknown>>;
  del: string[];
  fail: { deleteCode?: string; move409Once?: boolean };
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
    if (url.includes("/api/fs/entry") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body) || "{}") as Record<string, unknown>;
      if (calls.fail.move409Once && body.overwrite !== true && body.conflict !== "rename") {
        calls.move.push(body);
        calls.fail.move409Once = false;
        return errJson(409, "target_exists", "目标已存在：/data/proj-a/beta.txt");
      }
      calls.move.push(body);
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

/** 可编程假 XHR（fsUpload 走 XHR）：首次 409 target_exists（携 existing），其后 201 */
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
    const conflict = this.url.includes("/api/fs/upload") && !this.url.includes("overwrite=true") && uploadConflictOnce;
    this.status = conflict ? 409 : 201;
    this.responseText = conflict
      ? JSON.stringify({
          error: { code: "target_exists", message: "目标已存在" },
          existing: { path: "/data/proj-a/alpha.bin", kind: "file", size: 3, mtimeNs: "42" },
        })
      : JSON.stringify({ path: "/data/proj-a/x", bytes: 100, mtimeNs: "0" });
    this.onload();
  }
}

let uploadConflictOnce = false;
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
  uploadConflictOnce = false;
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

function contextmenu(): MouseEvent {
  return new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 });
}

function click(el: HTMLElement): Promise<void> {
  return act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
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

async function openMenuAndPick(container: HTMLElement, rowSel: string, menuItemId: string): Promise<void> {
  await act(async () => {
    q(container, rowSel).dispatchEvent(contextmenu());
  });
  await click(q(document, `[data-testid="${menuItemId}"]`));
}

function freshCalls(): Calls {
  return { tree: [], move: [], del: [], fail: {} };
}

describe("任务 7：删除确认弹窗", () => {
  test("文件删除：确认弹窗文案、确认后发 DELETE、取消不发请求", async () => {
    const calls = freshCalls();
    const { container, root } = await mountPage(calls);
    await openMenuAndPick(container, '[data-testid="files-row-alpha.txt"]', "files-menu-delete");
    const dialog = q(document, '[data-testid="files-delete-dialog"]');
    expect(dialog.textContent).toContain("确认删除");
    expect(dialog.textContent).toContain("alpha.txt");
    expect(dialog.textContent).toContain("不可撤销");
    // 取消：不发 DELETE
    await click(q(document, '[data-testid="files-delete-cancel"]'));
    expect(calls.del).toEqual([]);
    // 再开并确认
    await openMenuAndPick(container, '[data-testid="files-row-alpha.txt"]', "files-menu-delete");
    await click(q(document, '[data-testid="files-delete-confirm"]'));
    expect(calls.del).toEqual(["alpha.txt"]);
    await act(async () => {
      root.unmount();
    });
  });

  test("目录删除：明示递归与直接子条目数（弹窗打开时拉目录列表统计）", async () => {
    const calls = freshCalls();
    const { container, root } = await mountPage(calls);
    const treeCallsBefore = calls.tree.length;
    await openMenuAndPick(container, '[data-testid="files-row-docs"]', "files-menu-delete");
    const dialog = q(document, '[data-testid="files-delete-dialog"]');
    expect(dialog.textContent).toContain("及其全部内容");
    const counter = q(document, '[data-testid="files-delete-child-count"]');
    expect(counter.textContent).toContain("3");
    // 弹窗打开确实为此目录拉了一次列表
    expect(calls.tree.slice(treeCallsBefore)).toEqual(["docs"]);
    await act(async () => {
      root.unmount();
    });
  });

  test("engine_busy 409：专用提示文案「引擎正在此项目工作，稍后再试」", async () => {
    const calls = freshCalls();
    calls.fail.deleteCode = "engine_busy";
    const { container, root } = await mountPage(calls);
    await openMenuAndPick(container, '[data-testid="files-row-alpha.txt"]', "files-menu-delete");
    await click(q(document, '[data-testid="files-delete-confirm"]'));
    expect(toastTexts()).toContain("引擎正在此项目工作，稍后再试");
    await act(async () => {
      root.unmount();
    });
  });
});

describe("任务 7：move 409 target_exists 三选", () => {
  test("覆盖：以 {overwrite:true} 重试同一 from/to", async () => {
    const calls = freshCalls();
    calls.fail.move409Once = true;
    const { container, root } = await mountPage(calls);
    await openMenuAndPick(container, '[data-testid="files-row-alpha.txt"]', "files-menu-move");
    const input = q(document, '[data-testid="files-dialog-input"]') as HTMLInputElement;
    typeValue(input, "beta.txt");
    await click(q(document, '[data-testid="files-dialog-confirm"]'));
    // 409 → 三选弹窗出现
    const dialog = q(document, '[data-testid="files-conflict-dialog"]');
    expect(dialog.textContent).toContain("beta.txt");
    await click(q(document, '[data-testid="files-conflict-overwrite"]'));
    const retry = calls.move[calls.move.length - 1];
    expect(retry).toEqual({ from: "alpha.txt", to: "beta.txt", overwrite: true });
    await act(async () => {
      root.unmount();
    });
  });

  test("保留两者：以 {conflict:'rename'} 重试", async () => {
    const calls = freshCalls();
    calls.fail.move409Once = true;
    const { container, root } = await mountPage(calls);
    await openMenuAndPick(container, '[data-testid="files-row-alpha.txt"]', "files-menu-move");
    const input = q(document, '[data-testid="files-dialog-input"]') as HTMLInputElement;
    typeValue(input, "beta.txt");
    await click(q(document, '[data-testid="files-dialog-confirm"]'));
    await click(q(document, '[data-testid="files-conflict-keep-both"]'));
    const retry = calls.move[calls.move.length - 1];
    expect(retry).toEqual({ from: "alpha.txt", to: "beta.txt", conflict: "rename" });
    await act(async () => {
      root.unmount();
    });
  });

  test("取消：关闭弹窗且不重试", async () => {
    const calls = freshCalls();
    calls.fail.move409Once = true;
    const { container, root } = await mountPage(calls);
    await openMenuAndPick(container, '[data-testid="files-row-alpha.txt"]', "files-menu-move");
    const input = q(document, '[data-testid="files-dialog-input"]') as HTMLInputElement;
    typeValue(input, "beta.txt");
    await click(q(document, '[data-testid="files-dialog-confirm"]'));
    await click(q(document, '[data-testid="files-conflict-cancel"]'));
    expect(calls.move).toEqual([{ from: "alpha.txt", to: "beta.txt" }]);
    expect(document.querySelector('[data-testid="files-conflict-dialog"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});

describe("任务 7：upload 409 三选（保留两者置灰）", () => {
  function pickFile(container: HTMLElement, name = "alpha.bin"): Promise<void> {
    return act(async () => {
      const input = q(container, '[data-testid="files-upload-input"]') as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [new File(["abc"], name)], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  test("保留两者置灰带原因；覆盖以 overwrite:true 重传同一文件名", async () => {
    stubXHR();
    uploadConflictOnce = true;
    const calls = freshCalls();
    const { container, root } = await mountPage(calls);
    await pickFile(container);
    const dialog = q(document, '[data-testid="files-conflict-dialog"]');
    expect(dialog.textContent).toContain("alpha.bin");
    expect(dialog.textContent).toContain("file");
    const keepBoth = q(document, '[data-testid="files-conflict-keep-both"]') as HTMLButtonElement;
    expect(keepBoth.disabled).toBe(true);
    expect(keepBoth.title).toContain("自动改名");
    await click(q(document, '[data-testid="files-conflict-overwrite"]'));
    expect(fakeXhrLog.length).toBe(2);
    expect(fakeXhrLog[1].url).toContain("overwrite=true");
    expect(fakeXhrLog[1].url).toContain("name=alpha.bin");
    expect(q(document, '[data-testid="files-upload-item-alpha.bin"]').getAttribute("data-status")).toBe("done");
    await act(async () => {
      root.unmount();
    });
  });

  test("取消：队列项置 canceled 且不发重传", async () => {
    stubXHR();
    uploadConflictOnce = true;
    const calls = freshCalls();
    const { container, root } = await mountPage(calls);
    await pickFile(container);
    await click(q(document, '[data-testid="files-conflict-cancel"]'));
    expect(fakeXhrLog.length).toBe(1);
    expect(q(document, '[data-testid="files-upload-item-alpha.bin"]').getAttribute("data-status")).toBe("canceled");
    await act(async () => {
      root.unmount();
    });
  });
});

describe("任务 7：FilePreview 位图真内联（enableImageInline）", () => {
  const BINARY_PNG = { binary: true, content: null, truncated: false, size: 7 };

  function stubFileApi(): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/fs/file")) return okJson(BINARY_PNG);
      return okJson({ ok: true });
    }) as typeof fetch;
  }

  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("缺省关闭：binary 位图仍为占位（composer @引用默认行为不变）", async () => {
    stubFileApi();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(FilePreview, { project: "/data/proj-a", path: "pic.png" }));
    });
    expect(q(document, '[data-testid="preview-image-placeholder"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="preview-image"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  test("开启后：binary 位图渲染 <img src=fsDownloadUrl>，文本路径不受影响", async () => {
    stubFileApi();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(FilePreview, { project: "/data/proj-a", path: "pic.png", enableImageInline: true }));
    });
    const img = document.querySelector('[data-testid="preview-image"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe(
      `/api/fs/download?project=${encodeURIComponent("/data/proj-a")}&path=${encodeURIComponent("pic.png")}`,
    );
    await act(async () => {
      root.unmount();
    });
    // 文本文件路径行为不变（非 binary 仍走 preview-text）
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/fs/file")) return okJson({ binary: false, content: "hello", truncated: false, size: 5 });
      return okJson({ ok: true });
    }) as typeof fetch;
    const container2 = document.createElement("div");
    document.body.appendChild(container2);
    const root2 = createRoot(container2);
    await act(async () => {
      root2.render(createElement(FilePreview, { project: "/data/proj-a", path: "a.txt", enableImageInline: true }));
    });
    expect(q(document, '[data-testid="preview-text"]')).not.toBeNull();
    await act(async () => {
      root2.unmount();
    });
  });
});
