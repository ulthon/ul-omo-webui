// @ts-nocheck
// 工具栏模糊快速打开单测（files-ux-revamp 任务 7 / IS-3）。惯例同 files-page.test.tsx：
// @happy-dom 全局注册 + createRoot/act 真实点击与键入，api 层走 recording fetch。
// 覆盖：键入过滤只显示命中；ArrowDown+Enter 回调 active 命中；Escape 关闭；空结果
// noMatch；扫描未完成显示扫描提示（可编程延迟回包）；空白/特殊字符查询不崩溃；
// 宿主集成（窄档推入 + 重按同一文件仍推入 = openSeq 自增；reveal 段加载）。
// 夹具刻意不用 SCAN_IGNORE_DIRS 中任何目录名（node_modules/.git/dist/build 等），
// 与并行泳道（扫描忽略目录下沉到任意深度）结果完全一致。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/files/code-mirror-loader", () => ({
  createEditor: async () => ({ destroy: () => {}, getText: () => "" }),
}));

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FilesPage } = await import("@/pages/files");
const { QuickOpen } = await import("@/components/files/quick-open");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");

const ORIGINAL_FETCH = globalThis.fetch;
const REAL_MATCH_MEDIA = window.matchMedia.bind(window);
const MOBILE_FILES_QUERY = "(max-width: 768px)";
let mqlChangeListeners: Array<(e: { matches: boolean }) => void> = [];

const PROJECT = "/data/proj-a";

function project(path: string, createdAt: string): Record<string, unknown> {
  return { projectPath: path, preferredModel: null, createdAt };
}

const PROJECTS = [project(PROJECT, "2026-01-02T00:00:00.000Z")];

/** 目录夹具：目录名刻意避开 SCAN_IGNORE_DIRS 集合 */
const TREE_FIXTURE: Record<string, Array<{ name: string; type: string; size: number | null; mtime: number | null }>> = {
  "": [
    { name: "notes", type: "directory", size: null, mtime: 1700000000000 },
    { name: "src", type: "directory", size: null, mtime: 1700000000000 },
    { name: "alpha.txt", type: "file", size: 10, mtime: 1700000000000 },
  ],
  notes: [{ name: "todo.md", type: "file", size: 7, mtime: 1700000000000 }],
  src: [
    { name: "app.ts", type: "file", size: 20, mtime: 1700000000000 },
    { name: "util.ts", type: "file", size: 30, mtime: 1700000000000 },
  ],
};

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

interface Calls {
  tree: Array<{ project: string; path: string }>;
  file: Array<{ project: string; path: string }>;
}

function installFetch(calls: Calls, gateRoot?: { promise: Promise<void> }): void {
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/projects")) return okJson({ projects: PROJECTS });
    if (url.includes("/api/fs/tree")) {
      const qs = new URL(url, "http://localhost").searchParams;
      const path = (qs.get("path") ?? "").replace(/\/+$/, "");
      calls.tree.push({ project: qs.get("project") ?? "", path });
      if (path === "" && gateRoot) {
        // 扫描根目录回包可编程延迟：驱动“扫描中”提示的确定性断言
        await gateRoot.promise;
      }
      return okJson({ project: qs.get("project"), path, entries: TREE_FIXTURE[path] ?? [] });
    }
    if (url.includes("/api/fs/file")) {
      const qs = new URL(url, "http://localhost").searchParams;
      calls.file.push({ project: qs.get("project") ?? "", path: qs.get("path") ?? "" });
      return okJson({ project: qs.get("project"), path: qs.get("path"), size: 5, truncated: false, binary: false, content: "hello" });
    }
    return okJson({ ok: true });
  }) as typeof fetch;
}

