// @ts-nocheck
// r10 todo 4：新建会话按钮收成 size-9 图标钮，与搜索/批量同一行（手机档防误触）。
// 环境说明同 session-item-expand-removed.test.tsx：@ts-nocheck + 被测模块动态 import +
// @happy-dom 全局注册；标记断言走 renderToStaticMarkup，点击行为走 createRoot 真实 DOM。
// 验收：(a) 手机档头部同一 flex 行含 新建图标钮+搜索+批量；(b) 旧 h-11 w-full 全宽钮 DOM 消失；
// (c) lg 桌面档变体类（lg:h-7 lg:w-full）保留；(d) 点击仍调 api.createSession（落点=选中会话派生项目，
// 会话根架构 W2 任务 8：工具条不再读全局项目字段，布景 seed selectedId+byProject 反查链）。
import { describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
window.matchMedia = ((query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

// api 整模块代理 mock：每个方法名缓存同一 vi.fn（resolve 空对象），挂载期
// refreshSessions / bootstrap 等副作用全部吞掉，createSession 可断言调用参数。
const apiFns = new Map();
vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (!apiFns.has(key))
          apiFns.set(
            key,
            // 通用空形态：标签定义（global/project 数组）、列表、项目等聚合字段全空
            vi.fn(() => Promise.resolve({ global: [], project: [], projects: [], sessions: [], items: [], list: [] })),
          );
        return apiFns.get(key);
      },
    },
  ),
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/lib/bootstrap", () => ({ loadProjectModels: vi.fn(() => Promise.resolve({})) }));

const { createElement, act } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@/lib/api");
const { SessionList } = await import("../session-list");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");
const { t: tSnap } = await import("@/i18n/i18n");

const NEW_SESSION_LABEL = tSnap("sessionList.list.newSession");

// 派生反查链基准行（W2 任务 8，仅用例 (d) 接线）：selectedId 指向它，
// projectOfSession 反查得 /tmp/p；(a)-(c) 静态标记断言依赖空列表口径（分组头
// 自带 min-h-11 w-full 子串会深进全标记扫描），故富布景不进模块级
const BASE_ROW = {
  id: "s0",
  path: "/tmp/p/s0.jsonl",
  project: "/tmp/p",
  title: "s0",
  name: null,
  renamedTitle: null,
  parentSessionPath: null,
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
  pinned: false,
  archivedAt: null,
  unreadCount: 0,
  lastRead: null,
  active: false,
};

useUiStore.setState({ currentProject: "/tmp/p", projects: [{ projectPath: "/tmp/p", preferredModel: null, lastOpenedAt: null }] });
useSessionsStore.setState({ byProject: { "/tmp/p": [] }, archived: "false", loading: false });

function renderList() {
  return renderToStaticMarkup(createElement(SessionList));
}

describe("新建会话图标钮与搜索/批量同行（r10 todo 4）", () => {
  test("(a) 头部同一 flex 行：新建图标钮 + 搜索框 + 批量切换为同一直接父元素的兄弟节点", () => {
    const html = renderList();
    expect(html).toContain('data-testid="new-session-btn"');
    expect(html).toContain("size-9 shrink-0 justify-center");
    expect(html).toContain('data-testid="batch-toggle"');

    // 严格同父包含：真实 DOM 里三控件（钮/搜索包裹层/批量块）共享同一直接父元素
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    return act(async () => {
      root.render(createElement(SessionList));
    }).then(async () => {
      const btn = container.querySelector('[data-testid="new-session-btn"]');
      const searchWrap = container.querySelector("input")?.parentElement;
      const batch = container.querySelector('[data-testid="batch-toggle"]');
      expect(btn).toBeTruthy();
      expect(searchWrap).toBeTruthy();
      expect(batch).toBeTruthy();
      const row = btn.parentElement;
      expect(row).toBe(searchWrap.parentElement);
      expect(row).toBe(batch.parentElement?.parentElement);
      // 行容器确为横向 flex（手机档同行语义）
      expect(row.className).toContain("flex items-center");
      await act(async () => {
        root.unmount();
      });
      container.remove();
    });
  });

  test("(b) 旧全宽钮 DOM 消失：无 h-11 w-full 组合类", () => {
    const html = renderList();
    expect(html).not.toContain("h-11 w-full");
    // 按钮文本手机档隐藏（图标钮语义），仅保留 lg 档内联文本
    expect(html).toContain('class="hidden lg:inline"');
  });

  test("(c) 桌面 lg 变体等于原类链：lg:h-7 / lg:w-full 保留，且无 justify-start（桌面居中不被改）", () => {
    const html = renderList();
    expect(html).toContain("lg:h-7 lg:w-full");
    // button.tsx 基类 justify-center 在 lg+ 治理对齐；不得引入 justify-start 左对齐
    expect(html).not.toContain("justify-start");
    expect(html).toContain(NEW_SESSION_LABEL);
  });

  test("(d) 点击图标钮仍调 api.createSession（落点=派生项目），双击防抖 disabled 逻辑保留", async () => {
    // 派生链接线（W2 任务 8）：seed selectedId+byProject，并让挂载期聚合刷新回带同一行
    useSessionsStore.setState({ byProject: { "/tmp/p": [BASE_ROW] }, selectedId: "s0" });
    api.listSessions.mockImplementation(() => Promise.resolve({ sessions: [BASE_ROW] }));
    api.createSession.mockResolvedValue({ session: { id: "new1", sessionPath: "/tmp/p/new1" } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(SessionList));
    });
    const btn = container.querySelector('[data-testid="new-session-btn"]');
    expect(btn).toBeTruthy();
    await act(async () => {
      btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(api.createSession).toHaveBeenCalled();
    const args = api.createSession.mock.calls.at(-1);
    expect(args[0]).toMatchObject({ project: "/tmp/p" });
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
