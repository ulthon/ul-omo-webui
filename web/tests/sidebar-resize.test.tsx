// 左侧栏宽度拖拽与持久化单测（r9 2026-10-26 批次 w2-t7）：
// - 指针拖拽右缘手柄改宽度，拖动中实时钳制（240-480），pointerup 才写
//   localStorage ul-omo-webui:sidebar-width
// - 重载（重挂载）从持久层读回；异常值（越界/非数值）落回默认 288
// - 双击重置默认 288；键盘左右方向键 ±16px 即时记忆
// - 手机档（<lg）不受影响：手柄 hidden lg:block，抽屉 w-full 语义不变
// 场景走真实 AppSidebar（shell.tsx 导出，免拉起整页 AppShell），happy-dom +
// createRoot + act（right-rail-drawer-close.test.tsx 同款基建）；SessionList 挂载
// 的取数用 fetch stub 兜底。
// @ts-nocheck
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// bun/vitest 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { AppSidebar } = await import("@/pages/shell");
const {
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
} = await import("@/components/layout/sidebar-resize");

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  window.localStorage.clear();
  // SessionList 挂载取数兜底：全部回 200 空负载，不追求内容（本测只关心宽度）
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

interface Handle {
  host: HTMLElement;
  /** 当前宽度（aside 内联 CSS 变量 --sidebar-width 的 px 值） */
  width: () => number;
  handle: () => HTMLElement;
  /** 指针序列：down → 多次 move → up（坐标即 clientX，px） */
  drag: (xs: number[]) => void;
  /** 指针按下后 pointercancel（中断路径） */
  cancel: () => void;
  key: (key: string) => void;
  dblclick: () => void;
  unmount: () => void;
}

function firePointer(el: HTMLElement, type: string, x: number): void {
  const Ctor = (window as { PointerEvent?: typeof Event }).PointerEvent ?? window.MouseEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true, clientX: x });
  // happy-dom 的 PointerEvent 可能缺 pointerId，React 合成事件读原生值：补上
  Object.defineProperty(event, "pointerId", { value: 7 });
  el.dispatchEvent(event);
}

function mountSidebar(): Handle {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(AppSidebar, { drawerOpen: false }));
  });
  const aside = host.querySelector("aside") as HTMLElement;
  const handle = () => host.querySelector('[data-testid="sidebar-resize-handle"]') as HTMLElement;
  // happy-dom 未实现指针捕获接口时补空实现（组件仅用捕获语义，不依赖真实命中）
  const h = handle();
  h.setPointerCapture ??= () => {};
  h.releasePointerCapture ??= () => {};
  h.hasPointerCapture ??= () => true;
  return {
    host,
    width: () => {
      const raw = aside.style.getPropertyValue("--sidebar-width");
      return Number(raw.replace("px", ""));
    },
    handle,
    drag: (xs) => {
      act(() => firePointer(handle(), "pointerdown", xs[0]));
      for (const x of xs.slice(1)) act(() => firePointer(handle(), "pointermove", x));
      act(() => firePointer(handle(), "pointerup", xs[xs.length - 1]));
    },
    cancel: () => {
      act(() => firePointer(handle(), "pointerdown", 0));
      act(() => firePointer(handle(), "pointercancel", 0));
    },
    key: (key) => {
      act(() => {
        handle().dispatchEvent(
          new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      });
    },
    dblclick: () => {
      act(() => handle().dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })));
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("左侧栏宽度拖拽与持久化", () => {
  test("默认宽度 288 且无持久记录时读回默认", () => {
    const ui = mountSidebar();
    expect(ui.width()).toBe(SIDEBAR_WIDTH_DEFAULT);
    ui.unmount();
  });

  test("指针拖拽改宽度：右移变宽、左移变窄，pointerup 才落记忆", () => {
    const ui = mountSidebar();
    // 拖拽中（仅 move）不写记忆
    act(() => firePointer(ui.handle(), "pointerdown", 300));
    act(() => firePointer(ui.handle(), "pointermove", 340));
    expect(ui.width()).toBe(328);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();
    act(() => firePointer(ui.handle(), "pointerup", 340));
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("328");
    ui.unmount();
  });

  test("拖拽实时钳制 240-480 边界，越界拖动落记忆为边界值", () => {
    const ui = mountSidebar();
    ui.drag([0, 2000, 3000]); // 288 + 3000 远超上限
    expect(ui.width()).toBe(SIDEBAR_WIDTH_MAX);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_WIDTH_MAX));

    ui.drag([3000, 0, -3000]); // 从上限向左大幅拖拽越过下限
    expect(ui.width()).toBe(SIDEBAR_WIDTH_MIN);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_WIDTH_MIN));
    ui.unmount();
  });

  test("pointercancel 中断：不落记忆，宽度保持实时值", () => {
    const ui = mountSidebar();
    ui.cancel();
    expect(ui.width()).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();
    ui.unmount();
  });

  test("重载（重挂载）从持久层读回宽度", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "400");
    const ui = mountSidebar();
    expect(ui.width()).toBe(400);
    ui.unmount();
  });

  test("持久层异常值（越界/非数值）重载落回默认 288", () => {
    for (const bad of ["9999", "0", "abc", String(SIDEBAR_WIDTH_MIN - 1), String(SIDEBAR_WIDTH_MAX + 1)]) {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, bad);
      const ui = mountSidebar();
      expect(ui.width()).toBe(SIDEBAR_WIDTH_DEFAULT);
      ui.unmount();
    }
  });

  test("双击手柄重置默认 288 并落记忆", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "420");
    const ui = mountSidebar();
    ui.dblclick();
    expect(ui.width()).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_WIDTH_DEFAULT));
    ui.unmount();
  });

  test("键盘左右方向键 ±16px 即时记忆并钳制边界", () => {
    const ui = mountSidebar();
    ui.key("ArrowRight");
    expect(ui.width()).toBe(SIDEBAR_WIDTH_DEFAULT + 16);
    ui.key("ArrowLeft");
    ui.key("ArrowLeft");
    expect(ui.width()).toBe(SIDEBAR_WIDTH_DEFAULT - 16);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_WIDTH_DEFAULT - 16));
    // 钳制：连续右移越过上限
    for (let i = 0; i < 100; i += 1) ui.key("ArrowRight");
    expect(ui.width()).toBe(SIDEBAR_WIDTH_MAX);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_WIDTH_MAX));
    // 非方向键不生效
    ui.key("ArrowUp");
    expect(ui.width()).toBe(SIDEBAR_WIDTH_MAX);
    ui.unmount();
  });

  test("手机档不受影响：手柄 hidden lg:block（<lg 不渲染）且抽屉 w-full 语义保留", () => {
    const ui = mountSidebar();
    const cls = ui.handle().className;
    expect(cls).toContain("hidden");
    expect(cls).toContain("lg:block");
    const aside = ui.host.querySelector("aside") as HTMLElement;
    // 抽屉态类不变：w-full / z-40 / translate 形态未被宽度改造触碰
    expect(aside.className).toContain("w-full");
    expect(aside.className).toContain("z-40");
    expect(aside.className).toContain("-translate-x-full");
    ui.unmount();
  });
});
