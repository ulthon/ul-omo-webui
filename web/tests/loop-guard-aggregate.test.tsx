// loop-guard 三型具名渲染与连排聚合（docs08 2026-10-22 批次任务 2）单测：
// - 分类门：customType 精确三型（loop-guard:notice/escalation/recovery）→ loopGuardGroup；
//   未知 loop-guard:* 后缀禁猜回落 customMessage 占位行；display=false 一律不入列
//   （引擎明示不展示，聚合组不得绕过——既有口径）
// - 聚合纯函数（buildMessageItems 单遍内联）：相邻同型连排聚合「×N」（entryIds 有序）；
//   「连排」=entries 流内直接相邻，任何其他条目（含 toolResult 等不可见条目）打断聚合
//   （非相邻同型不聚合；kind 边界重置）
// - 渲染分支（LoopGuardGroupBubble）：单条无 ×N 角标、多条 ×N、三型 data-loop-guard-kind
//   色板变体、zh/en 词条、点击展开逐条全文、空内容/无信息行降级不崩
// 引擎契约锚点（session-worker.js 实证）：LOOP_GUARD_*_CUSTOM_TYPE 三常量、
// renderer.js buildNoticeBox title/why/expandedLine 三行结构、escalation tone=error。
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

import { buildMessageItems, loopGuardKindOf, type ChatListItem } from "@/components/chat/message-items";
import { LoopGuardGroupBubble } from "@/components/chat/message-bubble";
import { useMessagesStore } from "@/stores/messages";
import { useLocaleStore } from "@/i18n/i18n";
import type { WireEntry } from "@/lib/api";

// ---------------------------------------------------------------- fixture

/** loop-guard custom_message 条目（引擎落库键集 {type, customType, content, display, id, …}） */
function lg(id: string, kind: string, content: string, display = true): WireEntry & { id: string } {
  return { type: "custom_message", id, customType: `loop-guard:${kind}`, content, display };
}

/** message 条目 */
function msg(id: string, role: string, text: string): WireEntry & { id: string } {
  return { type: "message", id, message: { role, content: [{ type: "text", text }] } };
}

const OPTS = { hasStreamingMessage: false, interrupted: false };

/** 摘要：引擎真实 content 是 <system-reminder> 包裹文本，第二行才是信息行 */
const NOTICE_CONTENT = "<system-reminder>\nLOOP GUARD - IDENTICAL TOOL CALLS: you called `bash_output` 3 times\n</system-reminder>";

function groups(items: ChatListItem[]): Array<[string, string, number]> {
  return items.map((i) =>
    i.kind === "loopGuardGroup" ? [i.kind, i.loopGuardKind, i.entryIds.length] : [i.kind, i.key, 0],
  ) as Array<[string, string, number]>;
}

// ---------------------------------------------------------------- 纯函数：分类门

describe("loopGuardKindOf 分类门", () => {
  test("三型精确命中 notice/escalation/recovery", () => {
    expect(loopGuardKindOf("loop-guard:notice")).toBe("notice");
    expect(loopGuardKindOf("loop-guard:escalation")).toBe("escalation");
    expect(loopGuardKindOf("loop-guard:recovery")).toBe("recovery");
  });

  test("未知 loop-guard:* 后缀与非字符串禁猜返回 null", () => {
    expect(loopGuardKindOf("loop-guard:unknown")).toBeNull();
    expect(loopGuardKindOf("loop-guard:")).toBeNull();
    expect(loopGuardKindOf(undefined)).toBeNull();
    expect(loopGuardKindOf(42)).toBeNull();
  });
});

// ---------------------------------------------------------------- 纯函数：聚合

