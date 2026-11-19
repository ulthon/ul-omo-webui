// @ts-nocheck
// 文件管理页三栏布局单测（builtin-file-management 任务 2）。惯例同 files-entry.test.tsx
// / settings-page.test.tsx：@happy-dom 全局注册 + createRoot/act 真实点击，api 层走
// recording fetch。覆盖计划验收：项目下拉渲染已注册项且默认取最近活跃会话项目；
// 列表列头排序（目录恒优先）；切项目后树/列表刷新（stale_state 对抗项）；目录进入与
// 文件预览面板挂载；项目接口失败/目录加载失败错误态不崩溃（malformed 对抗项）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// code-mirror-loader mock（files-ux-revamp 任务 5）：宽→窄转换用例会进入编辑层，
// happy-dom 不真实加载 CodeMirror（同 file-editor.test.tsx 惯例）
vi.mock("@/components/files/code-mirror-loader", () => ({
  createEditor: async () => ({ destroy: () => {}, getText: () => "" }),
}));

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FilesPage } = await import("@/pages/files");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");

const ORIGINAL_FETCH = globalThis.fetch;
const REAL_MATCH_MEDIA = window.matchMedia.bind(window);
const MOBILE_FILES_QUERY = "(max-width: 768px)";
let mqlChangeListeners: Array<(e: { matches: boolean }) => void> = [];

