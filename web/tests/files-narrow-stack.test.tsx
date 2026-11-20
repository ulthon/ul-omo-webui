// @ts-nocheck
// 窄档单列推入壳组件单测（files-ux-revamp 任务 4）。惯例同 files-ops.test.tsx：
// @happy-dom 全局注册 + createRoot/act 真实点击。壳组件为纯派生层级（无栈数组），
// 覆盖：list/preview/edit 三层渲染、返回钮 dismissed、selectionKey 换令牌重推回归、
// onBackGuard 只读返回不消费。
import { afterEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NarrowStack } = await import("@/components/files/narrow-stack");

const TEST_ID = "narrow-stack-test";

interface Harness {
  container: HTMLDivElement;
  render(props: Partial<Record<string, unknown>>): void;
  click(el: Element): void;
}

function makeHarness(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const base = {
    breadcrumb: createElement("nav", { "data-testid": "nb" }, "bc"),
    toolbar: createElement("div", { "data-testid": "ntb" }, "tb"),
    list: createElement("div", { "data-testid": "nl" }, "list"),
    preview: createElement("div", { "data-testid": "npv" }, "preview"),
    editing: false,
    selectionKey: null,
    onBackGuard: () => true,
    testId: TEST_ID,
  };
  return {
    container,
    render(props) {
      act(() => {
        root.render(createElement(NarrowStack, { ...base, ...props }));
      });
    },
    click(el) {
      act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

function levelEl(container: HTMLElement): Element | null {
  return container.querySelector(`[data-testid="${TEST_ID}"]`);
}

describe("NarrowStack 窄档推入壳", () => {
  test("1 无选中渲染 list 层（含 toolbar+breadcrumb+list，无 preview）", () => {
    const h = makeHarness();
    h.render({});
    const shell = levelEl(h.container);
    expect(shell).not.toBeNull();
    expect(shell!.getAttribute("data-level")).toBe("list");
    expect(h.container.querySelector('[data-testid="ntb"]')).not.toBeNull();
    expect(h.container.querySelector('[data-testid="nb"]')).not.toBeNull();
    expect(h.container.querySelector(`[data-testid="${TEST_ID}-list"]`)).not.toBeNull();
    expect(h.container.querySelector('[data-testid="npv"]')).toBeNull();
  });

  test("2 selectionKey 非空渲染 preview 层（返回钮带 zh aria）", async () => {
    const h = makeHarness();
    h.render({ selectionKey: "a.txt#1" });
    const shell = levelEl(h.container);
    expect(shell!.getAttribute("data-level")).toBe("preview");
    const back = h.container.querySelector(`[data-testid="${TEST_ID}-back"]`);
    expect(back).not.toBeNull();
    // zh 键值（setup-locale 下真实词条），而非硬编码文案快照
    const zhFiles = await import("@/i18n/zh/files");
    expect(back!.getAttribute("aria-label")).toBe(zhFiles.files.narrow.backAria);
    expect(h.container.querySelector('[data-testid="npv"]')).not.toBeNull();
  });

  test("3 返回钮点击后回 list 层（dismissed），preview 移除", () => {
    const h = makeHarness();
    h.render({ selectionKey: "a.txt#1" });
    const back = h.container.querySelector(`[data-testid="${TEST_ID}-back"]`)!;
    h.click(back);
    expect(levelEl(h.container)!.getAttribute("data-level")).toBe("list");
    expect(h.container.querySelector('[data-testid="npv"]')).toBeNull();
  });

  test("4 重开回归：同路径换令牌（a.txt#1 -> a.txt#2）重新推入 preview", () => {
    const h = makeHarness();
    h.render({ selectionKey: "a.txt#1" });
    h.click(h.container.querySelector(`[data-testid="${TEST_ID}-back"]`)!);
    expect(levelEl(h.container)!.getAttribute("data-level")).toBe("list");
    // 同一路径、宿主 openSeq 自增 => 新键引用 => dismissed 复位 => 再次预览
    h.render({ selectionKey: "a.txt#2" });
    expect(levelEl(h.container)!.getAttribute("data-level")).toBe("preview");
    expect(h.container.querySelector('[data-testid="npv"]')).not.toBeNull();
  });

  test("5 editing=true 渲染 edit 层（编辑槽可见）", () => {
    const h = makeHarness();
    h.render({ editing: true, selectionKey: "a.txt#1" });
    expect(levelEl(h.container)!.getAttribute("data-level")).toBe("edit");
    // 编辑层整层交给编辑槽（宿主经 preview 槽位传入 FileEditor），壳不加返回钮
    expect(h.container.querySelector('[data-testid="npv"]')).not.toBeNull();
    expect(h.container.querySelector(`[data-testid="${TEST_ID}-back"]`)).toBeNull();
    expect(h.container.querySelector(`[data-testid="${TEST_ID}-list"]`)).toBeNull();
  });

  test("6 预览返回点击不触发 onBackGuard（只读返回不消费守卫）", () => {
    const onBackGuard = vi.fn(() => true);
    const h = makeHarness();
    h.render({ selectionKey: "a.txt#1", onBackGuard });
    h.click(h.container.querySelector(`[data-testid="${TEST_ID}-back"]`)!);
    expect(onBackGuard).not.toHaveBeenCalled();
    expect(levelEl(h.container)!.getAttribute("data-level")).toBe("list");
  });

  test("7 selectionKey 回 null 渲染 list 层", () => {
    const h = makeHarness();
    h.render({ selectionKey: "a.txt#1" });
    expect(levelEl(h.container)!.getAttribute("data-level")).toBe("preview");
    h.render({ selectionKey: null });
    expect(levelEl(h.container)!.getAttribute("data-level")).toBe("list");
    expect(h.container.querySelector('[data-testid="npv"]')).toBeNull();
  });
});