function stubMatchMedia(matches768: boolean): void {
  mqlChangeListeners = [];
  window.matchMedia = ((query: string) =>
    ({
      matches: matches768 && query === MOBILE_FILES_QUERY,
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => {
        if (query === MOBILE_FILES_QUERY) mqlChangeListeners.push(cb);
      },
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !pred(); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!pred()) throw new Error(`timeout: ${what}`);
}

beforeEach(() => {
  stubMatchMedia(false);
  useUiStore.setState({ filesPageOpen: true, projects: PROJECTS as never });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  window.matchMedia = REAL_MATCH_MEDIA;
  document.body.innerHTML = "";
  useSessionsStore.setState({ byProject: {}, selectedId: null });
});

function q(container: HTMLElement, sel: string): HTMLElement {
  const el = container.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as HTMLElement;
}

/** act 内派发事件：React 状态更新同步冲刷，避免 act 告警与断言竞态 */
async function fire(el: HTMLElement, ev: Event): Promise<void> {
  await act(async () => {
    el.dispatchEvent(ev);
  });
}

/** 受控 input 赋值：React value tracker 会吞同值 input 事件，需走原型 setter（files-ops 同款） */
async function typeInto(container: HTMLElement, sel: string, value: string): Promise<void> {
  const input = q(container, sel) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function keyInto(container: HTMLElement, sel: string, key: string): Promise<void> {
  await fire(q(container, sel), new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

async function clickInto(container: HTMLElement, sel: string): Promise<void> {
  await fire(q(container, sel), new MouseEvent("click", { bubbles: true }));
}

/** 挂载独立 QuickOpen（组件级用例）；返回打开输入框后的容器 */
async function mountQuickOpen(calls: Calls, gateRoot?: { promise: Promise<void> }) {
  installFetch(calls, gateRoot);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onOpen = vi.fn();
  await act(async () => {
    root.render(createElement(QuickOpen, { project: PROJECT, testId: "qo", onOpen }));
  });
  await clickInto(container, "[data-testid=qo]");
  return { container, root, onOpen };
}

describe("QuickOpen 组件", () => {
  test("键入过滤只显示命中路径；ArrowDown+Enter 回调 active 命中", async () => {
    const calls: Calls = { tree: [], file: [] };
    const { container, root, onOpen } = await mountQuickOpen(calls);
    // 扫描完成（根 + 两个子目录都回包）
    await waitFor(
      () => calls.tree.some((c) => c.path === "src") && calls.tree.some((c) => c.path === "notes"),
      "scan finished",
    );
    await typeInto(container, "[data-testid=qo-input]", "app");
    const matches = [...container.querySelectorAll("[data-testid^=qo-match-]")];
    expect(matches.map((el) => el.textContent)).toEqual(["app.tssrc/app.ts"]);
    await keyInto(container, "[data-testid=qo-input]", "ArrowDown");
    // active 项高亮（aria-selected 在 role=option 的 li 上）
    expect(matches[0].closest("li")!.getAttribute("aria-selected")).toBe("true");
    await keyInto(container, "[data-testid=qo-input]", "Enter");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("src/app.ts");
    // 打开后收起并清词
    expect(container.querySelector("[data-testid=qo-input]")).toBeNull();
    root.unmount();
  });

  test("Escape 关闭并清词", async () => {
    const calls: Calls = { tree: [], file: [] };
    const { container, root, onOpen } = await mountQuickOpen(calls);
    await typeInto(container, "[data-testid=qo-input]", "app");
    await keyInto(container, "[data-testid=qo-input]", "Escape");
    expect(container.querySelector("[data-testid=qo-input]")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    // 再次展开：查询已清空，无下拉
    await clickInto(container, "[data-testid=qo]");
    expect(container.querySelector("[data-testid=qo-dropdown]")).toBeNull();
    root.unmount();
  });

  test("空结果显示 noMatch；扫描未完成显示扫描提示", async () => {
    let releaseRoot!: () => void;
    const gate = {
      promise: new Promise<void>((resolve) => {
        releaseRoot = resolve;
      }),
    };
    const calls: Calls = { tree: [], file: [] };
    const { container, root } = await mountQuickOpen(calls, gate);
    await typeInto(container, "[data-testid=qo-input]", "zzz");
    // 根目录回包未放行：显示扫描提示而非 noMatch
    expect(q(container, "[data-testid=qo-no-match]").textContent).toContain("正在扫描");
    await act(async () => {
      releaseRoot();
    });
    await waitFor(
      () => q(container, "[data-testid=qo-no-match]").textContent!.indexOf("扫描") < 0,
      "noMatch after scan",
    );
    expect(q(container, "[data-testid=qo-no-match]").textContent).toContain("无匹配文件");
    root.unmount();
  });

  test("畸形输入不崩溃：纯空白忽略、特殊字符走 noMatch", async () => {
    const calls: Calls = { tree: [], file: [] };
    const { container, root } = await mountQuickOpen(calls);
    await waitFor(() => calls.tree.some((c) => c.path === "src"), "scan finished");
    await typeInto(container, "[data-testid=qo-input]", "   ");
    // 空白查询视为无查询：下拉不渲染
    expect(container.querySelector("[data-testid=qo-dropdown]")).toBeNull();
    await typeInto(container, "[data-testid=qo-input]", "!@#$%");
    expect(q(container, "[data-testid=qo-no-match]").textContent).toContain("无匹配文件");
    root.unmount();
  });
});

/** 挂载完整文件页（窄档推入集成用例） */
async function mountPage(calls: Calls) {
  stubMatchMedia(true);
  installFetch(calls);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(FilesPage));
  });
  return { container, root };
}

describe("宿主工具栏集成（files.tsx 窄档）", () => {
  test("Enter 打开：selected/dir 正确、reveal 段加载、重按同一文件仍推入预览", async () => {
    const calls: Calls = { tree: [], file: [] };
    const { container, root } = await mountPage(calls);
    const stack = () => q(container, "[data-testid=files-narrow-stack]");
    expect(stack().getAttribute("data-level")).toBe("list");

    // 快速打开 notes/todo.md
    await clickInto(container, "[data-testid=files-quick-open]");
    await waitFor(() => calls.tree.some((c) => c.path === "notes"), "scan finished");
    await typeInto(container, "[data-testid=files-quick-open-input]", "todo");
    await keyInto(container, "[data-testid=files-quick-open-input]", "Enter");
    // selected === notes/todo.md（预览拉取该文件）、dir === notes（列表重取父目录）、
    // reveal 生效（控制器额外加载 notes 段 => notes 树请求 >= 2 次：loadDir + reveal）
    await waitFor(() => stack().getAttribute("data-level") === "preview", "preview pushed");
    await waitFor(
      () => calls.file.some((f) => f.path === "notes/todo.md"),
      "preview fetched target file",
    );
    expect(calls.tree.filter((c) => c.path === "notes").length).toBeGreaterThanOrEqual(2);

    // 返回列表后重按同一文件：openSeq 自增 => selectionKey 换新 => 再次推入预览
    await clickInto(container, "[data-testid=files-narrow-stack-back]");
    expect(stack().getAttribute("data-level")).toBe("list");
    await clickInto(container, "[data-testid=files-quick-open]");
    await typeInto(container, "[data-testid=files-quick-open-input]", "todo");
    await keyInto(container, "[data-testid=files-quick-open-input]", "Enter");
    await waitFor(() => stack().getAttribute("data-level") === "preview", "re-push same file");
    root.unmount();
  });
});