function project(path: string, createdAt: string): Record<string, unknown> {
  return { projectPath: path, preferredModel: null, createdAt };
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
  mqlChangeListeners = [];
  window.matchMedia = ((query: string) =>
    ({
      matches: matches768 && query === MOBILE_FILES_QUERY,
      media: query,
      onchange: null,
      // 只记录 768 断点的监听器：fireViewport 模拟跨断点时避免误触其他查询
      addEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => {
        if (query === MOBILE_FILES_QUERY) mqlChangeListeners.push(cb);
      },
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

/** 模拟跨断点：驱动已挂载页面 useIsMobile 的 change 订阅（只动 768 查询） */
async function fireViewport(matches768: boolean): Promise<void> {
  await act(async () => {
    for (const cb of mqlChangeListeners) cb({ matches: matches768 });
  });
}

/** 等异步条件成立（编辑钮等 FilePreview 拉完才渲染） */
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
    // 派生主路径播种（W3 任务 12）：选中会话属 proj-b → 默认选 proj-b（区别于列表首个 proj-a）
    useSessionsStore.setState({
      byProject: {
        "/data/proj-b": [
          { id: "s-b", path: "/data/proj-b/s-b.jsonl", project: "/data/proj-b", title: "s-b", name: null, renamedTitle: null, parentSessionPath: null, created: "2026-01-03T00:00:00.000Z", modified: "2026-01-03T00:00:00.000Z", messageCount: 1, firstMessage: "", pinned: false, archivedAt: null, unreadCount: 0, lastRead: null, active: false },
        ],
      },
      selectedId: "s-b",
    });
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    const select = q(container, '[data-testid="files-project-select"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["/data/proj-a", "/data/proj-b"]);
    expect(select.value).toBe("/data/proj-b");
    // 目录列表已按当前项目根加载
    expect(calls.tree.some((c) => c.project === "/data/proj-b" && c.path === "")).toBe(true);
    expect(rowNames(container)).toEqual(["docs", "alpha.md", "beta.txt", "lnk"]);
    await act(async () => {
      root.unmount();
    });
  });

  test("无会话记忆时默认取列表首个项目", async () => {
    // 无选中会话（无派生活动项目）→ 回退列表首个
    useSessionsStore.setState({ byProject: {}, selectedId: null });
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

describe("files-ux-revamp 任务 5：手机档窄栈单列推入", () => {
  test("无三段切换钮；默认 list 层（工具栏+列表），树不在窄档渲染", async () => {
    stubMatchMedia(true);
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    expect(container.querySelector('[data-testid="files-mobile-tabs"]')).toBeNull();
    const stack = q(container, '[data-testid="files-narrow-stack"]');
    expect(stack.getAttribute("data-level")).toBe("list");
    // 树不在窄档渲染：无树容器也无树行
    expect(container.querySelector('[data-testid="files-tree-pane"]')).toBeNull();
    expect(stack.querySelector("[data-testid^='tree-row-']")).toBeNull();
    // 工具栏经窄栈 toolbar 槽位渲染，列表行可见
    expect(q(stack, '[data-testid="files-toolbar-new-file"]')).not.toBeNull();
    expect(q(stack, '[data-testid="files-row-alpha.md"]')).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  test("文件行点击推入 preview 层并拉取内容；返回钮回 list；重按同一行再次推入（openSeq 回归）", async () => {
    stubMatchMedia(true);
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="files-row-alpha.md"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-narrow-stack"]').getAttribute("data-level")).toBe("preview");
    expect(calls.file.some((c) => c.project === "/data/proj-a" && c.path === "alpha.md")).toBe(true);
    expect(q(container, '[data-testid="files-preview-pane"]').textContent).toContain("alpha.md");
    // 返回钮：dismissed 置位回 list 层
    await act(async () => {
      q(container, '[data-testid="files-narrow-stack-back"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-narrow-stack"]').getAttribute("data-level")).toBe("list");
    // 重按同一行：openSeq 自增换新复合键 => 再次推入（若忘记自增则停在 list，本断言变红）
    await act(async () => {
      q(container, '[data-testid="files-row-alpha.md"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-narrow-stack"]').getAttribute("data-level")).toBe("preview");
    await act(async () => {
      root.unmount();
    });
  });

  test("面包屑导航：目录行进入子目录，点根段回跳根列表", async () => {
    stubMatchMedia(true);
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="files-row-docs"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-narrow-stack"]').getAttribute("data-level")).toBe("list");
    expect(calls.tree.some((c) => c.path === "docs")).toBe(true);
    expect(q(container, '[data-testid="files-row-readme.md"]')).not.toBeNull();
    await act(async () => {
      q(container, '[data-testid="files-breadcrumb-root"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-row-alpha.md"]')).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  test("X1：preview 层切项目 → 重挂载回 list 层，无残留预览", async () => {
    stubMatchMedia(true);
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    await act(async () => {
      q(container, '[data-testid="files-row-alpha.md"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-narrow-stack"]').getAttribute("data-level")).toBe("preview");
    // 切项目：changeProject 清 dir/selected + key={project} 重挂载窄栈（dismissed 不跨项目残留）
    const select = q(container, '[data-testid="files-project-select"]') as HTMLSelectElement;
    await act(async () => {
      select.value = "/data/proj-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-narrow-stack"]').getAttribute("data-level")).toBe("list");
    expect(container.querySelector('[data-testid="files-narrow-stack-preview"]')).toBeNull();
    expect(container.querySelector('[data-testid="file-preview"]')).toBeNull();
    expect(calls.tree.some((c) => c.project === "/data/proj-b" && c.path === "")).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });

  test("宽→窄转换落在最深活动层：未选→list；选中→preview；编辑→edit", async () => {
    // 桌面挂载（beforeEach 已 stub false）
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    // 未选：跨到窄档 → list 层
    await fireViewport(true);
    expect(q(container, '[data-testid="files-narrow-stack"]').getAttribute("data-level")).toBe("list");
    // 回宽档选中文件（预览落在右栏），再跨窄档 → preview 层
    await fireViewport(false);
    await act(async () => {
      q(container, '[data-testid="files-row-alpha.md"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(q(container, '[data-testid="files-preview-pane"]').textContent).toContain("alpha.md");
    await fireViewport(true);
    expect(q(container, '[data-testid="files-narrow-stack"]').getAttribute("data-level")).toBe("preview");
    // 回宽档进入编辑（FilePreview 拉完后编辑钮可用），再跨窄档 → edit 层
    await fireViewport(false);
    await waitFor(() => container.querySelector('[data-testid="files-edit-button"]') !== null, "edit button");
    await act(async () => {
      q(container, '[data-testid="files-edit-button"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await fireViewport(true);
    const stack = q(container, '[data-testid="files-narrow-stack"]');
    expect(stack.getAttribute("data-level")).toBe("edit");
    expect(q(container, '[data-testid="files-narrow-stack-edit"]')).not.toBeNull();
    // 编辑层无窄栈返回钮（返回语义由 FileEditor 自带 onBack 承担）
    expect(container.querySelector('[data-testid="files-narrow-stack-back"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
});


describe("files-ux-revamp 任务 6：噪音目录切换（独立文件页）", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  function noiseClick(el: HTMLElement): Promise<void> {
    return act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  test("树默认隐藏根层与深层噪音目录，工具栏切换即时生效且零新树请求", async () => {
    const origRoot = TREE_FIXTURE[""];
    const origDocs = TREE_FIXTURE.docs;
    TREE_FIXTURE[""] = [
      { name: "node_modules", type: "directory", size: null, mtime: 1700000000000 },
      { name: ".git", type: "directory", size: null, mtime: 1700000000000 },
      ...origRoot,
    ];
    TREE_FIXTURE.docs = [{ name: "node_modules", type: "directory", size: null, mtime: 1700000000000 }];
    try {
      const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
      const { container, root } = await mountPage(calls);
      expect(container.querySelector('[data-testid="tree-row-node_modules"]')).toBeNull();
      expect(container.querySelector('[data-testid="tree-row-.git"]')).toBeNull();
      // 展开深层同样被过滤
      await noiseClick(q(container, '[data-testid="tree-row-docs"]'));
      expect(container.querySelector('[data-testid="tree-row-docs/node_modules"]')).toBeNull();
      // 工具栏开关翻转：即时生效，不发出任何新树请求
      const callsBefore = calls.tree.length;
      const btn = q(container, '[data-testid="files-toggle-hidden"]');
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      await noiseClick(btn);
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(calls.tree.length).toBe(callsBefore);
      expect(q(container, '[data-testid="tree-row-node_modules"]')).toBeTruthy();
      expect(q(container, '[data-testid="tree-row-docs/node_modules"]')).toBeTruthy();
      expect(window.localStorage.getItem("ul-omo-webui:files:show-hidden")).toBe("1");
      await act(async () => {
        root.unmount();
      });
    } finally {
      TREE_FIXTURE[""] = origRoot;
      TREE_FIXTURE.docs = origDocs;
    }
  });

  test("localStorage 记忆跨重挂载回读（默认关 → 置 1 → 重挂载为开）", async () => {
    const calls: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const { container, root } = await mountPage(calls);
    expect(q(container, '[data-testid="files-toggle-hidden"]').getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      root.unmount();
    });
    window.localStorage.setItem("ul-omo-webui:files:show-hidden", "1");
    const calls2: Calls = { tree: [], file: [], failTree: false, failProjects: false };
    const m2 = await mountPage(calls2);
    expect(q(m2.container, '[data-testid="files-toggle-hidden"]').getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      m2.root.unmount();
    });
  });
});
