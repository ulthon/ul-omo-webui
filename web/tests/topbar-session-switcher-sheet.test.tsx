/**
 * 手机档会话切换全屏 sheet（docs08-r7 任务 19）：topbar-mobile-recent 惯例——
 * @happy-dom 全局注册 + createRoot/act 真实渲染（Radix Dialog 用真实原语，
 * DropdownMenu mock 为透传容器——桌面分支仍在用）。
 * 覆盖：(1) 顶栏触发钮开全屏 sheet（fullscreen-sheet 呈现 + 头部标题/关闭钮）；
 * (2) 行=标题(text-base font-medium)+项目名副行+标签徽标（两源定义键集驱动）；
 * (3) 选中即应用且 sheet 关闭；(4) Esc 关闭；(5) 空列表空态不崩；(6) 尾部添加项目入口。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

// bun test 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// 桌面分支的 DropdownMenu 原语透传化（sheet 本体用真实 Radix Dialog，不 mock）
vi.mock("@/components/ui/dropdown-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Trigger = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Item = ({
    onSelect,
    children,
    ...rest
  }: {
    onSelect?: () => void;
    children?: React.ReactNode;
  } & Record<string, unknown>) => (
    <div role="menuitem" onClick={onSelect} {...rest}>
      {children}
    </div>
  );
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Trigger,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: Item,
    DropdownMenuLabel: Passthrough,
    DropdownMenuSeparator: Passthrough,
  };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { Topbar } = await import("@/components/layout/topbar");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");

const ORIGINAL_FETCH = globalThis.fetch;
const TOPBAR_MOBILE_QUERY = "(max-width: 1023.98px)";
const REAL_MATCH_MEDIA = window.matchMedia.bind(window);

function stubMatchMedia(mobile: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: mobile && query === TOPBAR_MOBILE_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

function makeSession(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    path: `/store/${id}.jsonl`,
    project: "/p1",
    title: `会话-${id}`,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hi",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
    ...overrides,
  };
}

function project(path: string, preferredModel: string | null = null) {
  return { projectPath: path, preferredModel, lastOpenedAt: "2026-01-01T00:00:00.000Z" };
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

async function mountTopbar(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Topbar, { onToggleTodoPanel: () => {} }));
  });
  return container;
}

/** 微任务冲刷（listTags fetch 链 + setDefinedKeys 重渲染） */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openSheetViaTrigger(container: HTMLElement): Promise<void> {
  const trigger = container.querySelector('[data-testid="mobile-session-identity"]') as HTMLElement | null;
  if (!trigger) throw new Error("missing mobile-session-identity trigger");
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function sheetRoot(): Element | null {
  return document.querySelector('[data-testid="session-switcher-sheet"]');
}

function sheetItems(): Element[] {
  return [...document.querySelectorAll('[data-testid="sheet-session-item"]')];
}

async function clickRow(id: string): Promise<void> {
  const row = document.querySelector(`[data-testid="sheet-session-item"][data-session-id="${id}"]`) as HTMLElement | null;
  if (!row) throw new Error(`missing sheet row ${id}`);
  await act(async () => {
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  stubMatchMedia(true);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  window.matchMedia = REAL_MATCH_MEDIA;
  document.body.innerHTML = "";
});

describe("手机档会话切换全屏 sheet（任务 19）", () => {
  test("触发钮开全屏 sheet：fullscreen-sheet 呈现、头部标题「会话」+关闭钮、Esc 关闭", async () => {
    useUiStore.setState({ projects: [project("/p1")], currentProject: "/p1" });
    useSessionsStore.setState({ byProject: { "/p1": [makeSession("a1")] }, selectedId: "a1" });

    const container = await mountTopbar();
    expect(sheetRoot()).toBeNull();

    await openSheetViaTrigger(container);
    const sheet = sheetRoot();
    expect(sheet).not.toBeNull();
    // 全屏页呈现档 + 铺满视口（fixed inset-0），非 60vh 底部贴条
    expect(sheet?.getAttribute("data-presentation")).toBe("fullscreen-sheet");
    expect(sheet?.className).toContain("inset-0");
    expect(sheet?.getAttribute("role")).toBe("dialog");
    // 头部：标题「会话」+ 关闭钮（size-11 触控达标）
    expect(sheet?.querySelector("h2")?.textContent).toContain("会话");
    const close = document.querySelector('[data-testid="session-switcher-sheet-close"]') as HTMLElement | null;
    expect(close).not.toBeNull();
    expect(close?.getAttribute("aria-label")).toContain("关闭");

    // Esc 关闭（Dialog 原语承担焦点陷阱与 Esc 语义）
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(sheetRoot()).toBeNull();
  });

  test("行=标题(text-base font-medium)+项目名副行+标签徽标（定义键集就绪后可见）", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/tags")) {
        return okJson({ global: [{ name: "重点", sort: 0 }], project: [] });
      }
      return okJson({ models: [], favorites: [], defaults: null });
    }) as typeof fetch;

    useUiStore.setState({ projects: [project("/p1")], currentProject: "/p1" });
    useSessionsStore.setState({
      byProject: {
        "/p1": [makeSession("a1", { tags: [{ scope: "global", name: "重点" }] })],
        "/p2": [makeSession("b1", { project: "/p2", modified: "2026-01-02T00:00:00.000Z" })],
      },
      selectedId: null,
    });

    const container = await mountTopbar();
    await openSheetViaTrigger(container);
    await flush();
    await flush();

    const rows = sheetItems();
    expect(rows).toHaveLength(2);
    const row = document.querySelector('[data-testid="sheet-session-item"][data-session-id="b1"]') as HTMLElement;
    // 标题 ≥16px：text-base + font-medium 类在标题节点上
    const title = row.querySelector(".text-base.font-medium");
    expect(title?.textContent).toContain("会话-b1");
    // 项目名副行（归属可辨）：跨项目行显示所属项目 basename
    expect(row.textContent).toContain("p2");
    // 标签徽标：文字形态（任务 20 色格升级发生在 tag-badge 内部，此处 slot 复用）；
    // 无标签行不渲染徽标容器
    const badgedRow = document.querySelector('[data-testid="sheet-session-item"][data-session-id="a1"]') as HTMLElement;
    const badge = badgedRow.querySelector('[data-testid="tag-badge"][data-tag="重点"]');
    expect(badge).not.toBeNull();
    expect(row.querySelector('[data-testid="tag-badges"]')).toBeNull();
  });

  test("点行即应用且关闭：跨项目切项目+偏好模型，sheet 从 DOM 卸载", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).includes("/api/tags")) return okJson({ global: [], project: [] });
      return okJson({ models: [], favorites: [], defaults: null });
    }) as typeof fetch;

    useUiStore.setState({
      projects: [project("/p1"), project("/p2", "prov/m2")],
      currentProject: "/p1",
      models: [],
      modelsLoaded: true,
      selectedModel: "prov/m1",
    });
    useSessionsStore.setState({
      byProject: { "/p2": [makeSession("b1", { project: "/p2" })] },
      selectedId: "a0",
    });

    const container = await mountTopbar();
    await openSheetViaTrigger(container);
    await flush();
    await clickRow("b1");
    await flush();

    const ui = useUiStore.getState();
    expect(ui.currentProject).toBe("/p2");
    expect(ui.selectedModel).toBe("prov/m2");
    expect(useSessionsStore.getState().selectedId).toBe("b1");
    expect(calls.some((c) => c.includes("/models"))).toBe(true);
    // 选中即关闭：sheet 卸载（条件渲染，DOM 不存在）
    expect(sheetRoot()).toBeNull();
  });

  test("空列表空态不崩：显示「暂无会话」，零行，尾部仍可添加项目", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/tags")) return okJson({ global: [], project: [] });
      return okJson({ models: [], favorites: [], defaults: null });
    }) as typeof fetch;

    useUiStore.setState({ projects: [project("/p1")], currentProject: "/p1" });
    useSessionsStore.setState({ byProject: {}, selectedId: null });

    const container = await mountTopbar();
    await openSheetViaTrigger(container);
    await flush();

    expect(sheetItems()).toHaveLength(0);
    expect(document.querySelector('[data-testid="session-switcher-sheet-list"]')?.textContent).toContain("暂无会话");

    // 尾部添加项目入口仍在（任务 4 双入口之一在 sheet 形态下保持可达）
    const add = document.querySelector('[data-testid="mobile-add-project"]') as HTMLElement | null;
    expect(add).not.toBeNull();
    expect(add?.textContent).toContain("添加项目…");
    let addCalled = false;
    add?.addEventListener("click", () => {
      addCalled = true;
    });
    await act(async () => {
      add?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(addCalled).toBe(true);
  });
});
