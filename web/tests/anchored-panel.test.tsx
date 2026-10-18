// AnchoredPanel 三档单测（docs08-r4 任务 8 + docs08-r5 任务 7）：
// - 桌面态（matchMedia 未命中 sheet 断点）：锚定形态不变——inline top/left 定位、
//   zoom-in 入场、无 data-presentation 标记；mobilePresentation 不影响桌面（零改动）
// - sheet 档（stub matchMedia 命中 "(max-width: 639.98px)"，happy-dom 缺省桌面态）：
//   data-presentation="sheet"、底缘 calc(100vh - var(--app-height)) 贴根容器、
//   60vh 上限与复用方 maxHeight 取小、复用方 w-80 被 w-full 覆盖、顶部拖拽条在场
// - inline 档（r5 任务 7，mobilePresentation="inline"）：流内渲染——非 fixed 无定位
//   值、maxHeight 直接生效、w-full 覆盖复用方宽度、桌面同款视觉语言（圆角/边框/影）；
//   开合语义（Esc/外点/锚豁免）与另两档一致
// 三复用方完整交互走浏览器 QA（r4：.omo/evidence/docs08-r4/task-8-sheet-qa.md；
// r5 任务 7：.omo/evidence/docs08-r5/task-7-*.md）。
import { describe, expect, test } from "vitest";
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
  /** 锚元素（外点豁免断言用） */
  anchor: HTMLElement;
  /** onClose 调用次数（外点/Esc 语义断言用） */
  onCloseCount: () => number;
  unmount: () => void;
}

/** stub matchMedia 渲染面板：sheetMatched 控制断点命中；渲染完成后还原原实现 */
function renderPanel(
  sheetMatched: boolean,
  props?: { className?: string; maxHeight?: number; mobilePresentation?: "sheet" | "inline" },
): PanelHandle {
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
  let onCloseCalls = 0;
  try {
    act(() => {
      root.render(
        createElement(
          AnchoredPanel,
          {
            anchor,
            open: true,
            onClose: () => {
              onCloseCalls += 1;
            },
            className: props?.className,
            maxHeight: props?.maxHeight,
            mobilePresentation: props?.mobilePresentation,
          },
          createElement("p", null, "内容"),
        ),
      );
    });
  } finally {
    window.matchMedia = real;
  }
  const panel = host.querySelector<HTMLElement>('[data-slot="anchored-panel"]');
  if (!panel) throw new Error("anchored-panel 未渲染");
  return { panel, anchor, onCloseCount: () => onCloseCalls, unmount: () => act(() => root.unmount()) };
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

describe("AnchoredPanel 移动端 inline 档（<640px + mobilePresentation=\"inline\"，docs08-r5 任务 7）", () => {
  test("流内形态：data-presentation=inline、非 fixed 无定位值、maxHeight 直接生效、w-full 覆盖复用方宽度、桌面同款视觉语言", () => {
    const { panel, unmount } = renderPanel(true, { className: "w-80", maxHeight: 320, mobilePresentation: "inline" });
    try {
      expect(panel.dataset.presentation).toBe("inline");
      // 非 fixed：不走定位（流内），无 top/bottom 定位值
      expect(panel.style.position).not.toBe("fixed");
      expect(panel.style.top).toBe("");
      expect(panel.style.bottom).toBe("");
      // maxHeight 直接生效（内容区内部滚动），非 sheet 的 min(60vh, N)
      expect(panel.style.maxHeight).toBe("320px");
      expect(panel.style.width).toBe("100%");
      // 复用方宽度类被覆盖，w-full 在场
      expect(panel.classList.contains("w-80")).toBe(false);
      expect(panel.classList.contains("w-full")).toBe(true);
      // 与桌面档同视觉语言：圆角/边框（ring）/影；入场仅 fade（无 sheet 上滑 / 桌面 zoom）
      expect(panel.classList.contains("rounded-lg")).toBe(true);
      expect(panel.classList.contains("ring-1")).toBe(true);
      expect(panel.classList.contains("shadow-md")).toBe(true);
      expect(panel.classList.contains("zoom-in-95")).toBe(false);
      expect(panel.classList.contains("slide-in-from-bottom-4")).toBe(false);
      // 无 sheet 顶部拖拽条：首子元素即内容
      expect(panel.firstElementChild?.tagName).toBe("P");
    } finally {
      unmount();
    }
  });

  test("桌面断点未命中时 mobilePresentation 不生效：仍走锚定档（桌面零改动）", () => {
    const { panel, unmount } = renderPanel(false, { mobilePresentation: "inline" });
    try {
      expect(panel.dataset.presentation).toBeUndefined();
      expect(panel.style.position).toBe("fixed");
    } finally {
      unmount();
    }
  });

  test("开合语义与另两档一致：Esc 关闭、外点关闭、锚（textarea）豁免与面板内点击不关闭", () => {
    const { panel, anchor, onCloseCount, unmount } = renderPanel(true, { mobilePresentation: "inline" });
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(onCloseCount()).toBe(1);
      const outsider = document.createElement("div");
      document.body.appendChild(outsider);
      outsider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(onCloseCount()).toBe(2);
      // 锚豁免保留：textarea 点击不关闭
      anchor.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(onCloseCount()).toBe(2);
      // 面板内点击不关闭
      panel.querySelector("p")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(onCloseCount()).toBe(2);
      outsider.remove();
    } finally {
      unmount();
    }
  });
});
