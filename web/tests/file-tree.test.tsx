// @ts-nocheck
// FileTree 组件接入 headless controller（files-ux-revamp 任务 2）组件级单测。
// 惯例同 files-ops.test.tsx：@happy-dom 全局注册 + createRoot/act 真实点击，
// api 层走 recording fetch（自控模式）或注入 fetch（受控模式）。
// 覆盖计划验收：自控模式行为不变（挂载拉根、展开懒加载、文件上抛、重挂载新态）；
// 受控模式走 controller.toggleDir；reveal 滚动（scrollIntoView 双 rAF 后调用）；
// 高亮 flash 不碰 aria-selected；DOM 契约钉住（file-tree / tree-row-* / aria-*）。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FileTree } = await import("@/components/file-tree/file-tree");
const { useFileTreeController } = await import("@/components/file-tree/file-tree-controller");

const ORIGINAL_FETCH = globalThis.fetch;

const PROJECT = "/data/proj-a";

const TREE_FIXTURE: Record<string, Array<{ name: string; type: string; size: number | null; mtime: number | null }>> = {
  "": [
    { name: "docs", type: "directory", size: null, mtime: 1700000000000 },
    { name: "alpha.txt", type: "file", size: 10, mtime: 1700000000000 },
  ],
  docs: [{ name: "sub", type: "directory", size: null, mtime: 1700000000000 }],
  "docs/sub": [{ name: "file.txt", type: "file", size: 3, mtime: 1700000000000 }],
};

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/** 注入用 fetcher：记录每次取层路径，回放 TREE_FIXTURE */
function makeRecordingFetch(treeCalls: string[]) {
  return async (path?: string): Promise<unknown> => {
    const p = path ?? "";
    treeCalls.push(p);
    return { project: PROJECT, path: p, entries: TREE_FIXTURE[p] ?? [] };
  };
}

/** 自控模式用：接管全局 fetch 只处理 /api/fs/tree，记录路径 */
function installGlobalTreeFetch(treeCalls: string[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/fs/tree")) {
      const qs = new URL(url, "http://localhost").searchParams;
      treeCalls.push(qs.get("path") ?? "");
      const p = (qs.get("path") ?? "").replace(/\/+$/, "");
      return okJson({ project: qs.get("project"), path: qs.get("path"), entries: TREE_FIXTURE[p] ?? [] });
    }
    return okJson({});
  }) as typeof fetch;
}

function q(container: Element, selector: string): HTMLElement {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  return el as HTMLElement;
}

function click(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

interface Mounted {
  container: HTMLElement;
  root: { unmount: () => Promise<void> };
}

async function mountSelfControlled(props: {
  selectedPath?: string | null;
  onSelect?: (path: string) => void;
} = {}): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(FileTree, {
      project: PROJECT,
      selectedPath: props.selectedPath ?? null,
      onSelect: props.onSelect ?? (() => {}),
    }));
  });
  return { container, root };
}

/** 受控模式宿主：持有 hook 返回的 controller，经 onReady 上抛最新实例 */
function ControllerHarness(props: {
  fetch: (path?: string) => Promise<unknown>;
  selectedPath?: string | null;
  onSelect?: (path: string) => void;
  onReady?: (ctl: { toggleDir: (p: string) => void; reveal: (p: string) => Promise<unknown> }) => void;
}) {
  const ctl = useFileTreeController(PROJECT, { fetch: props.fetch as never });
  props.onReady?.(ctl);
  return createElement(FileTree, {
    project: PROJECT,
    selectedPath: props.selectedPath ?? null,
    onSelect: props.onSelect ?? (() => {}),
    onDirectoryOpen: props.onDirectoryOpen,
    controller: ctl,
  });
}

async function mountControlled(props: Parameters<typeof ControllerHarness>[0]): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ControllerHarness, {
      ...props,
    } as never));
  });
  return { container, root };
}