describe("buildMessageItems loop-guard 连排聚合", () => {
  test("单条 notice 入列一组且 entryIds 长度 1（无角标语义：count=1 不产生 ×N）", () => {
    const items = buildMessageItems([lg("g1", "notice", NOTICE_CONTENT)], OPTS);
    expect(items).toHaveLength(1);
    const group = items[0];
    assertLoopGuardGroup(group);
    expect(group.loopGuardKind).toBe("notice");
    expect(group.entryIds).toEqual(["g1"]);
    expect(group.key).toBe("loop-guard-g1");
  });

  test("4 连排 notice 聚合为一组 ×4（key 锚定首条，entryIds 保序）", () => {
    const items = buildMessageItems(
      [lg("a", "notice", "c1"), lg("b", "notice", "c2"), lg("c", "notice", "c3"), lg("d", "notice", "c4")],
      OPTS,
    );
    expect(items).toHaveLength(1);
    const group = items[0];
    assertLoopGuardGroup(group);
    expect(group.loopGuardKind).toBe("notice");
    expect(group.entryIds).toEqual(["a", "b", "c", "d"]);
    expect(group.key).toBe("loop-guard-a");
  });

  test("kind 边界重置聚合：notice→escalation→notice 三组各自单条", () => {
    const items = buildMessageItems(
      [lg("a", "notice", "c1"), lg("b", "escalation", "c2"), lg("c", "notice", "c3")],
      OPTS,
    );
    expect(groups(items)).toEqual([
      ["loopGuardGroup", "notice", 1],
      ["loopGuardGroup", "escalation", 1],
      ["loopGuardGroup", "notice", 1],
    ]);
  });

  test("非相邻同型不聚合：普通 message 条目隔开即两组", () => {
    const items = buildMessageItems(
      [lg("a", "notice", "c1"), msg("m1", "assistant", "正文"), lg("b", "notice", "c2")],
      OPTS,
    );
    expect(groups(items)).toEqual([
      ["loopGuardGroup", "notice", 1],
      ["entry", "m1", 0],
      ["loopGuardGroup", "notice", 1],
    ]);
  });

  test("不可见条目（toolResult / display=false custom_message）不打断视觉连排：两 notice 聚合 ×2", () => {
    // 「连排」= 渲染流相邻（用户所见）；toolResult 等不入列条目不产生可见行，不阻断聚合
    const items = buildMessageItems(
      [lg("a", "notice", "c1"), msg("t1", "toolResult", "结果"), lg("b", "notice", "c2")],
      OPTS,
    );
    expect(groups(items)).toEqual([["loopGuardGroup", "notice", 2]]);
    const items2 = buildMessageItems(
      [lg("a", "notice", "c1"), { type: "custom_message", id: "x", customType: "senpi-terminal:notification", content: "n", display: false }, lg("b", "notice", "c2")],
      OPTS,
    );
    expect(groups(items2)).toEqual([["loopGuardGroup", "notice", 2]]);
  });

  test("display=false 的 loop-guard 条目不入列不入组（引擎明示不展示，既有口径不回退）", () => {
    const items = buildMessageItems([lg("a", "notice", "c1", false), lg("b", "recovery", "c2", false)], OPTS);
    expect(items).toEqual([]);
    // 混排：display=false 不产生可见行也不入组，其前后同型仍聚合（视觉连排不被隐形条目打断）
    const items2 = buildMessageItems(
      [lg("a", "notice", "c1"), lg("b", "notice", "c2", false), lg("c", "notice", "c3")],
      OPTS,
    );
    expect(groups(items2)).toEqual([["loopGuardGroup", "notice", 2]]);
  });

  test("escalation/recovery 各自成组着色变体（loopGuardKind 正确透传渲染层）", () => {
    const items = buildMessageItems(
      [lg("a", "escalation", "c1"), lg("b", "escalation", "c2"), lg("c", "recovery", "c3")],
      OPTS,
    );
    expect(groups(items)).toEqual([
      ["loopGuardGroup", "escalation", 2],
      ["loopGuardGroup", "recovery", 1],
    ]);
  });

  test("未知 loop-guard 后缀回落 customMessage 占位行（兜底不动）；混合流保序", () => {
    const items = buildMessageItems(
      [lg("a", "notice", "c1"), lg("b", "mystery", "c2"), msg("m1", "user", "问")],
      OPTS,
    );
    expect(items.map((i) => [i.kind, i.key])).toEqual([
      ["loopGuardGroup", "loop-guard-a"],
      ["customMessage", "b"],
      ["entry", "m1"],
    ]);
  });
});

/** 类型收窄断言（测试内固定用法） */
function assertLoopGuardGroup(item: ChatListItem): asserts item is Extract<ChatListItem, { kind: "loopGuardGroup" }> {
  expect(item.kind).toBe("loopGuardGroup");
}

// ---------------------------------------------------------------- 渲染分支

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

