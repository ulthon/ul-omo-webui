// @ts-nocheck
// 添加项目入口双端就近重设计（会话根架构 W3 任务 13）：composer-mobile-layout 惯例——
// @happy-dom 全局注册 + createRoot/act 真实点击。覆盖：
// (1) 侧栏列表（桌面侧栏与手机抽屉共用组件）新增双行入口：手机档分组区头部行 +
//     桌面档分组列表尾部行（lg 断点类互斥显隐），点击后 AddProjectDialog 真实打开；
// (2) 零项目空态：列表区渲染居中 CTA（图标+添加项目+提示），点击打开同弹窗；
// (3) 手机顶栏会话切换 sheet 不再渲染底部添加项目钮（入口已迁抽屉分组区头部）；
// (4) 设置页添加项目入口已移除，项目管理列表本体保留。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ProjectManagementSection } = await import("@/pages/settings");
const { Topbar } = await import("@/components/layout/topbar");
const { SessionList } = await import("@/components/session-list/session-list");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");

const TOPBAR_MOBILE_QUERY = "(max-width: 1023.98px)";
const REAL_MATCH_MEDIA = window.matchMedia.bind(window);
const ORIGINAL_FETCH = globalThis.fetch;

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

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/** 静态微任务排空（SessionList 挂载即拉聚合列表，空响应同步 resolve 足够） */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function mockEmptyFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/sessions")) return okJson({ project: null, archived: "false", sessions: [] });
    if (url.includes("/api/tags")) return okJson({ global: [], project: [] });
    return okJson({ ok: true });
  }) as typeof fetch;
}

async function mountSessionList(): Promise<HTMLElement> {
  mockEmptyFetch();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SessionList));
  });
  await act(async () => {
    await flush();
  });
  return container;
}

async function unmountRoot(root: ReturnType<typeof createRoot>): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

beforeEach(() => {
  useUiStore.setState({ projects: [], currentProject: null });
  useSessionsStore.setState({ byProject: {}, selectedId: null });
  stubMatchMedia(true);
});

afterEach(() => {
  window.matchMedia = REAL_MATCH_MEDIA;
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("任务13 添加项目入口双端就近", () => {
  test("侧栏列表双行入口：手机档分组区头部 + 桌面档分组列表尾部，点击后弹窗打开", async () => {
    useUiStore.setState({
      projects: [{ projectPath: "/p1", preferredModel: null, lastOpenedAt: "2026-01-01T00:00:00.000Z" }],
    });
    const container = await mountSessionList();
    const mobile = container.querySelector('[data-testid="sidebar-add-project-mobile"]') as HTMLElement | null;
    const desktop = container.querySelector('[data-testid="sidebar-add-project-desktop"]') as HTMLElement | null;
    expect(mobile).not.toBeNull();
    expect(desktop).not.toBeNull();
    // 位置契约：手机行在分组区头部（分组头之前），桌面行在分组列表尾部（分组头之后）
    const firstGroup = container.querySelector('[data-project-group="/p1"]');
    expect(firstGroup).not.toBeNull();
    expect(container.contains(mobile!) && (mobile!.compareDocumentPosition(firstGroup!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    expect(container.contains(desktop!) && (desktop!.compareDocumentPosition(firstGroup!) & Node.DOCUMENT_POSITION_PRECEDING) !== 0).toBe(true);
    // 触控目标：min-h-11（44px）；两端互斥显隐经 lg 断点类
    expect(mobile!.className).toContain("min-h-11");
    expect(mobile!.className).toContain("lg:hidden");
    expect(desktop!.className).toContain("min-h-11");
    expect(desktop!.className).toContain("hidden");
    expect(desktop!.className).toContain("lg:flex");
    expect(mobile!.textContent).toContain("添加项目");
    // 点击真实打开 AddProjectDialog
    await act(async () => {
      mobile!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent ?? "").toContain("添加项目");
  });

  test("零项目空态：居中 CTA（图标+添加项目+提示）替代空白列表，点击打开弹窗", async () => {
    const container = await mountSessionList();
    const cta = container.querySelector('[data-testid="zero-project-cta"]') as HTMLElement | null;
    expect(cta).not.toBeNull();
    expect(cta?.querySelector("svg.lucide-folder-plus")).not.toBeNull();
    expect(cta?.textContent).toContain("添加项目");
    const add = container.querySelector('[data-testid="zero-project-add"]') as HTMLElement | null;
    expect(add).not.toBeNull();
    await act(async () => {
      add!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent ?? "").toContain("添加项目");
  });

  test("手机顶栏会话切换 sheet 不再渲染底部添加项目钮（仅保留会话列表）", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Topbar, { onToggleTodoPanel: () => {} }));
    });
    const trigger = container.querySelector('[data-testid="mobile-session-identity"]') as HTMLElement;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const sheet = document.querySelector('[data-testid="session-switcher-sheet"]');
    expect(sheet).not.toBeNull();
    // 旧 sheet 尾部入口移除：测试锚点与 footer 元素均不存在
    expect(document.querySelector('[data-testid="mobile-add-project"]')).toBeNull();
    expect(sheet?.querySelector("footer")).toBeNull();
    // sheet 会话列表本体保留
    expect(document.querySelector('[data-testid="session-switcher-sheet-list"]')).not.toBeNull();
    await unmountRoot(root);
  });

  test("设置页添加项目入口已移除，项目管理列表本体保留", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ProjectManagementSection));
    });
    expect(container.querySelector('[data-testid="project-add-button"]')).toBeNull();
    // 管理列表语义仍在（头部「项目管理」与隐藏/恢复/移除动作不受影响）
    expect(container.querySelector('[data-testid="project-visibility-filter"]')).not.toBeNull();
    await unmountRoot(root);
  });
});