/** flush 双 rAF 链（happy-dom 下 rAF 走定时器） */
async function flushRafs(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe("FileTree 自控模式（不传 controller）", () => {
  beforeEach(() => {
    installGlobalTreeFetch([]);
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    document.body.innerHTML = "";
  });

  test("挂载拉根目录、渲染 tree-row testid、文件点击上抛 onSelect", async () => {
    const treeCalls: string[] = [];
    installGlobalTreeFetch(treeCalls);
    const selected: string[] = [];
    const { container, root } = await mountSelfControlled({ onSelect: (p) => selected.push(p) });

    expect(treeCalls).toEqual([""]);
    expect(q(container, '[data-testid="file-tree"]')).toBeTruthy();
    expect(q(container, '[data-testid="tree-row-docs"]')).toBeTruthy();
    expect(q(container, '[data-testid="tree-row-alpha.txt"]')).toBeTruthy();

    await act(async () => {
      click(q(container, '[data-testid="tree-row-alpha.txt"]'));
    });
    expect(selected).toEqual(["alpha.txt"]);
    // 文件行没有 aria-expanded
    expect(q(container, '[data-testid="tree-row-alpha.txt"]').hasAttribute("aria-expanded")).toBe(false);
    await act(async () => {
      await root.unmount();
    });
  });

  test("目录点击展开懒加载（aria-expanded 翻转、子层请求发起、子行出现）", async () => {
    const treeCalls: string[] = [];
    installGlobalTreeFetch(treeCalls);
    const { container, root } = await mountSelfControlled();

    const docs = q(container, '[data-testid="tree-row-docs"]');
    expect(docs.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      click(docs);
    });
    expect(treeCalls).toEqual(["", "docs"]);
    expect(q(container, '[data-testid="tree-row-docs"]').getAttribute("aria-expanded")).toBe("true");
    expect(q(container, '[data-testid="tree-row-docs/sub"]')).toBeTruthy();

    await act(async () => {
      click(q(container, '[data-testid="tree-row-docs"]'));
    });
    expect(q(container, '[data-testid="tree-row-docs"]').getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="tree-row-docs/sub"]')).toBeNull();
    // 收起不重新拉取
    expect(treeCalls).toEqual(["", "docs"]);
    await act(async () => {
      await root.unmount();
    });
  });

  test("卸载重挂载 = 新态（file-picker 条件挂载语义不变）", async () => {
    const treeCalls: string[] = [];
    installGlobalTreeFetch(treeCalls);
    const first = await mountSelfControlled();
    await act(async () => {
      click(q(first.container, '[data-testid="tree-row-docs"]'));
    });
    expect(q(first.container, '[data-testid="tree-row-docs"]').getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      await first.root.unmount();
    });

    const second = await mountSelfControlled();
    // 新实例重新拉根，展开态归零
    expect(treeCalls).toEqual(["", "docs", ""]);
    expect(q(second.container, '[data-testid="tree-row-docs"]').getAttribute("aria-expanded")).toBe("false");
    expect(second.container.querySelector('[data-testid="tree-row-docs/sub"]')).toBeNull();
    await act(async () => {
      await second.root.unmount();
    });
  });
});