function setEntries(entries: WireEntry[]) {
  act(() => {
    useMessagesStore.setState({
      bySession: {
        "s1": {
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

beforeEach(() => {
  act(() => {
    useMessagesStore.setState({ bySession: {}, replayRecovering: false });
    useLocaleStore.setState({ locale: "zh-CN" });
  });
});

afterEach(() => {
  CLEANUPS.splice(0).forEach((fn) => fn());
  act(() => {
    useMessagesStore.setState({ bySession: {}, replayRecovering: false });
    useLocaleStore.setState({ locale: "zh-CN" });
  });
});

function lgEntries(...ids: string[]): WireEntry[] {
  return ids.map((id) => lg(id, "notice", NOTICE_CONTENT));
}

describe("LoopGuardGroupBubble 渲染分支", () => {
  test("单条 notice：具名行渲染、无 ×N 角标（data-count=1），摘要取首个信息行（跳过包裹标签）", () => {
    setEntries(lgEntries("g1"));
    const el = mount(createElement(LoopGuardGroupBubble, { sessionId: "s1", loopGuardKind: "notice", entryIds: ["g1"] }));
    const block = el.querySelector("[data-testid='loop-guard-block']");
    expect(block).not.toBeNull();
    expect(block?.getAttribute("data-loop-guard-kind")).toBe("notice");
    expect(block?.getAttribute("data-count")).toBe("1");
    expect(block?.textContent).toContain("循环防护提醒");
    expect(block?.textContent).not.toMatch(/×\d/);
    expect(block?.textContent).toContain("LOOP GUARD - IDENTICAL TOOL CALLS: you called `bash_output` 3 times");
    expect(block?.textContent).not.toContain("<system-reminder>");
  });

  test("4 连排：×4 角标；点击展开逐条全文（data-testid=loop-guard-item ×4）；再点收起", () => {
    setEntries(lgEntries("a", "b", "c", "d"));
    const el = mount(
      createElement(LoopGuardGroupBubble, { sessionId: "s1", loopGuardKind: "notice", entryIds: ["a", "b", "c", "d"] }),
    );
    const block = el.querySelector("[data-testid='loop-guard-block']");
    expect(block?.getAttribute("data-count")).toBe("4");
    expect(block?.textContent).toContain("×4");
    // 折叠态无逐条全文
    expect(el.querySelectorAll("[data-testid='loop-guard-item']")).toHaveLength(0);
    const toggle = el.querySelector("button[aria-expanded]");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      (toggle as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
    const items = el.querySelectorAll("[data-testid='loop-guard-item']");
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toContain("LOOP GUARD");
    act(() => {
      (el.querySelector("button[aria-expanded]") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.querySelectorAll("[data-testid='loop-guard-item']")).toHaveLength(0);
  });

  test("三型色板变体：escalation/recovery 的 data-loop-guard-kind 正确（色板经类名断言）", () => {
    setEntries([lg("e1", "escalation", "c1"), lg("r1", "recovery", "c2")]);
    const el = mount(createElement(LoopGuardGroupBubble, { sessionId: "s1", loopGuardKind: "escalation", entryIds: ["e1"] }));
    expect(el.querySelector("[data-testid='loop-guard-block']")?.getAttribute("data-loop-guard-kind")).toBe("escalation");
    expect(el.querySelector("[data-testid='loop-guard-block']")?.className).toContain("border-destructive/40");
    const el2 = mount(createElement(LoopGuardGroupBubble, { sessionId: "s1", loopGuardKind: "recovery", entryIds: ["r1"] }));
    expect(el2.querySelector("[data-testid='loop-guard-block']")?.getAttribute("data-loop-guard-kind")).toBe("recovery");
    expect(el2.querySelector("[data-testid='loop-guard-block']")?.className).toContain("border-emerald-500/40");
  });

  test("en 档词条切换", () => {
    setEntries(lgEntries("g1"));
    const el = mount(createElement(LoopGuardGroupBubble, { sessionId: "s1", loopGuardKind: "notice", entryIds: ["g1"] }));
    expect(el.querySelector("[data-testid='loop-guard-block']")?.textContent).toContain("循环防护提醒");
    act(() => useLocaleStore.getState().setLocale("en"));
    expect(el.querySelector("[data-testid='loop-guard-block']")?.textContent).toContain("Loop guard notice");
  });

  test("畸形输入不崩：空 content（无摘要行、展开显无内容降级）", () => {
    setEntries([{ type: "custom_message", id: "z1", customType: "loop-guard:notice", content: "", display: true }]);
    const el = mount(createElement(LoopGuardGroupBubble, { sessionId: "s1", loopGuardKind: "notice", entryIds: ["z1"] }));
    const block = el.querySelector("[data-testid='loop-guard-block']");
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("循环防护提醒");
    // 无摘要行不臆造：折叠行无摘要 span（仅具名标签与角标区）
    act(() => {
      (el.querySelector("button[aria-expanded]") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const item = el.querySelector("[data-testid='loop-guard-item']");
    expect(item?.textContent).toBe("（无内容）");
  });

  test("畸形输入不崩：content 无可解析信息行（纯包裹标签）摘要降级空、原文仍完整展开", () => {
    setEntries([lg("z2", "notice", "<system-reminder>\n</system-reminder>")]);
    const el = mount(createElement(LoopGuardGroupBubble, { sessionId: "s1", loopGuardKind: "notice", entryIds: ["z2"] }));
    const block = el.querySelector("[data-testid='loop-guard-block']");
    expect(block?.textContent).not.toContain("LOOP GUARD");
    act(() => {
      (el.querySelector("button[aria-expanded]") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.querySelector("[data-testid='loop-guard-item']")?.textContent).toContain("<system-reminder>");
  });

  test("store 无条目（未及/被清理）与条目 display=false 绕过分类门直挂均零渲染", () => {
    setEntries([]);
    const el = mount(createElement(LoopGuardGroupBubble, { sessionId: "s1", loopGuardKind: "notice", entryIds: ["gone"] }));
    expect(el.querySelector("[data-testid='loop-guard-block']")).toBeNull();
    setEntries([lg("h1", "notice", "c1", false)]);
    const el2 = mount(createElement(LoopGuardGroupBubble, { sessionId: "s1", loopGuardKind: "notice", entryIds: ["h1"] }));
    expect(el2.querySelector("[data-testid='loop-guard-block']")).toBeNull();
  });
});
