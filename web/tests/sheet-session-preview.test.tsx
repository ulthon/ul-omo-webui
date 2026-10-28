// @ts-nocheck
// r10 todo 8：切换 sheet 最后消息预览。
// 环境同 topbar-mobile-declutter.test.tsx：@ts-nocheck + 动态 import + @happy-dom。
// 验收：(a) sheet 行渲染 preview 文本（单行截断）；(b) 空 preview 不渲染空行；
//       (c) 点击行仍切换会话（select 行为保持）；(d) 桌面会话列表不出现预览。
import { describe, expect, test, vi, beforeEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

let mobileMatches = true;
window.matchMedia = ((query: string) =>
  ({
    matches: mobileMatches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

const apiFns = new Map();
vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (!apiFns.has(key))
          apiFns.set(
            key,
            vi.fn(() =>
              Promise.resolve({
                global: [],
                project: [],
                projects: [],
                sessions: [],
                items: [],
                list: [],
                usage: {},
              }),
            ),
          );
        return apiFns.get(key);
      },
    },
  ),
  ApiError: class ApiError extends Error {},
  shortModelName: (m: string) => m,
}));
vi.mock("@/lib/bootstrap", () => ({ loadProjectModels: vi.fn(() => Promise.resolve({})) }));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Topbar, SessionSwitcherSheet } = await import("@/components/layout/topbar");
const { AppSidebar } = await import("@/pages/shell");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");

const ROW_BASE = {
  path: "/x/s.jsonl",
  project: "/tmp/p",
  name: null,
  renamedTitle: null,
  parentSessionPath: null,
  created: "",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "",
  pinned: false,
  archivedAt: null,
  unreadCount: 0,
  lastRead: null,
  active: false,
  runState: "idle",
};

function setSessionRows(rows) {
  useUiStore.setState({
    currentProject: "/tmp/p",
    projects: [{ projectPath: "/tmp/p", preferredModel: null, lastOpenedAt: null }],
    models: [],
    modelsLoaded: false,
    selectedModel: null,
    drawerOpen: false,
    settingsPageOpen: false,
    filesPageOpen: false,
    connection: "online",
  });
  useSessionsStore.setState({
    byProject: { "/tmp/p": rows },
    selectedId: rows[0]?.id ?? null,
    archived: "false",
    loading: false,
    runStates: {},
    appliedModels: {},
  });
}

async function mount(ui) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  await act(async () => {});
  return { container, root };
}

beforeEach(() => {
  document.body.innerHTML = "";
  apiFns.clear();
});

describe("切换 sheet 最后消息预览", () => {
  test("sheet 行渲染 preview 文本；点击行仍切换会话并关 sheet", async () => {
    setSessionRows([
      { ...ROW_BASE, id: "s1", title: "会话一", preview: "最后一条消息文本" },
    ]);
    const selectSpy = vi.spyOn(useSessionsStore.getState(), "select");
    const onOpenChange = vi.fn();
    const { container } = await mount(
      createElement(SessionSwitcherSheet, {
        open: true,
        onOpenChange,
        onAddProject: () => {},
      }),
    );
    const previews = document.querySelectorAll('[data-testid="sheet-session-preview"]');
    expect(previews).toHaveLength(1);
    expect(previews[0].textContent).toBe("最后一条消息文本");
    // 单行截断样式（truncate）
    expect(previews[0].className).toContain("truncate");
    // 点击行仍切换会话（既有行为保持）并关 sheet
    const row = document.querySelector('[data-testid="sheet-session-item"]');
    await act(async () => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(selectSpy).toHaveBeenCalledWith("s1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("空 preview 不渲染空行", async () => {
    setSessionRows([{ ...ROW_BASE, id: "s2", title: "空会话", preview: "" }]);
    const { container } = await mount(
      createElement(SessionSwitcherSheet, { open: true, onOpenChange: () => {}, onAddProject: () => {} }),
    );
    expect(document.querySelectorAll('[data-testid="sheet-session-preview"]')).toHaveLength(0);
    // 行本身仍在（可点击切换）
    expect(document.querySelectorAll('[data-testid="sheet-session-item"]')).toHaveLength(1);
  });

  test("顶栏手机档打开 sheet 预览可见；桌面档不出现预览", async () => {
    setSessionRows([{ ...ROW_BASE, id: "s3", title: "会话三", preview: "手机预览" }]);
    const { container } = await mount(createElement(Topbar, { onToggleTodoPanel: () => {} }));
    await act(async () => {
      container
        .querySelector('[data-testid="mobile-session-identity"]')
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(document.querySelectorAll('[data-testid="sheet-session-preview"]')).toHaveLength(1);

    // 桌面档：同一批数据渲染侧栏会话列表，不出现 sheet 预览
    document.body.innerHTML = "";
    mobileMatches = false;
    const desktop = await mount(createElement(AppSidebar, {}));
    expect(desktop.container.querySelectorAll('[data-testid="sheet-session-preview"]')).toHaveLength(0);
    mobileMatches = true;
  });
});
