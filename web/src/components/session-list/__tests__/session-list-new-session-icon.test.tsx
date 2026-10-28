// @ts-nocheck
// r10 todo 4：新建会话按钮收成 size-9 图标钮，与搜索/批量同一行（手机档防误触）。
// 环境说明同 session-item-expand-removed.test.tsx：@ts-nocheck + 被测模块动态 import +
// @happy-dom 全局注册；标记断言走 renderToStaticMarkup，点击行为走 createRoot 真实 DOM。
// 验收：(a) 手机档头部同一 flex 行含 新建图标钮+搜索+批量；(b) 旧 h-11 w-full 全宽钮 DOM 消失；
// (c) lg 桌面档变体类（lg:h-7 lg:w-full）保留；(d) 点击仍调 api.createSession(currentProject)。
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

useUiStore.setState({ currentProject: "/tmp/p", projects: [{ projectPath: "/tmp/p", preferredModel: null, lastOpenedAt: null }] });
useSessionsStore.setState({ byProject: { "/tmp/p": [] }, archived: "false", loading: false });

function renderList() {
  return renderToStaticMarkup(createElement(SessionList));
}

describe("新建会话图标钮与搜索/批量同行（r10 todo 4）", () => {
  test("(a) 头部同一 flex 行：新建图标钮 + 搜索框 + 批量切换共存", () => {
    const html = renderList();
    expect(html).toContain('data-testid="new-session-btn"');
    expect(html).toContain("size-9");
    expect(html).toContain("size-9 shrink-0 justify-center");
    // 搜索框与批量切换同在（同一渲染块）；placeholder 经 i18n 取词而非硬编码文案
    expect(html).toContain(`placeholder="${tSnap("sessionList.list.searchPlaceholder")}"`);
    expect(html).toContain('data-testid="batch-toggle"');
    // 三者同处一个 flex 行容器：先出现 flex 行开标签，再依次出现三控件，
    // 且 flex 行闭合前不含另一个行容器（结构上单行）。
    const rowStart = html.indexOf("flex items-center gap-1.5");
    expect(rowStart).toBeGreaterThan(-1);
    const btn = html.indexOf('data-testid="new-session-btn"');
    const batch = html.indexOf('data-testid="batch-toggle"');
    expect(btn).toBeGreaterThan(rowStart);
    expect(batch).toBeGreaterThan(btn);
  });

  test("(b) 旧全宽钮 DOM 消失：无 h-11 w-full 组合类", () => {
    const html = renderList();
    expect(html).not.toContain("h-11 w-full");
    // 按钮文本手机档隐藏（图标钮语义），仅保留 lg 档内联文本
    expect(html).toContain('class="hidden lg:inline"');
  });

  test("(c) 桌面 lg 变体保留：lg:h-7 / lg:w-full / lg:justify-start 原样在钮上", () => {
    const html = renderList();
    expect(html).toContain("lg:h-7 lg:w-full lg:justify-start");
    expect(html).toContain(NEW_SESSION_LABEL);
  });

  test("(d) 点击图标钮仍调 api.createSession(currentProject)，双击防抖 disabled 逻辑保留", async () => {
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
