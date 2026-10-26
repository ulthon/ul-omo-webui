// 右栏「总览」页签测试（r9 w2-t8）：
// - 无持久化页签偏好时默认选中总览，四块（任务/笔记/统计/子代理）渲染
// - 有存量偏好时尊重存量不覆盖；切换页签写回同一键（读写一致）
// - 四块各自空态文案（sessionId 为 null 档）
// 环境说明同 right-rail-drawer-close.test.tsx：@happy-dom/global-registrator +
// createRoot + act，matchMedia 用 stub 控制视口档位。
// @ts-nocheck
import { describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// bun/vitest 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { RightRail } = await import("@/components/layout/right-rail");

const TAB_PREF_KEY = "ul-omo-webui:right-rail-tab";

interface Handle {
  host: HTMLElement;
  q: (selector: string) => HTMLElement | null;
  qa: (selector: string) => HTMLElement[];
  switchTab: (id: string) => void;
  unmount: () => void;
}

function renderRail(): Handle {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(RightRail, {
        open: true,
        onToggle: () => {},
        sessionId: null,
      }),
    );
  });
  return {
    host,
    q: (selector: string) => host.querySelector<HTMLElement>(selector),
    qa: (selector: string) => Array.from(host.querySelectorAll<HTMLElement>(selector)),
    switchTab: (id: string) => {
      const tab = host.querySelector<HTMLElement>(`[data-testid="right-rail-tab-${id}"]`);
      if (!tab) throw new Error(`页签 ${id} 未渲染`);
      act(() => {
        tab.click();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function selectedTab(): string | null {
  const el = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  return el?.getAttribute("data-testid")?.replace("right-rail-tab-", "") ?? null;
}

describe("右栏总览页签（r9 w2-t8）", () => {
  test("无持久化偏好：默认选中总览且四块渲染", () => {
    window.localStorage.removeItem(TAB_PREF_KEY);
    const h = renderRail();
    try {
      expect(selectedTab()).toBe("overview");
      expect(h.q('[data-testid="overview-panel"]')).not.toBeNull();
      expect(h.q('[data-testid="overview-tasks"]')).not.toBeNull();
      expect(h.q('[data-testid="overview-notes"]')).not.toBeNull();
      expect(h.q('[data-testid="overview-stats"]')).not.toBeNull();
      expect(h.q('[data-testid="overview-agents"]')).not.toBeNull();
      // 独立页签仍在且可切
      expect(h.q('[data-testid="right-rail-tab-todo"]')).not.toBeNull();
    } finally {
      h.unmount();
    }
  });

  test("有存量偏好：尊重存量；切换页签写回同一键", () => {
    window.localStorage.setItem(TAB_PREF_KEY, "todo");
    const h = renderRail();
    try {
      expect(selectedTab()).toBe("todo");
      expect(h.q('[data-testid="overview-panel"]')).toBeNull();
      // 切到 stats：写回偏好，重读一致（stale state 对抗口径）
      h.switchTab("stats");
      expect(selectedTab()).toBe("stats");
      expect(window.localStorage.getItem(TAB_PREF_KEY)).toBe("stats");
    } finally {
      h.unmount();
    }
  });

  test("存量偏好为总览：持久化值也被尊重", () => {
    window.localStorage.setItem(TAB_PREF_KEY, "overview");
    const h = renderRail();
    try {
      expect(selectedTab()).toBe("overview");
      expect(h.q('[data-testid="overview-panel"]')).not.toBeNull();
    } finally {
      h.unmount();
    }
  });

  test("四块空态文案（未选会话 / 未选项目）", () => {
    window.localStorage.removeItem(TAB_PREF_KEY);
    const h = renderRail();
    try {
      // 任务块：未选择会话
      expect(h.q('[data-testid="overview-tasks"]')!.textContent).toContain("未选择会话");
      // 笔记块：未添加项目
      expect(h.q('[data-testid="overview-notes"]')!.textContent).toContain("请先添加项目");
      // 统计块：未选择会话
      expect(h.q('[data-testid="overview-stats"]')!.textContent).toContain("未选择会话");
      // 子代理块：未选择会话
      expect(h.q('[data-testid="overview-agents"]')!.textContent).toContain("未选择会话");
    } finally {
      h.unmount();
    }
  });
});
