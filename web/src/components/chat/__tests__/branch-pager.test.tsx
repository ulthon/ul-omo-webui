// @ts-nocheck
// ‹n/m› 分支切换器单测（session-branching todo 5）：多兄弟渲染序位/单兄弟不渲染/
// 点击切兄弟回调带正确 id/流式禁用 no-op/兄弟序位文件序正确/44px 触控目标。
// task-10 缺陷 B 追加：真实引擎拓扑（navigate_tree 嫁接簿记链）下的生效父归一
// 派生——分支二/三也能出 ‹n/m›、簿记节点永不作序位、悬空父/环守卫收敛。
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

// ---------- task-10 缺陷 B：真实引擎拓扑的生效父归一 ----------

/** QA 实测拓扑原样复刻（task-10 证据 §2，会话 8b5c1d01）：引擎 navigate_tree(select)
 *  在目标父位（fork）嫁接 custom 簿记条目，分支二/三的 user 消息挂嫁接链之下
 *  （单子）而非直连 fork——裸 parentId 分组时分支二/三无兄弟组，‹n/m› 不渲染。 */
function bookkeeping(id, parentId) {
  return { type: "custom", id, parentId, customType: "navigate" };
}

function qaTopologyEntries() {
  return [
    entry("seed", null),
    entry("9c93d898", "seed"), // fork：assistant，3 子（u1 直挂 + 两条嫁接链）
    entry("f56a8b1b", "9c93d898"), // 分支一 user：直挂 fork
    entry("a-b1", "f56a8b1b"),
    bookkeeping("068d294c", "9c93d898"), // 嫁接链节点一（单子）
    entry("203f84ca", "068d294c"), // 分支二 user：挂嫁接链
    entry("a-b2", "203f84ca"),
    bookkeeping("a5da24ff", "9c93d898"), // 嫁接链节点二（单子）
    entry("a1d59f08", "a5da24ff"), // 分支三 user：挂嫁接链
    entry("a-b3", "a1d59f08"),
  ];
}

describe("兄弟序位归一（task-10 缺陷 B）", () => {
  test("(8) QA 实测拓扑：三分支各得 ‹1/3›/‹2/3›/‹3/3›，prev/next 链循环正确", () => {
    const positions = deriveSiblingPositions(qaTopologyEntries());
    // 分支一：首位于 3 兄弟，无前有后
    expect(positions.get("f56a8b1b")).toEqual({ index: 0, count: 3, prevId: null, nextId: "203f84ca" });
    // 分支二：中位，前后链齐备（QA 断言矩阵 d：切到分支二视图也应有 ‹2/3›）
    expect(positions.get("203f84ca")).toEqual({ index: 1, count: 3, prevId: "f56a8b1b", nextId: "a1d59f08" });
    // 分支三：末位，有前无后
    expect(positions.get("a1d59f08")).toEqual({ index: 2, count: 3, prevId: "203f84ca", nextId: null });
  });

  test("(9) 簿记节点永不作 pager 位：嫁接链/fork/单链 assistant 均不入序位映射", () => {
    const positions = deriveSiblingPositions(qaTopologyEntries());
    expect(positions.has("068d294c")).toBe(false); // 嫁接链节点一
    expect(positions.has("a5da24ff")).toBe(false); // 嫁接链节点二
    expect(positions.has("9c93d898")).toBe(false); // fork 本身（单子链）
    expect(positions.has("a-b1")).toBe(false); // 各分支 assistant（单子）
    expect(positions.has("a-b2")).toBe(false);
    expect(positions.has("a-b3")).toBe(false);
    expect(positions.has("seed")).toBe(false);
  });

  test("(10) 不可渲染条目不入组：fork 下另挂 tool 条目不改变兄弟计数", () => {
    const entries = [
      ...qaTopologyEntries(),
      { type: "tool_call", id: "tc1", parentId: "9c93d898", name: "bash" },
    ];
    const positions = deriveSiblingPositions(entries);
    expect(positions.get("203f84ca").count).toBe(3); // tool 不计入兄弟数
    expect(positions.has("tc1")).toBe(false); // tool 自身无序位
  });

  test("(11) 悬空簿记父：以悬空 id 为组键；同键消息仍聚组（未加载窗行为不变）", () => {
    // 祖先不在场（未加载窗/被压缩剪除）：上溯撞悬空即以该 id 为组键
    const dangling = [entry("x1", "ghost-graft"), entry("x2", "ghost-graft")];
    const positions = deriveSiblingPositions(dangling);
    expect(positions.get("x1")).toEqual({ index: 0, count: 2, prevId: null, nextId: "x2" });
    expect(positions.get("x2")).toEqual({ index: 1, count: 2, prevId: "x1", nextId: null });
  });

  test("(12) parentId 环守卫：簿记环上溯不死循环，收敛到根组", () => {
    const cyc = [
      bookkeeping("g1", "g2"),
      bookkeeping("g2", "g1"),
      entry("y1", "g1"),
      entry("y2", "g1"),
    ];
    const positions = deriveSiblingPositions(cyc); // 若无守卫此行死循环超时
    expect(positions.get("y1")).toEqual({ index: 0, count: 2, prevId: null, nextId: "y2" });
    expect(positions.has("g1")).toBe(false);
  });

  test("(13) 渲染面冒烟：QA 拓扑下分支二气泡渲染 ‹2/3›，prev/next 回调带正确兄弟 id", () => {
    const positions = deriveSiblingPositions(qaTopologyEntries());
    const calls = [];
    const host = mount({
      position: positions.get("203f84ca"),
      onSwitchSibling: (id) => calls.push(id),
    });
    expect(host.querySelector('[data-testid="branch-pager-position"]').textContent).toBe("2/3");
    click(host, '[data-testid="branch-pager-prev"]');
    click(host, '[data-testid="branch-pager-next"]');
    expect(calls).toEqual(["f56a8b1b", "a1d59f08"]);
  });

  test("(14) 渲染面冒烟：分支三渲染 ‹3/3›，next 到头禁用、prev 回调指向分支二", () => {
    const positions = deriveSiblingPositions(qaTopologyEntries());
    const calls = [];
    const host = mount({
      position: positions.get("a1d59f08"),
      onSwitchSibling: (id) => calls.push(id),
    });
    expect(host.querySelector('[data-testid="branch-pager-position"]').textContent).toBe("3/3");
    expect(host.querySelector('[data-testid="branch-pager-next"]').disabled).toBe(true);
    click(host, '[data-testid="branch-pager-prev"]');
    expect(calls).toEqual(["203f84ca"]);
  });
});
