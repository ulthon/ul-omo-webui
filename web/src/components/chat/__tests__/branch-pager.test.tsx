// @ts-nocheck
// ‹n/m› 分支切换器单测（session-branching todo 5）：多兄弟渲染序位/单兄弟不渲染/
// 点击切兄弟回调带正确 id/流式禁用 no-op/兄弟序位文件序正确/44px 触控目标。
// 环境说明同 restore-digest-expand.test.tsx：@ts-nocheck + 动态 import +
// @happy-dom 全局注册 + createRoot + dispatchEvent。
import { describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
vi.mock("@/i18n/i18n", () => ({ useT: () => (key: string) => key, useLocaleStore: () => "zh-CN" }));

const { BranchPager } = await import("@/components/chat/branch-pager");
const { deriveSiblingPositions } = await import("@/components/chat/branch-path-data");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

function mount(props: Record<string, unknown>): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(BranchPager, props));
  });
  return host;
}

function click(host: HTMLElement, selector: string) {
  act(() => {
    host.querySelector(selector).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function entry(id, parentId) {
  return { type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text: id }] } };
}

describe("BranchPager（todo 5）", () => {
  test("(1) 多兄弟：第 2/3 位渲染 ‹2/3›，prev/next testid 在场", () => {
    const host = mount({ position: { index: 1, count: 3, prevId: "s1", nextId: "s3" } });
    expect(host.querySelector('[data-testid="branch-pager"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="branch-pager-position"]').textContent).toBe("2/3");
    expect(host.querySelector('[data-testid="branch-pager-prev"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="branch-pager-next"]')).not.toBeNull();
  });

  test("(2) 单兄弟（count<2）与 position 缺席：不渲染任何节点", () => {
    expect(mount({ position: { index: 0, count: 1, prevId: null, nextId: null } }).innerHTML).toBe("");
    expect(mount({ position: null }).innerHTML).toBe("");
    expect(mount({}).innerHTML).toBe("");
  });

  test("(3) 点击 prev/next 调 onSwitchSibling 且带正确兄弟 id", () => {
    const calls = [];
    const host = mount({
      position: { index: 1, count: 3, prevId: "s1", nextId: "s3" },
      onSwitchSibling: (id) => calls.push(id),
    });
    click(host, '[data-testid="branch-pager-prev"]');
    click(host, '[data-testid="branch-pager-next"]');
    expect(calls).toEqual(["s1", "s3"]);
  });

  test("(4) disabled（流式/运行/等待/导航中）：按钮 disabled 属性在场且点击 no-op", () => {
    const calls = [];
    const host = mount({
      position: { index: 1, count: 3, prevId: "s1", nextId: "s3" },
      disabled: true,
      onSwitchSibling: (id) => calls.push(id),
    });
    const prev = host.querySelector('[data-testid="branch-pager-prev"]');
    const next = host.querySelector('[data-testid="branch-pager-next"]');
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(true);
    click(host, '[data-testid="branch-pager-prev"]');
    click(host, '[data-testid="branch-pager-next"]');
    expect(calls).toEqual([]);
  });

  test("(5) 兄弟序位按 entries 文件序正确派生（含链中段与到头禁用位）", () => {
    const entries = [
      entry("u1", null),
      entry("a1", "u1"),
      entry("u2", "a1"), // a1 的第 1 兄弟
      entry("u2x", "a1"), // 第 2
      entry("u2y", "a1"), // 第 3
      entry("a2", "u2"),
    ];
    const positions = deriveSiblingPositions(entries);
    expect(positions.get("u2")).toEqual({ index: 0, count: 3, prevId: null, nextId: "u2x" });
    expect(positions.get("u2x")).toEqual({ index: 1, count: 3, prevId: "u2", nextId: "u2y" });
    expect(positions.get("u2y")).toEqual({ index: 2, count: 3, prevId: "u2x", nextId: null });
    // 单兄弟与链外条目不入映射
    expect(positions.has("u1")).toBe(false);
    expect(positions.has("a2")).toBe(false);
  });

  test("(6) 移动档触控目标：prev/next 按钮 44px（h-11 w-11）类断言", () => {
    const host = mount({ position: { index: 0, count: 2, prevId: null, nextId: "b" } });
    const prev = host.querySelector('[data-testid="branch-pager-prev"]');
    const next = host.querySelector('[data-testid="branch-pager-next"]');
    for (const btn of [prev, next]) {
      expect(btn.className).toContain("h-11");
      expect(btn.className).toContain("w-11");
    }
  });

  test("(7) 到头箭头禁用（prevId null / nextId null），另一侧仍可点", () => {
    const calls = [];
    const host = mount({
      position: { index: 0, count: 2, prevId: null, nextId: "b" },
      onSwitchSibling: (id) => calls.push(id),
    });
    expect(host.querySelector('[data-testid="branch-pager-prev"]').disabled).toBe(true);
    expect(host.querySelector('[data-testid="branch-pager-next"]').disabled).toBe(false);
    click(host, '[data-testid="branch-pager-next"]');
    expect(calls).toEqual(["b"]);
  });
});
