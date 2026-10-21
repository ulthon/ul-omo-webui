// 右栏手机抽屉关闭口单测（docs08-r6 任务 19e，修复 F3 F-C 抽屉困局）：
// - 非 Tasks 页签（Agents 为代表）：头部关闭钮 / Escape / 背板点击三条路径均触发 onToggle
// - 背板仅抽屉打开时渲染，且 lg:hidden（桌面布局零改动）
// - Escape 仅手机视口生效（matchMedia lg 命中时不关闭——桌面档行为不变）
// 环境说明同 anchored-panel.test.tsx：@happy-dom/global-registrator + createRoot + act，
// matchMedia 用 stub 控制视口档位。
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

const LG_QUERY = "(min-width: 1024px)";

/** stub matchMedia：desktopMatched 控制 lg 断点命中；渲染完成后还原原实现 */
function stubMatchMedia(desktopMatched: boolean): () => void {
  const real = window.matchMedia.bind(window);
  window.matchMedia = ((query: string) =>
    ({
      matches: desktopMatched && query === LG_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = real;
  };
}

interface Handle {
  host: HTMLElement;
  /** onToggle 调用次数 */
  toggleCount: () => number;
  /** 切到指定页签（点击页签钮） */
  switchTab: (id: string) => void;
  q: (selector: string) => HTMLElement | null;
  pressEscape: () => void;
  unmount: () => void;
}

function renderRail(open: boolean, desktopMatched: boolean): Handle {
  const restore = stubMatchMedia(desktopMatched);
  const pressStub = () => stubMatchMedia(desktopMatched);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let toggles = 0;
  try {
    act(() => {
      root.render(
        createElement(RightRail, {
          open,
          onToggle: () => {
            toggles += 1;
          },
          sessionId: null,
        }),
      );
    });
  } finally {
    restore();
  }
  return {
    host,
    toggleCount: () => toggles,
    switchTab: (id: string) => {
      const tab = host.querySelector<HTMLElement>(`[data-testid="right-rail-tab-${id}"]`);
      if (!tab) throw new Error(`页签 ${id} 未渲染`);
      act(() => {
        tab.click();
      });
    },
    q: (selector: string) => host.querySelector<HTMLElement>(selector),
    pressEscape: () => {
      pressStub();
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("手机抽屉全页签关闭口（F-C 修复）", () => {
  test("Agents 页签：关闭钮在场，点击触发 onToggle", () => {
    const h = renderRail(true, false);
    try {
      h.switchTab("agents");
      const close = h.q('[data-testid="right-rail-drawer-close"]');
      expect(close).not.toBeNull();
      expect(close!.getAttribute("aria-label")).toBe("收起右栏");
      act(() => {
        close!.click();
      });
      expect(h.toggleCount()).toBe(1);
    } finally {
      h.unmount();
    }
  });

  test("Agents 页签：Escape 关闭（手机视口）", () => {
    const h = renderRail(true, false);
    try {
      h.switchTab("agents");
      h.pressEscape();
      expect(h.toggleCount()).toBe(1);
    } finally {
      h.unmount();
    }
  });

  test("背板点击关闭；背板仅打开时渲染", () => {
    const h = renderRail(true, false);
    try {
      h.switchTab("agents");
      const backdrop = h.q('[data-testid="right-rail-drawer-backdrop"]');
      expect(backdrop).not.toBeNull();
      expect(backdrop!.classList.contains("lg:hidden")).toBe(true);
      act(() => {
        backdrop!.click();
      });
      expect(h.toggleCount()).toBe(1);
    } finally {
      h.unmount();
    }
  });

  test("抽屉关闭态：背板不渲染，Escape 不触发", () => {
    const h = renderRail(false, false);
    try {
      expect(h.q('[data-testid="right-rail-drawer-backdrop"]')).toBeNull();
      h.pressEscape();
      expect(h.toggleCount()).toBe(0);
    } finally {
      h.unmount();
    }
  });

  test("桌面视口（lg 命中）：Escape 不关闭（桌面行为不变）", () => {
    const h = renderRail(true, true);
    try {
      expect(h.q('[data-testid="right-rail"]')).not.toBeNull();
      h.pressEscape();
      expect(h.toggleCount()).toBe(0);
    } finally {
      h.unmount();
    }
  });
});
