// @ts-nocheck
// 文件管理页操作面单测（builtin-file-management 任务 6）。惯例同 files-page.test.tsx：
// @happy-dom 全局注册 + createRoot/act 真实点击，api 层走 recording fetch/XHR。
// 覆盖计划验收：工具栏渲染；列表/树右键菜单项（目录多“在此上传”）；上传进度回调触发
// 与队列结果态；操作成功后重取当前目录 + 树按失效矩阵局部刷新（recording 断言，
// files-ux-revamp 任务 3：展开态保留、不重挂载）；409/403 失败 toast。
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
  { projectPath: "/data/proj-a", preferredModel: null, createdAt: "2026-01-02T00:00:00.000Z" },
];

const TREE_FIXTURE: Record<string, Array<{ name: string; type: string; size: number | null; mtime: number | null }>> = {
  "": [
    { name: "docs", type: "directory", size: null, mtime: 1700000000000 },
    { name: "alpha.txt", type: "file", size: 10, mtime: 1700000000000 },
  ],
  docs: [{ name: "readme.md", type: "file", size: 7, mtime: 1700000000000 }],
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
  useUiStore.setState({ filesPageOpen: true, projects: PROJECTS as never });
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

function contextmenu(): MouseEvent {
  return new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 });
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
      q(container, '[data-testid="files-row-alpha.txt"]').dispatchEvent(contextmenu());
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
      q(container, '[data-testid="files-row-docs"]').dispatchEvent(contextmenu());
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
      q(container, '[data-testid="tree-row-docs"]').dispatchEvent(contextmenu());
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
      q(container, '[data-testid="files-row-alpha.txt"]').dispatchEvent(contextmenu());
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
    // 成功后局部刷新：中栏列表重拉（""）+ 树 refreshDirs 刷新根（同目录重命名 →
    // refresh=[""]，根已加载过 → 回源一次）；两次取数都落在 ""
    expect(calls.tree.length).toBe(treeCallsBefore + 2);
    expect(calls.tree.slice(-2)).toEqual(["", ""]);
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
    // 局部刷新：中栏列表重拉（""）+1；树的 refresh 集只有父目录 docs —— 树里 docs
    // 从未加载过，refreshDirs 不回源（懒加载语义），不再整树重拉
    expect(calls.tree.length).toBe(3);
    expect(calls.tree.at(-1)).toBe("");
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
    // 上传完成后局部刷新：中栏列表重拉（""）+ 树 refreshDirs([""]，目标目录为根）
    expect(calls.tree.length).toBe(treeCallsBefore + 2);
    expect(calls.tree.slice(-2)).toEqual(["", ""]);
    await act(async () => {
      root.unmount();
    });
  });

  test("上传 409 冲突（任务 7 升级为三选弹窗）：弹窗出现携 existing，取消置 canceled；覆盖 overwrite:true 重传成功置 done", async () => {
    stubXHR();
    uploadConflictNext = true;
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: {} };
    const { container, root } = await mountPage(calls);
    const input = q(container, '[data-testid="files-upload-input"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["x"], "c.txt")], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // 409 → 三选弹窗：携 existing 信息（kind=file）；保留两者置灰（上传不支持自动改名）
    const dialog = q(document, '[data-testid="files-conflict-dialog"]');
    expect(dialog.textContent).toContain("c.txt");
    expect(dialog.textContent).toContain("file");
    expect((q(document, '[data-testid="files-conflict-keep-both"]') as HTMLButtonElement).disabled).toBe(true);
    // 取消：队列项 canceled 且无重传
    await act(async () => {
      q(document, '[data-testid="files-conflict-cancel"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-upload-item-c.txt"]').getAttribute("data-status")).toBe("canceled");
    expect(fakeXhrLog.length).toBe(1);
    // 再走一遍：这次选覆盖 → overwrite:true 重传成功置 done
    uploadConflictNext = true;
    Object.defineProperty(input, "files", { value: [new File(["y"], "d.txt")], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="files-conflict-dialog"]')).not.toBeNull();
    uploadConflictNext = false;
    await act(async () => {
      q(document, '[data-testid="files-conflict-overwrite"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(fakeXhrLog.length).toBe(3);
    expect(fakeXhrLog[2].url).toContain("overwrite=true");
    expect(fakeXhrLog[2].url).toContain("name=d.txt");
    expect(q(container, '[data-testid="files-upload-item-d.txt"]').getAttribute("data-status")).toBe("done");
    await act(async () => {
      root.unmount();
    });
  });

  test("失败 toast：删除 409 engine_busy 走错误码词典文案；新建文件 403 走 toast 不重取", async () => {
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: { deleteCode: "engine_busy", createFileStatus: 403, createFileCode: "path_escape" } };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="files-row-alpha.txt"]').dispatchEvent(contextmenu());
    });
    await act(async () => {
      q(document, '[data-testid="files-menu-delete"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 任务 7：删除先过确认弹窗
    await act(async () => {
      q(document, '[data-testid="files-delete-confirm"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const notifs = useUiStore.getState().globalNotifs;
    expect(notifs.some((n) => n.text.includes("引擎"))).toBe(true);
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
    expect(useUiStore.getState().globalNotifs.length).toBeGreaterThanOrEqual(2);
    expect(calls.createFile.length).toBe(1);
    expect(calls.tree.length).toBe(treeCallsBefore);
    await act(async () => {
      root.unmount();
    });
  });
});

describe("files-ux-revamp 任务 3：树局部刷新（IS-2 展开态保留 + 不重挂载）", () => {
  test("同目录重命名：树不重挂载、展开目录仍展开；挂载取数恰好两次（受控回退 hook 零请求）", async () => {
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: {} };
    const { container, root } = await mountPage(calls);
    // 挂载取数恰好两次：中栏列表 "" + 页面控制器根加载 ""（FileTree 受控模式下回退
    // hook 被静默取数器抑制，不再多发一次根请求）
    expect(calls.tree).toEqual(["", ""]);
    // 展开目录 docs（树懒加载拉 docs 一层）
    await act(async () => {
      q(container, '[data-testid="tree-row-docs"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="tree-row-docs"]').getAttribute("aria-expanded")).toBe("true");
    expect(q(container, '[data-testid="tree-row-docs/readme.md"]')).not.toBeNull();
    // 测试侧给树容器打身份标记（非生产代码）：写操作后必须是同一 DOM 节点仍在文档中
    const treeEl = q(container, '[data-testid="file-tree"]');
    treeEl.setAttribute("data-no-remount-probe", "1");
    // 点击树行 docs 已同步把中栏带入 docs，直接对其中的文件重命名（同目录 rename）
    await act(async () => {
      q(container, '[data-testid="files-row-readme.md"]').dispatchEvent(contextmenu());
    });
    await act(async () => {
      q(document, '[data-testid="files-menu-rename"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = q(document, '[data-testid="files-dialog-input"]') as HTMLInputElement;
    await act(async () => {
      typeValue(input, "docs/renamed.md");
    });
    const treeCallsBefore = calls.tree.length;
    await act(async () => {
      q(document, '[data-testid="files-dialog-confirm"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(calls.move).toEqual([{ from: "docs/readme.md", to: "docs/renamed.md" }]);
    // IS-2 核心：展开目录行仍在 DOM 且保持展开
    expect(q(container, '[data-testid="tree-row-docs"]').getAttribute("aria-expanded")).toBe("true");
    // 树容器未被重挂载：同一节点、测试标记仍在、仍挂在文档上
    const treeElAfter = q(container, '[data-testid="file-tree"]');
    expect(treeElAfter).toBe(treeEl);
    expect(treeElAfter.getAttribute("data-no-remount-probe")).toBe("1");
    expect(document.body.contains(treeEl)).toBe(true);
    // 局部刷新口径：中栏列表重拉 docs + 树 refreshDirs(["docs"]) 各一次（快照后
    // 恰好 +2，缺一不可——防误过：预操作的导航取数不能再计入）
    expect(calls.tree.length).toBe(treeCallsBefore + 2);
    expect(calls.tree.slice(-2)).toEqual(["docs", "docs"]);
    await act(async () => {
      root.unmount();
    });
  });

  test("跨目录移动：树同时刷新源与目标父目录（展开态保留）", async () => {
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: {} };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="tree-row-docs"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const treeEl = q(container, '[data-testid="file-tree"]');
    treeEl.setAttribute("data-no-remount-probe", "1");
    // 点击树行已把中栏带入 docs：面包屑回根后再从根列表移动 alpha.txt
    await act(async () => {
      q(container, '[data-testid="files-breadcrumb-root"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      q(container, '[data-testid="files-row-alpha.txt"]').dispatchEvent(contextmenu());
    });
    await act(async () => {
      q(document, '[data-testid="files-menu-move"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = q(document, '[data-testid="files-dialog-input"]') as HTMLInputElement;
    await act(async () => {
      typeValue(input, "docs/alpha.txt");
    });
    await act(async () => {
      q(document, '[data-testid="files-dialog-confirm"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(calls.move).toEqual([{ from: "alpha.txt", to: "docs/alpha.txt" }]);
    // move 失效矩阵：refresh = [源父 ""，目标父 docs]（都已加载 → 都回源）+ evict = [源]；
    // 外加中栏列表重拉 ""，共 +3 次
    expect(calls.tree.slice(-3)).toEqual(["", "", "docs"]);
    expect(q(container, '[data-testid="tree-row-docs"]').getAttribute("aria-expanded")).toBe("true");
    expect(q(container, '[data-testid="file-tree"]')).toBe(treeEl);
    await act(async () => {
      root.unmount();
    });
  });

  test("上传局部刷新目标目录：树上“在此上传”后只拉目标目录且不重挂载", async () => {
    stubXHR();
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: {} };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="tree-row-docs"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 点击树行已展开并加载 docs、把中栏带入 docs：面包屑回根，后续列表重拉落在 ""
    await act(async () => {
      q(container, '[data-testid="files-breadcrumb-root"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      q(container, '[data-testid="tree-row-docs"]').dispatchEvent(contextmenu());
    });
    await act(async () => {
      q(document, '[data-testid="files-menu-upload-here"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = q(container, '[data-testid="files-upload-input"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["x"], "up.txt")], configurable: true });
    const treeEl = q(container, '[data-testid="file-tree"]');
    treeEl.setAttribute("data-no-remount-probe", "1");
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-upload-item-up.txt"]').getAttribute("data-status")).toBe("done");
    // upload 失效矩阵：中栏列表重拉（当前目录 ""）+ 树只刷目标目录 docs
    expect(calls.tree.slice(-2)).toEqual(["", "docs"]);
    expect(q(container, '[data-testid="tree-row-docs"]').getAttribute("aria-expanded")).toBe("true");
    expect(q(container, '[data-testid="file-tree"]')).toBe(treeEl);
    await act(async () => {
      root.unmount();
    });
  });

  test("删除目录：树刷新父目录且被删目录收起（死亡子树不留展开态）", async () => {
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: {} };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="tree-row-docs"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="tree-row-docs"]').getAttribute("aria-expanded")).toBe("true");
    const treeEl = q(container, '[data-testid="file-tree"]');
    treeEl.setAttribute("data-no-remount-probe", "1");
    // 点击树行已把中栏带入 docs：面包屑回根，从根列表右键 docs 行删除（目录先拉子条目数）
    await act(async () => {
      q(container, '[data-testid="files-breadcrumb-root"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      q(container, '[data-testid="files-row-docs"]').dispatchEvent(contextmenu());
    });
    await act(async () => {
      q(document, '[data-testid="files-menu-delete"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    const treeCallsBefore = calls.tree.length;
    await act(async () => {
      q(document, '[data-testid="files-delete-confirm"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(calls.del).toEqual(["docs"]);
    // delete 失效矩阵：中栏列表重拉 "" + 树 refresh=[""] 回源；docs 被 evict ——
    // 行仍在（根列表回包带回）但收起，死亡目录不能留展开态
    expect(calls.tree.slice(-2)).toEqual(["", ""]);
    expect(q(container, '[data-testid="tree-row-docs"]').getAttribute("aria-expanded")).toBe("false");
    // 删除也是写操作：树容器同样不重挂载
    expect(q(container, '[data-testid="file-tree"]')).toBe(treeEl);
    expect(q(container, '[data-testid="file-tree"]').getAttribute("data-no-remount-probe")).toBe("1");
    await act(async () => {
      root.unmount();
    });
  });

  test("工具栏刷新：树全量局部刷新（已加载目录集回源，展开态保留不重挂载）", async () => {
    const calls: Calls = { tree: [], move: [], del: [], createFile: [], createDir: [], fail: {} };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="tree-row-docs"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const treeEl = q(container, '[data-testid="file-tree"]');
    treeEl.setAttribute("data-no-remount-probe", "1");
    // 点击树行已把中栏带入 docs：面包屑回根，刷新时列表重拉落在 ""
    await act(async () => {
      q(container, '[data-testid="files-breadcrumb-root"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      q(container, '[data-testid="files-toolbar-refresh"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // refreshAll：中栏列表重拉 "" + 树对已加载目录集 {""，docs} 全部回源（保留展开）
    expect(calls.tree.slice(-3)).toEqual(["", "", "docs"]);
    expect(q(container, '[data-testid="tree-row-docs"]').getAttribute("aria-expanded")).toBe("true");
    expect(q(container, '[data-testid="file-tree"]')).toBe(treeEl);
    // 总取数：挂载 2 + 展开导航 2（树 docs/列表 docs）+ 面包屑回根 1 + 刷新 3
    expect(calls.tree.length).toBe(8);
    await act(async () => {
      root.unmount();
    });
  });
});