describe("FileTree 受控模式（controller 注入）", () => {
  beforeEach(() => {
    globalThis.fetch = okJson({}) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    document.body.innerHTML = "";
  });

  test("目录点击走 controller.toggleDir（fetch 记录 + 展开态），onSelect/onDirectoryOpen 同路径上抛", async () => {
    const treeCalls: string[] = [];
    const selected: string[] = [];
    const opened: string[] = [];
    const { container, root } = await mountControlled({
      fetch: makeRecordingFetch(treeCalls) as never,
      onSelect: (p) => selected.push(p),
      onDirectoryOpen: (p) => opened.push(p),
    });

    expect(treeCalls).toEqual([""]);
    await act(async () => {
      click(q(container, '[data-testid="tree-row-docs"]'));
    });
    expect(treeCalls).toEqual(["", "docs"]);
    expect(q(container, '[data-testid="tree-row-docs"]').getAttribute("aria-expanded")).toBe("true");
    expect(q(container, '[data-testid="tree-row-docs/sub"]')).toBeTruthy();
    expect(opened).toEqual(["docs"]);

    await act(async () => {
      click(q(container, '[data-testid="tree-row-alpha.txt"]'));
    });
    expect(selected).toEqual(["alpha.txt"]);
    await act(async () => {
      await root.unmount();
    });
  });

  test("受控模式回退 hook 静默：全局 fetch 零请求，仅控制器取数器发根加载（files-ux-revamp 任务 3 钉测）", async () => {
    let globalFetchCalls = 0;
    globalThis.fetch = (async () => {
      globalFetchCalls += 1;
      return okJson({});
    }) as typeof fetch;
    const treeCalls: string[] = [];
    const { container, root } = await mountControlled({
      fetch: makeRecordingFetch(treeCalls) as never,
    });
    expect(treeCalls).toEqual([""]);
    await act(async () => {
      click(q(container, '[data-testid="tree-row-docs"]'));
    });
    expect(treeCalls).toEqual(["", "docs"]);
    // hooks 规则下回退 hook 仍被无条件调用，但被静默取数器抑制：不向 api.fsTree
    // 发任何请求（若退化回直连 fetch，这里会是 2——挂载与展开各多发一次）
    expect(globalFetchCalls).toBe(0);
    await act(async () => {
      await root.unmount();
    });
  });

  test("契约钉：container/row testid 不变；selectedPath 仅该行 aria-selected=true", async () => {
    const { container, root } = await mountControlled({
      fetch: makeRecordingFetch([]) as never,
      selectedPath: "alpha.txt",
    });
    expect(q(container, '[data-testid="file-tree"]')).toBeTruthy();
    expect(q(container, '[data-testid="tree-row-alpha.txt"]').getAttribute("aria-selected")).toBe("true");
    expect(q(container, '[data-testid="tree-row-docs"]').hasAttribute("aria-selected")).toBe(false);
    await act(async () => {
      await root.unmount();
    });
  });

  test("reveal：逐段导航后目标行 scrollIntoView 被调用（双 rAF 后、视口居中）", async () => {
    const scrollCalls: Array<unknown[]> = [];
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement, ...args: unknown[]) {
      scrollCalls.push(args);
    };
    try {
      const treeCalls: string[] = [];
      let latest: { reveal: (p: string) => Promise<unknown> } | null = null;
      const { container, root } = await mountControlled({
        fetch: makeRecordingFetch(treeCalls) as never,
        onReady: (ctl) => {
          latest = ctl;
        },
      });
      expect(container.querySelector('[data-testid="tree-row-docs/sub/file.txt"]')).toBeNull();

      let result: unknown;
      await act(async () => {
        result = await latest!.reveal("docs/sub/file.txt");
      });
      expect(result).toEqual({ kind: "revealed", path: "docs/sub/file.txt" });
      // 途经目录已展开加载，目标行已在 DOM
      const target = q(container, '[data-testid="tree-row-docs/sub/file.txt"]');
      expect(target).toBeTruthy();
      await flushRafs();
      expect(scrollCalls.length).toBeGreaterThanOrEqual(1);
      expect(scrollCalls[0]).toEqual([{ block: "center" }]);
      await act(async () => {
        await root.unmount();
      });
    } finally {
      if (original) proto.scrollIntoView = original;
      else delete proto.scrollIntoView;
    }
  });

  test("高亮：reveal 命中行带 data-flash 高亮且不设置 aria-selected", async () => {
    let latest: { reveal: (p: string) => Promise<unknown> } | null = null;
    const { container, root } = await mountControlled({
      fetch: makeRecordingFetch([]) as never,
      onReady: (ctl) => {
        latest = ctl;
      },
    });
    await act(async () => {
      await latest!.reveal("docs/sub/file.txt");
    });
    const target = q(container, '[data-testid="tree-row-docs/sub/file.txt"]');
    expect(target.getAttribute("data-flash")).toBe("true");
    expect(target.className).toContain("ring-1");
    // 高亮不碰选中语义
    expect(target.hasAttribute("aria-selected")).toBe(false);
    await act(async () => {
      await root.unmount();
    });
  });
});
