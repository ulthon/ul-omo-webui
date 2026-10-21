// 空壳气泡消解（docs08-r6 任务 10）单测：
// - ① PartView 未知 part 类型占位 chip（防御性兜底：task-3 枚举实证 part.type 仅
//   text/toolCall/thinking/image 四种且全在渲染集合内，本分支无实证样本，不猜结构）
// - ② 全空 assistant 条目（全部 part 渲染为空）渲染单行「N 个未支持内容块」替代空壳
//   （task-3 全库实证 18 条全空 text 条目；空判上移为计数）
// - ③ custom_message 条目渲染分支：display=true 入列占位行；display=false 引擎明示
//   不展示、绝不产生零内容气泡（库内 998 条 display=false 的空壳防线）；
//   记忆标记条目（task-3 实物样本 omo-kibitzer:recall）走 marker 通道，此处跳过防双列
// - zero_diff_guarantee：无未知类型会话（正常 part + display=false 条目在场）渲染零变化
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

import { PartView, PartsView } from "@/components/chat/parts";
import { buildMessageItems, type ChatListItem } from "@/components/chat/message-items";
import { CustomMessageBubble, EntryBubble } from "@/components/chat/message-bubble";
import { useMessagesStore } from "@/stores/messages";
import { useLocaleStore } from "@/i18n/i18n";
import type { WireEntry } from "@/lib/api";

// ---------------------------------------------------------------- fixture（形态取 task-3 枚举实测键集）

/** message 条目：role 消息（content 形态自定） */
function messageEntry(id: string, role: string, content: unknown): WireEntry & { id: string } {
  return { type: "message", id, message: { role, content } };
}

/** custom_message 条目（task-3 实测键集 {type, customType, content, display, id, …}） */
function customMsg(id: string, customType: string, display: boolean): WireEntry & { id: string } {
  return { type: "custom_message", id, customType, content: "notice 正文", display };
}

const OPTS = { hasStreamingMessage: false, interrupted: false };

// ---------------------------------------------------------------- 挂载辅助

const CLEANUPS: Array<() => void> = [];

function makeContainer(): HTMLElement {
  const c = document.createElement("div");
  document.body.appendChild(c);
  return c;
}

/** 挂载组件并返回容器（props 泛型宽松，测试内固定用法） */
function mount(component: React.ReactElement): HTMLElement {
  const container = makeContainer();
  const root = createRoot(container);
  act(() => {
    root.render(component);
  });
  CLEANUPS.push(() => act(() => root.unmount()));
  return container;
}

