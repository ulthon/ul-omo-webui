/**
 * 手机顶栏最近会话切换（docs08-r6 任务 15 → 任务 19 迁移为全屏 sheet）：
 * - 手机档（<lg）中槽点按会话身份区开全屏会话切换 sheet（Radix Dialog，portal 渲染，
 *   断言查 document 而非挂载容器）；派生复用侧栏最近区同一来源
 *   recentTop(flattenSessions(byProject))（跨项目 modified 降序前 8 条）
 * - 条目点击直达切换：跨项目路径完整断言两步——setCurrentProject（项目切换）+
 *   setSelectedModel（应用该项目偏好模型，模型列表按需补拉）；同项目仅选中；
 *   选中后 sheet 关闭（条件渲染 DOM 卸载）
 * - 空态：无任何会话时显示「暂无会话」
 * - 桌面档断言不变：中槽仍是项目下拉（项目菜单 + 添加项目入口），无最近会话内容，
 *   sheet 不渲染
 * 走真实组件（happy-dom + react-dom/client，project-removal 惯例）；radix
 * DropdownMenu 原语 mock 为透传容器（onSelect 映射 onClick，桌面分支仍在用），
 * Radix Dialog 用真实原语，api 层 mock fetch。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

// bun test 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// radix DropdownMenu 原语透传化：Root 渲染 children，Content 内联展开，
// Item 将 onSelect 映射为 onClick（透传 data-testid 等透传属性）
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

/** 微任务冲刷（loadProjectModels 为异步 fetch 链） */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 任务 19：点身份区触发钮开全屏 sheet（portal 内容查 document） */
async function openSheet(container: HTMLElement): Promise<void> {
  const trigger = container.querySelector('[data-testid="mobile-session-identity"]') as HTMLElement | null;
  if (!trigger) throw new Error("missing mobile-session-identity trigger");
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function sheetItems(): Element[] {
  return [...document.querySelectorAll('[data-testid="sheet-session-item"]')];
}

async function clickItem(id: string): Promise<void> {
  const item = document.querySelector(`[data-testid="sheet-session-item"][data-session-id="${id}"]`) as HTMLElement | null;
  if (!item) throw new Error(`missing sheet row ${id}`);
  await act(async () => {
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

describe("手机顶栏最近会话切换（任务 15 → 任务 19 全屏 sheet）", () => {
  test("点按身份区开 sheet：条目按 modified 降序、超 8 条截断、无项目菜单入口", async () => {
    const byProject = {
      "/p1": [
        makeSession("a1", { modified: "2026-01-03T00:00:00.000Z" }),
        makeSession("a2", { modified: "2026-01-01T00:00:00.000Z" }),
      ],
      "/p2": [
        makeSession("b1", { project: "/p2", modified: "2026-01-05T00:00:00.000Z" }),
        makeSession("b2", { project: "/p2", modified: "2026-01-04T00:00:00.000Z" }),
        ...Array.from({ length: 7 }, (_, i) =>
          makeSession(`x${i}`, { project: "/p2", modified: `2026-01-02T0${i}:00:00.000Z` }),
        ),
      ],
    };
    useUiStore.setState({ projects: [project("/p1"), project("/p2")], currentProject: "/p1" });
    useSessionsStore.setState({ byProject, selectedId: null });

    const container = await mountTopbar();
    expect(container.querySelector('[data-testid="mobile-session-identity"]')).not.toBeNull();

    await openSheet(container);
    // 派生复用 recentTop：全仓 10 条只取前 8 条，按 modified 降序（b1 > b2 > a1 > x6..x0 > a2 截断）
    const items = sheetItems();
    expect(items).toHaveLength(8);
    expect(items[0].getAttribute("data-session-id")).toBe("b1");
    expect(items[0].textContent).toContain("会话-b1");
    expect(items[1].getAttribute("data-session-id")).toBe("b2");
    expect(items[2].getAttribute("data-session-id")).toBe("a1");

    // sheet 内容为最近会话；尾部「添加项目…」为任务4双入口之一（非项目分组菜单）
    const text = document.querySelector('[data-testid="session-switcher-sheet"]')?.textContent ?? "";
    expect(text).toContain("最近会话");
    expect(text).toContain("添加项目…");
    expect(text).not.toContain("尚无项目");
  });

  test("跨项目直达切换：选中 + 切项目 + 应用偏好模型（两步都发生）+ sheet 关闭", async () => {
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
    await openSheet(container);
    await clickItem("b1");
    await flush();

    const ui = useUiStore.getState();
    const sessions = useSessionsStore.getState();
    // 第一步：项目切换；第二步：偏好模型应用
    expect(ui.currentProject).toBe("/p2");
    expect(ui.selectedModel).toBe("prov/m2");
    expect(sessions.selectedId).toBe("b1");
    // 模型列表为空时按需补拉（轻量切换路径）
    expect(calls.some((c) => c.includes("/models"))).toBe(true);
    // 选中即关闭（任务 19）
    expect(document.querySelector('[data-testid="session-switcher-sheet"]')).toBeNull();
  });

  test("同项目点按仅选中：不切项目、不动偏好模型、不补拉模型", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).includes("/api/tags")) return okJson({ global: [], project: [] });
      return okJson({ models: [], favorites: [], defaults: null });
    }) as typeof fetch;

    useUiStore.setState({
      projects: [project("/p1", "prov/m1")],
      currentProject: "/p1",
      models: [],
      modelsLoaded: true,
      selectedModel: "prov/m1",
    });
    useSessionsStore.setState({
      byProject: { "/p1": [makeSession("a1"), makeSession("a2", { modified: "2026-01-02T00:00:00.000Z" })] },
      selectedId: "a1",
    });

    const container = await mountTopbar();
    await openSheet(container);
    await flush();
    await clickItem("a2");

    const ui = useUiStore.getState();
    expect(ui.currentProject).toBe("/p1");
    expect(ui.selectedModel).toBe("prov/m1");
    expect(useSessionsStore.getState().selectedId).toBe("a2");
    // 选中路径不发模型请求（sheet 打开期的 /api/tags 定义拉取与选中无关）
    expect(calls.some((c) => c.includes("/models"))).toBe(false);
  });

  test("空态：无任何会话显示「暂无会话」，无条目", async () => {
    useUiStore.setState({ projects: [project("/p1")], currentProject: "/p1" });
    useSessionsStore.setState({ byProject: {}, selectedId: null });

    const container = await mountTopbar();
    await openSheet(container);
    expect(sheetItems()).toHaveLength(0);
    expect(document.querySelector('[data-testid="session-switcher-sheet"]')?.textContent).toContain("暂无会话");
  });

  test("桌面档不变：中槽仍项目下拉（项目 + 添加项目入口），无最近会话内容与 sheet", async () => {
    stubMatchMedia(false);
    useUiStore.setState({
      projects: [project("/p1"), project("/p2")],
      currentProject: "/p1",
    });
    useSessionsStore.setState({
      byProject: {
        "/p1": [makeSession("a1", { modified: "2026-01-03T00:00:00.000Z" })],
        "/p2": [makeSession("b1", { project: "/p2", modified: "2026-01-04T00:00:00.000Z" })],
      },
      selectedId: null,
    });

    const container = await mountTopbar();
    // 手机档身份区与 sheet 不渲染（条件渲染，DOM 不存在）
    expect(container.querySelector('[data-testid="mobile-session-identity"]')).toBeNull();
    expect(document.querySelector('[data-testid="session-switcher-sheet"]')).toBeNull();
    expect(document.querySelector('[data-testid="sheet-session-item"]')).toBeNull();

    const text = container.textContent ?? "";
    // 桌面中槽：项目名触发钮 + 项目菜单 + 添加项目入口；无最近会话派生内容
    expect(text).toContain("p1");
    expect(text).toContain("项目");
    expect(text).toContain("添加项目…");
    expect(text).not.toContain("最近会话");
  });
});
