// @ts-nocheck
// 文件管理页三栏布局单测（builtin-file-management 任务 2）。惯例同 files-entry.test.tsx
// / settings-page.test.tsx：@happy-dom 全局注册 + createRoot/act 真实点击，api 层走
// recording fetch。覆盖计划验收：项目下拉渲染已注册项且默认取最近活跃会话项目；
// 列表列头排序（目录恒优先）；切项目后树/列表刷新（stale_state 对抗项）；目录进入与
// 文件预览面板挂载；项目接口失败/目录加载失败错误态不崩溃（malformed 对抗项）。
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
const REAL_MATCH_MEDIA = window.matchMedia.bind(window);
const MOBILE_FILES_QUERY = "(max-width: 768px)";

function project(path: string, lastOpenedAt: string): Record<string, unknown> {
  return { projectPath: path, preferredModel: null, lastOpenedAt, createdAt: lastOpenedAt };
}

const PROJECTS = [
  project("/data/proj-a", "2026-01-02T00:00:00.000Z"),
  project("/data/proj-b", "2026-01-03T00:00:00.000Z"),
];

/** 项目内单层目录（契约字段齐全；size/mtime 为服务端增补字段） */
const TREE_FIXTURE: Record<string, Array<{ name: string; type: string; size: number | null; mtime: number | null }>> = {
  "": [
    { name: "docs", type: "directory", size: null, mtime: 1700000000000 },
    { name: "beta.txt", type: "file", size: 2048, mtime: 1700000100000 },
    { name: "alpha.md", type: "file", size: 10, mtime: 1700000000000 },
    { name: "lnk", type: "symlink", size: 30, mtime: 1700000050000 },
  ],
  docs: [{ name: "readme.md", type: "file", size: 7, mtime: 1700000000000 }],
};

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function errJson(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Calls {
  tree: Array<{ project: string; path: string }>;
  file: Array<{ project: string; path: string }>;
  failTree: boolean;
  failProjects: boolean;
}

function installFetch(calls: Calls): void {
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/projects")) {
      if (calls.failProjects) return errJson(500, "internal", "boom");
      return okJson({ projects: PROJECTS });
    }
    if (url.includes("/api/fs/tree")) {
      const qs = new URL(url, "http://localhost").searchParams;
      calls.tree.push({ project: qs.get("project") ?? "", path: qs.get("path") ?? "" });
      if (calls.failTree) return errJson(500, "internal", "boom");
      const proj = qs.get("project") ?? "";
      const path = (qs.get("path") ?? "").replace(/\/+$/, "");
      return okJson({ project: proj, path, entries: TREE_FIXTURE[path] ?? [] });
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

beforeEach(() => {
  stubMatchMedia(false);
  useUiStore.setState({ filesPageOpen: true, projects: PROJECTS as never, currentProject: "/data/proj-a" });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  window.matchMedia = REAL_MATCH_MEDIA;
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

function q(container: HTMLElement, sel: string): HTMLElement {
  const el = container.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as HTMLElement;
}

function rowNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-testid^='files-row-']")].map((el) =>
    (el as HTMLElement).getAttribute("data-testid")!.slice("files-row-".length),
  );
}

function rowText(container: HTMLElement, name: string): string {
  const row = container.querySelector(`[data-testid='files-row-${name}']`)?.closest("tr");
  if (!row) throw new Error(`missing row ${name}`);
  return row.textContent ?? "";
}

describe("builtin-file-management 任务 2：文件管理页三栏布局", () => {
  test("项目下拉渲染已注册项，默认选中最近活跃会话项目并加载其目录", async () => {
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    const select = q(container, '[data-testid="files-project-select"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["/data/proj-a", "/data/proj-b"]);
    expect(select.value).toBe("/data/proj-a");
    // 目录列表已按当前项目根加载
    expect(calls.tree.some((c) => c.project === "/data/proj-a" && c.path === "")).toBe(true);
    expect(rowNames(container)).toEqual(["docs", "alpha.md", "beta.txt", "lnk"]);
    await act(async () => {
      root.unmount();
    });
  });

  test("无会话记忆时默认取列表首个项目", async () => {
    useUiStore.setState({ currentProject: null });
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    expect((q(container, '[data-testid="files-project-select"]') as HTMLSelectElement).value).toBe("/data/proj-a");
    await act(async () => {
      root.unmount();
    });
  });

  test("切项目后树/列表刷新（fsTree 以新项目重取）", async () => {
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    const select = q(container, '[data-testid="files-project-select"]') as HTMLSelectElement;
    await act(async () => {
      select.value = "/data/proj-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(calls.tree.some((c) => c.project === "/data/proj-b" && c.path === "")).toBe(true);
    expect((q(container, '[data-testid="files-project-select"]') as HTMLSelectElement).value).toBe("/data/proj-b");
    await act(async () => {
      root.unmount();
    });
  });

  test("列头点击排序：名称升/降切换，目录恒优先；类型列可排序", async () => {
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    expect(rowNames(container)).toEqual(["docs", "alpha.md", "beta.txt", "lnk"]);
    await act(async () => {
      q(container, '[data-testid="files-sort-name"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(rowNames(container)).toEqual(["docs", "lnk", "beta.txt", "alpha.md"]);
    await act(async () => {
      q(container, '[data-testid="files-sort-type"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 类型升序：目录先，file(alpha/beta) 后 symlink(lnk)
    expect(rowNames(container)).toEqual(["docs", "alpha.md", "beta.txt", "lnk"]);
    await act(async () => {
      root.unmount();
    });
  });

  test("单击目录进入（列表按子目录重取），面包屑回跳根；单击文件挂载预览面板", async () => {
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="files-row-docs"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(calls.tree.some((c) => c.project === "/data/proj-a" && c.path === "docs")).toBe(true);
    expect(rowNames(container)).toEqual(["readme.md"]);
    // 面包屑回根
    await act(async () => {
      q(container, '[data-testid="files-breadcrumb-root"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(rowNames(container)).toEqual(["docs", "alpha.md", "beta.txt", "lnk"]);
    // 单击文件 → 预览面板挂载并展示路径
    await act(async () => {
      q(container, '[data-testid="files-row-alpha.md"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-preview-pane"]').textContent).toContain("alpha.md");
    expect(calls.file.some((c) => c.project === "/data/proj-a" && c.path === "alpha.md")).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });

  test("size/mtime 真实值渲染：文件大小与格式化 mtime，无值回退占位符", async () => {
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    // mtime 以 YYYY-MM-DD HH:mm 格式展示
    expect(rowText(container, "beta.txt")).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(rowText(container, "beta.txt")).toContain("2.0 KB");
    expect(rowText(container, "alpha.md")).toContain("10 B");
    // 目录 size 为 null → 占位符
    expect(rowText(container, "docs")).toContain("—");
    await act(async () => {
      root.unmount();
    });
  });

  test("列头点击排序：size 数值序（null 恒在后）；mtime 时间序", async () => {
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="files-sort-size"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // size 升序：目录恒优先，其余 10 < 30 < 2048
    expect(rowNames(container)).toEqual(["docs", "alpha.md", "lnk", "beta.txt"]);
    await act(async () => {
      q(container, '[data-testid="files-sort-size"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(rowNames(container)).toEqual(["docs", "beta.txt", "lnk", "alpha.md"]);
    await act(async () => {
      q(container, '[data-testid="files-sort-mtime"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // mtime 升序：alpha(…000) < lnk(…500) < beta(…100)
    expect(rowNames(container)).toEqual(["docs", "alpha.md", "lnk", "beta.txt"]);
    await act(async () => {
      root.unmount();
    });
  });

  test("malformed：目录接口失败渲染错误态不崩溃；项目接口失败且库空时页面级错误态", async () => {
    const calls: Calls = { tree: [], file: [], failTree: true, failProjects: false };
    const { container, root } = await mountPage(calls);
    expect(q(container, '[data-testid="files-list-error"]')).not.toBeNull();
    await act(async () => {
      root.unmount();
    });

    useUiStore.setState({ projects: [] as never });
    const calls2: Calls = { tree: [], file: [], failTree: false, failProjects: true };
    const { container: c2, root: r2 } = await mountPage(calls2);
    expect(q(c2, '[data-testid="files-projects-error"]')).not.toBeNull();
    await act(async () => {
      r2.unmount();
    });
  });

  test("手机档（≤768px）单栏层叠：段切换钮切树/列表/预览", async () => {
    stubMatchMedia(true);
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    expect(q(container, '[data-testid="files-mobile-tabs"]')).not.toBeNull();
    // 默认列表段
    expect(q(container, '[data-testid="files-list-pane"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="files-tree-pane"]')).toBeNull();
    // 切到树段
    await act(async () => {
      q(container, '[data-testid="files-mobile-tab-tree"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-tree-pane"]')).not.toBeNull();
    // 树中目录点击 → 进入目录并自动切回列表段
    await act(async () => {
      q(container, '[data-testid="tree-row-docs"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-list-pane"]')).not.toBeNull();
    expect(calls.tree.some((c) => c.path === "docs")).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });
});
