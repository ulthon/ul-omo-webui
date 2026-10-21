// user 长消息折叠（docs08-r6 任务 14）单测：
// - 长文本（估算行数 > 3）：默认 line-clamp-3 收缩 + 展开钮（aria-expanded=false）
// - 短文本（含阈值边界）：无折叠类、无展开钮（threshold_flicker 负向）
// - 点击展开：aria-expanded=true、解除 clamp；再点收起：恢复收缩
// - 展开态不自动回缩：兄弟消息更新（重渲染）与虚拟列表卸载重挂载后仍展开（collapse_state_lost 负向）
// - 数据未截断：折叠态下 DOM 仍含完整文本（只截显示，data_truncated 负向）
// - assistant 长文本零折叠（assistant_folded 负向）：走 Markdown 分支，无 clamp 无钮
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");

import { EntryBubble } from "@/components/chat/message-bubble";
import { isLongUserText } from "@/components/chat/user-text-collapse";
import { useMessagesStore } from "@/stores/messages";
import { useLocaleStore } from "@/i18n/i18n";
import type { WireEntry } from "@/lib/api";

const CLEANUPS: Array<() => void> = [];

function mount(component: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(component);
  });
  CLEANUPS.push(() => act(() => root.unmount()));
  return container;
}

function setState(entries: WireEntry[]) {
  act(() => {
    useMessagesStore.setState({
      bySession: {
        s1: {
          entries,
          cursor: null,
          leafId: null,
          loaded: true,
          streaming: false,
          streamingMessage: null,
          streamingEntryId: null,
          toolRuns: {},
        },
      },
    });
  });
}

function userEntry(id: string, text: string): WireEntry & { id: string } {
  return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } };
}

/** ~160 中文字符的单段长文本（估算 4 行 > 3 行阈值） */
const LONG_TEXT = "长".repeat(160);
/** 阈值边界内文本（3 行 = 120 字符） */
const BOUNDARY_TEXT = "短".repeat(120);
/** 多行形态长文本：4 个换行段，每段不足一行 */
const MULTILINE_TEXT = Array.from({ length: 4 }, (_, i) => `第${i}段`).join("\n");

beforeEach(() => {
  act(() => {
    useMessagesStore.setState({ bySession: {}, replayRecovering: false });
    useLocaleStore.setState({ locale: "zh-CN" });
  });
});

afterEach(() => {
  for (const fn of CLEANUPS.splice(0)) fn();
  useMessagesStore.setState({ bySession: {} });
});

describe("isLongUserText 阈值", () => {
  test("短文本/边界内不折叠，超阈值与多行超行折叠", () => {
    expect(isLongUserText("你好")).toBe(false);
    expect(isLongUserText(BOUNDARY_TEXT)).toBe(false);
    expect(isLongUserText(LONG_TEXT)).toBe(true);
    expect(isLongUserText(MULTILINE_TEXT)).toBe(true);
    expect(isLongUserText("")).toBe(false);
  });
});

describe("user 长消息折叠", () => {
  test("长文本默认收缩：line-clamp-3 + 展开钮 aria-expanded=false，折叠态 DOM 含完整文本", () => {
    setState([userEntry("u1", LONG_TEXT)]);
    const c = mount(createElement(EntryBubble, { sessionId: "s1", entryId: "u1", interrupted: false }));
    const text = c.querySelector("[data-user-text]")!;
    expect(text.getAttribute("data-clamped")).toBe("");
    expect(text.className).toContain("line-clamp-3");
    // 数据未截断：只截显示，完整文本始终在 DOM
    expect(text.textContent).toBe(LONG_TEXT);
    const btn = c.querySelector<HTMLButtonElement>('[data-testid="user-text-toggle"]')!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.textContent).toBe("展开");
  });

  test("短文本零变化：无 clamp 类、无展开钮（含阈值边界）", () => {
    setState([userEntry("u2", BOUNDARY_TEXT)]);
    const c = mount(createElement(EntryBubble, { sessionId: "s1", entryId: "u2", interrupted: false }));
    const text = c.querySelector("[data-user-text]")!;
    expect(text.hasAttribute("data-clamped")).toBe(false);
    expect(text.className).not.toContain("line-clamp-3");
    expect(c.querySelector('[data-testid="user-text-toggle"]')).toBeNull();
  });

  test("点击展开：解除 clamp，aria-expanded=true 显示收起；再点收起恢复", () => {
    setState([userEntry("u3", LONG_TEXT)]);
    const c = mount(createElement(EntryBubble, { sessionId: "s1", entryId: "u3", interrupted: false }));
    let btn = c.querySelector<HTMLButtonElement>('[data-testid="user-text-toggle"]')!;
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const text = c.querySelector("[data-user-text]")!;
    expect(text.hasAttribute("data-clamped")).toBe(false);
    expect(text.className).not.toContain("line-clamp-3");
    expect(text.textContent).toBe(LONG_TEXT);
    btn = c.querySelector<HTMLButtonElement>('[data-testid="user-text-toggle"]')!;
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.textContent).toBe("收起");
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(c.querySelector("[data-user-text]")!.getAttribute("data-clamped")).toBe("");
  });

  test("展开态不自动回缩：兄弟消息更新重渲染与卸载重挂载后仍展开", () => {
    setState([userEntry("u4", LONG_TEXT)]);
    const c = mount(createElement(EntryBubble, { sessionId: "s1", entryId: "u4", interrupted: false }));
    const btn = c.querySelector<HTMLButtonElement>('[data-testid="user-text-toggle"]')!;
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 重渲染：追加兄弟条目（新数组引用触发订阅更新）
    setState([userEntry("u4", LONG_TEXT), userEntry("u5", "兄弟消息")]);
    expect(c.querySelector("[data-user-text]")!.hasAttribute("data-clamped")).toBe(false);
    // 虚拟列表卸载重挂载：展开态按 entryId 从模块级记录恢复
    for (const fn of CLEANUPS.splice(0)) fn();
    const c2 = mount(createElement(EntryBubble, { sessionId: "s1", entryId: "u4", interrupted: false }));
    expect(c2.querySelector("[data-user-text]")!.hasAttribute("data-clamped")).toBe(false);
    expect(c2.querySelector('[data-testid="user-text-toggle"]')!.getAttribute("aria-expanded")).toBe("true");
  });

  test("assistant 长文本零折叠：走 Markdown 分支，无 clamp、无展开钮", () => {
    setState([{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "答".repeat(500) }] } } as WireEntry & { id: string }]);
    const c = mount(createElement(EntryBubble, { sessionId: "s1", entryId: "a1", interrupted: false }));
    expect(c.querySelector("[data-user-text]")).toBeNull();
    expect(c.querySelector('[data-testid="user-text-toggle"]')).toBeNull();
    expect(c.innerHTML).not.toContain("line-clamp");
    expect(c.textContent).toContain("答".repeat(100));
  });
});
