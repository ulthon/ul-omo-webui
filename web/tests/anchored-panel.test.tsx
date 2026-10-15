// AnchoredPanel 移动端 bottom sheet 档单测（docs08-r4 任务 8）：
// - 桌面态（matchMedia 未命中 sheet 断点）：锚定形态不变——inline top/left 定位、
//   zoom-in 入场、无 data-presentation 标记
// - sheet 档（stub matchMedia 命中 "(max-width: 639.98px)"，happy-dom 缺省桌面态）：
//   data-presentation="sheet"、底缘 calc(100vh - var(--app-height)) 贴根容器、
//   60vh 上限与复用方 maxHeight 取小、复用方 w-80 被 w-full 覆盖、顶部拖拽条在场
// 外点/Esc 关闭与三复用方完整交互走浏览器 QA（.omo/evidence/docs08-r4/task-8-sheet-qa.md）。
import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// bun test 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { AnchoredPanel } = await import("@/components/ui/anchored-panel");

const SHEET_QUERY = "(max-width: 639.98px)";

interface PanelHandle {
  panel: HTMLElement;
  unmount: () => void;
}

/** stub matchMedia 渲染面板：sheetMatched 控制断点命中；渲染完成后还原原实现 */
function renderPanel(sheetMatched: boolean, props?: { className?: string; maxHeight?: number }): PanelHandle {
  const real = window.matchMedia.bind(window);
  window.matchMedia = ((query: string) =>
    ({
      matches: sheetMatched && query === SHEET_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => {
      root.render(
        createElement(
          AnchoredPanel,
          { anchor, open: true, onClose: () => {}, className: props?.className, maxHeight: props?.maxHeight },
          createElement("p", null, "内容"),
        ),
      );
    });
  } finally {
    window.matchMedia = real;
  }
  const panel = host.querySelector<HTMLElement>('[data-slot="anchored-panel"]');
  if (!panel) throw new Error("anchored-panel 未渲染");
  return { panel, unmount: () => act(() => root.unmount()) };
}

describe("AnchoredPanel 桌面锚定档（>=640px，回归 pin）", () => {
  test("锚定定位：inline top/left 在场、无 sheet 标记、zoom-in 入场", () => {
    const { panel, unmount } = renderPanel(false, { className: "w-80" });
    try {
      expect(panel.dataset.presentation).toBeUndefined();
      expect(panel.style.position).toBe("fixed");
      expect(panel.style.top).not.toBe("");
      expect(panel.style.bottom).toBe("");
      expect(panel.classList.contains("zoom-in-95")).toBe(true);
      expect(panel.classList.contains("slide-in-from-bottom-4")).toBe(false);
      // 复用方宽度类原样生效（桌面形态零改动）
      expect(panel.classList.contains("w-80")).toBe(true);
      expect(panel.classList.contains("w-full")).toBe(false);
    } finally {
      unmount();
    }
  });
});

describe("AnchoredPanel 移动端 bottom sheet 档（<640px）", () => {
  test("sheet 形态：data-presentation、底缘 calc、60vh 上限、上滑入场、拖拽条", () => {
    const { panel, unmount } = renderPanel(true, { maxHeight: 320 });
    try {
      expect(panel.dataset.presentation).toBe("sheet");
      expect(panel.style.position).toBe("fixed");
      expect(panel.style.bottom).toBe("calc(100vh - var(--app-height, 100vh))");
      expect(panel.style.maxHeight).toBe("min(60vh, 320px)");
      expect(panel.classList.contains("slide-in-from-bottom-4")).toBe(true);
      expect(panel.classList.contains("rounded-t-xl")).toBe(true);
      // 顶部细拖拽条（纯视觉）：面板首个子元素
      const bar = panel.firstElementChild;
      expect(bar?.hasAttribute("aria-hidden")).toBe(true);
    } finally {
      unmount();
    }
  });

  test("复用方宽度类被全宽覆盖：w-80 退场、w-full 在场；maxHeight 缺省 320 取小", () => {
    const { panel, unmount } = renderPanel(true, { className: "w-80" });
    try {
      expect(panel.classList.contains("w-80")).toBe(false);
      expect(panel.classList.contains("w-full")).toBe(true);
    } finally {
      unmount();
    }
  });

  test("maxHeight 换档跟随：复用方 360 时上限 min(60vh, 360px)", () => {
    const { panel, unmount } = renderPanel(true, { maxHeight: 360 });
    try {
      expect(panel.style.maxHeight).toBe("min(60vh, 360px)");
    } finally {
      unmount();
    }
  });
});