function setEntries(entries: WireEntry[]) {
  act(() => {
    // 空会话形态对齐 store 的 emptySessionMessages（toolRuns 缺失会让 ToolCard 选择器崩，
    // 真实 store 恒有该字段）；与 setEntries 同构：新态覆盖旧 entries
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

// ---------------------------------------------------------------- ① 未知 part 占位 chip

describe("未知 part 类型占位 chip（①，防御性兜底）", () => {
  test("未知类型渲染 chip 并带类型名，不崩、不渲染载荷", () => {
    const el = mount(createElement(PartView, { part: { type: "mysteryBlock", payload: { x: 1 } }, sessionId: "s1", live: false }));
    const chip = el.querySelector("[data-testid='unsupported-chip']");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-unsupported-type")).toBe("mysteryBlock");
    expect(chip?.textContent).toBe("未支持内容块：mysteryBlock");
    // 不猜结构：未知载荷字段不外泄到 DOM
    expect(el.textContent).not.toContain("payload");
  });

  test("type 缺失/空串降级 unknown 标签，不崩", () => {
    const el = mount(createElement(PartView, { part: {} as never, sessionId: "s1", live: false }));
    const chip = el.querySelector("[data-testid='unsupported-chip']");
    expect(chip?.getAttribute("data-unsupported-type")).toBe("unknown");
    expect(chip?.textContent).toBe("未支持内容块：unknown");
  });

  test("en 档 chip 文案切换", () => {
    act(() => useLocaleStore.getState().setLocale("en"));
    const el = mount(createElement(PartView, { part: { type: "mysteryBlock" }, sessionId: "s1", live: false }));
    expect(el.querySelector("[data-testid='unsupported-chip']")?.textContent).toBe(
      "Unsupported content block: mysteryBlock",
    );
  });
});

// ---------------------------------------------------------------- ② 全空条目计数行

describe("全空 assistant 条目计数行（②）", () => {
  test("单个空 text part：单行「1 个未支持内容块」替代空壳（task-3 实证 18 条同形态）", () => {
    const el = mount(createElement(PartsView, { parts: [{ type: "text", text: "" }], sessionId: "s1", live: false }));
    const line = el.querySelector("[data-testid='unsupported-count']");
    expect(line).not.toBeNull();
    expect(line?.textContent).toBe("1 个未支持内容块");
  });

  test("多个空 part 计数准确；en 档复数 one/other", () => {
    const el = mount(
      createElement(PartsView, { parts: [{ type: "text", text: "" }, { type: "text" }], sessionId: "s1", live: false }),
    );
    expect(el.querySelector("[data-testid='unsupported-count']")?.textContent).toBe("2 个未支持内容块");

    act(() => useLocaleStore.getState().setLocale("en"));
    const elEn = mount(
      createElement(PartsView, { parts: [{ type: "text", text: "" }], sessionId: "s1", live: false }),
    );
    expect(elEn.querySelector("[data-testid='unsupported-count']")?.textContent).toBe("1 unsupported content block");
    const elEn2 = mount(
      createElement(PartsView, { parts: [{ type: "text", text: "" }, { type: "text", text: "" }], sessionId: "s1", live: false }),
    );
    expect(elEn2.querySelector("[data-testid='unsupported-count']")?.textContent).toBe("2 unsupported content blocks");
  });

  test("非对象 part 形态不崩，计入计数", () => {
    const el = mount(createElement(PartsView, { parts: [null as never], sessionId: "s1", live: false }));
    expect(el.querySelector("[data-testid='unsupported-count']")?.textContent).toBe("1 个未支持内容块");
  });

  test("混合条目（空 text + 可见 text）不走计数行：可见路径零变化", () => {
    const el = mount(
      createElement(PartsView, { parts: [{ type: "text", text: "" }, { type: "text", text: "正文" }], sessionId: "s1", live: false }),
    );
    expect(el.querySelector("[data-testid='unsupported-count']")).toBeNull();
    expect(el.textContent).toContain("正文");
  });

  test("未知类型计为可见（① chip），不触发计数行", () => {
    const el = mount(createElement(PartsView, { parts: [{ type: "mysteryBlock" }], sessionId: "s1", live: false }));
    expect(el.querySelector("[data-testid='unsupported-count']")).toBeNull();
    expect(el.querySelector("[data-testid='unsupported-chip']")).not.toBeNull();
  });
});

// ---------------------------------------------------------------- ③ custom_message 渲染分支

describe("custom_message 条目分类与渲染（③）", () => {
  test("display=true 入列 customMessage 项（loop-guard:notice 实测形态）", () => {
    const items = buildMessageItems([customMsg("cm1", "loop-guard:notice", true)], OPTS);
    expect(items).toEqual([{ key: "cm1", kind: "customMessage", entryId: "cm1" }]);
  });

  test("display=false 不入列：engine 明示不展示的条目不得产生任何气泡（空壳防线）", () => {
    const items = buildMessageItems(
      [customMsg("cm2", "environment-context", false), customMsg("cm3", "senpi-task.usage", false)],
      OPTS,
    );
    expect(items).toEqual([]);
  });

  test("display 字段缺失按不可见处理（wire 形态从宽）", () => {
    const items = buildMessageItems([{ type: "custom_message", id: "cm4", customType: "x" }], OPTS);
    expect(items).toEqual([]);
  });

  test("记忆标记条目（omo-kibitzer:recall 实物样本）跳过防双列，marker 通道独占渲染", () => {
    const recall: WireEntry & { id: string } = {
      type: "custom_message",
      id: "r1",
      customType: "omo-kibitzer:recall",
      content: '<recalled-memory source="[[people/human/observations.md]]">\n正文\n</recalled-memory>',
      display: false,
    };
    const items = buildMessageItems([recall], OPTS);
    expect(items).toEqual([]);
  });

  test("CustomMessageBubble 渲染 customType 占位行（zh/en）；只读键集内字段", () => {
    setEntries([customMsg("cm1", "loop-guard:notice", true)]);
    const el = mount(createElement(CustomMessageBubble, { sessionId: "s1", entryId: "cm1" }));
    const chip = el.querySelector("[data-testid='custom-message-chip']");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-custom-type")).toBe("loop-guard:notice");
    expect(chip?.textContent).toBe("未支持内容：loop-guard:notice");

    act(() => useLocaleStore.getState().setLocale("en"));
    expect(el.querySelector("[data-testid='custom-message-chip']")?.textContent).toBe(
      "Unsupported content: loop-guard:notice",
    );
  });

  test("渲染门与分类门同判：display=false 条目直接挂载组件也不渲染", () => {
    setEntries([customMsg("cm2", "environment-context", false)]);
    const el = mount(createElement(CustomMessageBubble, { sessionId: "s1", entryId: "cm2" }));
    expect(el.querySelector("[data-testid='custom-message-chip']")).toBeNull();
    expect(el.textContent).toBe("");
  });
});

// ---------------------------------------------------------------- 空壳复现样例 + 零变化守卫

describe("空壳复现样例（empty_bubble_regression）与零变化守卫（zero_diff_guarantee）", () => {
  test("空壳复现样例：空 text assistant 条目经 EntryBubble 渲染出计数行，不再零内容", () => {
    const entries = [
      messageEntry("u1", "user", [{ type: "text", text: "问" }]),
      messageEntry("a1", "assistant", [{ type: "text", text: "" }]),
      customMsg("cm9", "environment-context", false),
    ];
    setEntries(entries);
    // 分类：user/assistant 入列，display=false 不入列
    const items = buildMessageItems(entries, OPTS);
    expect(items.map((i) => [i.kind, i.key])).toEqual([
      ["entry", "u1"],
      ["entry", "a1"],
    ]);
    // 渲染：空壳条目气泡体现在头部 + 计数行（改动前是头部 + 零内容）
    const el = mount(createElement(EntryBubble, { sessionId: "s1", entryId: "a1", interrupted: false }));
    expect(el.textContent).toContain("助手");
    expect(el.querySelector("[data-testid='unsupported-count']")?.textContent).toBe("1 个未支持内容块");
    // display=false 条目直接挂 EntryBubble 同样零渲染（isRenderableEntry 只认 type:"message"）
    const elCm = mount(createElement(EntryBubble, { sessionId: "s1", entryId: "cm9", interrupted: false }));
    expect(elCm.textContent).toBe("");
  });

  test("zero_diff_guarantee：正常 part 会话（含在场 display=false 条目）items 全为 entry 且保序，DOM 无占位节点", () => {
    const entries = [
      messageEntry("u1", "user", [{ type: "text", text: "问" }]),
      messageEntry("a1", "assistant", [
        { type: "thinking", thinking: "想" },
        { type: "toolCall", id: "tc1", name: "bash", arguments: {} },
        { type: "text", text: "答" },
      ]),
      customMsg("cm9", "environment-context", false),
      messageEntry("a2", "assistant", [{ type: "text", text: "续" }]),
    ];
    setEntries(entries);
    const items = buildMessageItems(entries, OPTS);
    // 结构零变化：只有 entry 项（toolResult 缺席即既有口径；无 customMessage / 计数触发源）
    expect(items.every((i: ChatListItem) => i.kind === "entry")).toBe(true);
    expect(items.map((i) => i.key)).toEqual(["u1", "a1", "a2"]);
    // 渲染零变化等价断言：正常条目 DOM 无 chip / 计数行，正文与既有 Markdown 路径一致
    const el = mount(createElement(EntryBubble, { sessionId: "s1", entryId: "a1", interrupted: false }));
    expect(el.querySelector("[data-testid='unsupported-chip']")).toBeNull();
    expect(el.querySelector("[data-testid='unsupported-count']")).toBeNull();
    expect(el.textContent).toContain("答");
  });

  test("有序混合流：正常气泡、custom_message 占位行、记忆标记锚点共存时各归其位", () => {
    const recall: WireEntry & { id: string } = {
      type: "custom_message",
      id: "r1",
      customType: "omo-kibitzer:recall",
      content: '<recalled-memory source="[[people/human/observations.md]]">\n正文\n</recalled-memory>',
      display: false,
    };
    const entries = [
      messageEntry("u1", "user", [{ type: "text", text: "问" }]),
      customMsg("cm1", "loop-guard:notice", true),
      recall,
      messageEntry("a1", "assistant", [{ type: "text", text: "答" }]),
    ];
    setEntries(entries);
    const items = buildMessageItems(entries, OPTS);
    // custom_message display=true 占位行按流内位置入列；recall 不入列（marker 通道经
    // mergeMemoryItems 在 message-list 归并，不在本函数职责内）
    expect(items.map((i) => [i.kind, i.key])).toEqual([
      ["entry", "u1"],
      ["customMessage", "cm1"],
      ["entry", "a1"],
    ]);
  });
});
