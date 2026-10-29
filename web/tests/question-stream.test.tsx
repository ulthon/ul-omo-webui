// 提问卡消息流合成与提示条测试（r11 todo 6d/e）：
// - mergeQuestionCards 纯函数：锚点条目后插入位置正确、双 pending 各自渲染于各自锚点、
//   同锚到达序稳定、锚条目不可见（toolResult 等）时落位其后首个可见行、null/失解锚挂
//   消息流末尾（流式气泡之前）、resolved 摘要行在原卡位替换、空输入引用原样返回
//   （重放窗口不双列由 questions store 同 id 去重保证，见 questions.test.ts）；
// - QuestionResolvedLineBlock：outcome→文案映射 + 题干摘要；
// - QuestionHintBar：有 pending 渲染（多卡显条数）/点击 onView(队首 id)/空队列不渲染；
// - ChatView 集成：待答卡渲染在消息流内锚点后、提示条在输入区上方、权限卡位置行为
//   不动（DOM 序：权限卡 → 提示条 → 输入区）、提示条点击 scrollIntoView 定位流内卡。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");

import type { ChatListItem } from "@/components/chat/message-items";
import type { QuestionRequest } from "@/stores/questions";

const { buildMessageItems, mergeQuestionCards } = await import("@/components/chat/message-items");
const { QuestionResolvedLineBlock } = await import("@/components/chat/message-list");
const { QuestionHintBar } = await import("@/components/chat/question-hint-bar");
const { ChatView } = await import("@/components/chat/chat-view");
const { useQuestionsStore } = await import("@/stores/questions");
const { useMessagesStore } = await import("@/stores/messages");
const { usePermissionsStore } = await import("@/stores/permissions");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");
const { useQueueStore } = await import("@/stores/queue");

const ORIGINAL_FETCH = globalThis.fetch;
const SID = "sess-stream-1";

// ---------------------------------------------------------------- fixture

function msgEntry(id: string, role = "user"): { type: string; id: string; message: { role: string; content: unknown[] } } {
  return { type: "message", id, message: { role, content: [{ type: "text", text: `msg-${id}` }] } };
}

function entryItem(id: string): ChatListItem {
  return { key: id, kind: "entry", entryId: id, interrupted: false, model: null };
}

function makeQuestionRequest(id: string, anchorEntryId: string | null): QuestionRequest {
  return {
    id,
    waitForAnswer: true,
    questions: [
      { id: "q1", header: "Deploy", question: `Which env (${id})?`, options: [{ label: "staging" }], multiSelect: false },
    ],
    deadlineAtMs: Date.now() + 30 * 60_000,
    timeout: 30 * 60_000,
    askedAtMs: Date.now(),
    anchorEntryId,
  };
}

/** items 摘要：[kind, key] 序列 */
function kinds(items: ChatListItem[]): Array<[string, string]> {
  return items.map((i) => {
    if (i.kind === "questionCard") return ["questionCard", i.request.id];
    if (i.kind === "questionResolved") return ["questionResolved", i.summary.id];
    if (i.kind === "entry") return ["entry", i.entryId];
    return [i.kind, i.key];
  });
}

// ---------------------------------------------------------------- 纯函数：合成层

describe("mergeQuestionCards 锚定合成", () => {
  const u1 = msgEntry("u1");
  const a1 = msgEntry("a1", "assistant");
  const u2 = msgEntry("u2");
  const entries = [u1, a1, u2];
  const items: ChatListItem[] = [entryItem("u1"), entryItem("a1"), entryItem("u2")];

  test("锚定条目插入位置正确：卡插在锚点 entry 之后", () => {
    const merged = mergeQuestionCards(items, entries, [makeQuestionRequest("qr-1", "a1")]);
    expect(kinds(merged)).toEqual([
      ["entry", "u1"],
      ["entry", "a1"],
      ["questionCard", "qr-1"],
      ["entry", "u2"],
    ]);
    const card = merged[2];
    expect(card?.kind === "questionCard" && card.position === 1 && card.total === 1).toBe(true);
  });

  test("双 pending 各自渲染于各自锚点（不折叠收敛、互不吞噬）", () => {
    const merged = mergeQuestionCards(items, entries, [
      makeQuestionRequest("qr-1", "u1"),
      makeQuestionRequest("qr-2", "u2"),
    ]);
    expect(kinds(merged)).toEqual([
      ["entry", "u1"],
      ["questionCard", "qr-1"],
      ["entry", "a1"],
      ["entry", "u2"],
      ["questionCard", "qr-2"],
    ]);
    const totals = merged.filter((i) => i.kind === "questionCard").map((i) => (i as { position: number; total: number }).total);
    expect(totals).toEqual([2, 2]);
  });

  test("同锚双卡保持到达序（不反序）", () => {
    const merged = mergeQuestionCards(items, entries, [
      makeQuestionRequest("qr-first", "a1"),
      makeQuestionRequest("qr-second", "a1"),
    ]);
    expect(kinds(merged)).toEqual([
      ["entry", "u1"],
      ["entry", "a1"],
      ["questionCard", "qr-first"],
      ["questionCard", "qr-second"],
      ["entry", "u2"],
    ]);
  });

  test("锚条目不产生可见行（toolResult）：卡落位其后首个可见行之前", () => {
    const tool = { type: "message", id: "t1", message: { role: "toolResult", content: [] } };
    const es = [u1, tool, a1];
    const base = buildMessageItems(es as never, { hasStreamingMessage: false, interrupted: false });
    expect(base.map((i) => i.kind)).toEqual(["entry", "entry"]); // toolResult 不入列
    const merged = mergeQuestionCards(base, es, [makeQuestionRequest("qr-1", "t1")]);
    expect(kinds(merged)).toEqual([
      ["entry", "u1"],
      ["questionCard", "qr-1"],
      ["entry", "a1"],
    ]);
  });

  test("null 锚（提问先于任何消息）/ 失解锚（锚条目被压缩出窗）：挂消息流末尾，流式气泡之前", () => {
    const withStreaming: ChatListItem[] = [...items, { key: "__streaming", kind: "streaming" }];
    const merged = mergeQuestionCards(withStreaming, entries, [
      makeQuestionRequest("qr-null", null),
      makeQuestionRequest("qr-gone", "compacted-away"),
    ]);
    expect(kinds(merged)).toEqual([
      ["entry", "u1"],
      ["entry", "a1"],
      ["entry", "u2"],
      ["questionCard", "qr-null"],
      ["questionCard", "qr-gone"],
      ["streaming", "__streaming"],
    ]);
  });

  test("resolved 摘要行在原卡位替换（卡出队后同一锚点出现一行摘要）", () => {
    const merged = mergeQuestionCards(items, entries, [], [
      { id: "qr-1", anchorEntryId: "a1", outcome: "answered", snippet: "Which env (qr-1)?" },
    ]);
    expect(kinds(merged)).toEqual([
      ["entry", "u1"],
      ["entry", "a1"],
      ["questionResolved", "qr-1"],
      ["entry", "u2"],
    ]);
  });

  test("空输入引用原样返回（订阅方不重算口径）", () => {
    expect(mergeQuestionCards(items, entries, [])).toBe(items);
    expect(mergeQuestionCards(items, entries, [], [])).toBe(items);
  });
});

// ---------------------------------------------------------------- 组件：摘要行 / 提示条

describe("QuestionResolvedLineBlock", () => {
  test("outcome→文案映射 + 题干摘要（answered/cancelled 未知值回退通用）", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement("div", null, [
          createElement(QuestionResolvedLineBlock, { key: "a", summary: { id: "r1", anchorEntryId: null, outcome: "answered", snippet: "选哪个环境？" } }),
          createElement(QuestionResolvedLineBlock, { key: "b", summary: { id: "r2", anchorEntryId: null, outcome: "cancelled", snippet: "" } }),
          createElement(QuestionResolvedLineBlock, { key: "c", summary: { id: "r3", anchorEntryId: null, outcome: "weird_future", snippet: "" } }),
        ]),
      );
    });
    const lines = [...container.querySelectorAll("[data-testid=question-resolved-line]")];
    expect(lines).toHaveLength(3);
    expect(lines[0]!.textContent).toContain("提问已回答");
    expect(lines[0]!.textContent).toContain("选哪个环境？");
    expect(lines[0]!.getAttribute("data-outcome")).toBe("answered");
    expect(lines[1]!.textContent).toContain("提问已取消");
    expect(lines[2]!.textContent).toContain("提问已处理");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe("QuestionHintBar 提示条", () => {
  async function mountBar(onView: (id: string) => void) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(QuestionHintBar, { sessionId: SID, onView }));
    });
    return {
      container,
      unmount: async () => {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      },
    };
  }

  test("队列空时不渲染", async () => {
    useQuestionsStore.setState({ bySession: {} });
    const { container, unmount } = await mountBar(() => {});
    expect(container.querySelector("[data-testid=question-hint-bar]")).toBeNull();
    await unmount();
  });

  test("单 pending：渲染提示条，点击 onView 携队首请求 id", async () => {
    useQuestionsStore.setState({
      bySession: { [SID]: [makeQuestionRequest("qr-1", "u1")] },
    });
    const seen: string[] = [];
    const { container, unmount } = await mountBar((id) => seen.push(id));
    const bar = container.querySelector("[data-testid=question-hint-bar]");
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain("有待答提问");
    expect(container.querySelector("[data-testid=question-hint-count]")).toBeNull(); // 单卡不显条数
    await act(async () => {
      container.querySelector("[data-testid=question-hint-view]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(seen).toEqual(["qr-1"]);
    await unmount();
  });

  test("双 pending：显示条数（共 2 个）", async () => {
    useQuestionsStore.setState({
      bySession: { [SID]: [makeQuestionRequest("qr-1", "u1"), makeQuestionRequest("qr-2", "u2")] },
    });
    const { container, unmount } = await mountBar(() => {});
    const count = container.querySelector("[data-testid=question-hint-count]");
    expect(count).not.toBeNull();
    expect(count!.textContent).toContain("2");
    await unmount();
  });
});

// ---------------------------------------------------------------- ChatView 集成

describe("ChatView 集成：流内卡 + 提示条 + 权限卡位置", () => {
  /** 虚拟化行挂载前提：happy-dom 元素尺寸为 0，stub 出可视高度 */
  let origGBCR: (() => DOMRect) | undefined;
  let origScrollIntoView: ((opts?: unknown) => void) | undefined;
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // store 复位
    useSessionsStore.setState({ byProject: {}, runStates: {}, runStateAt: {}, appliedModels: {}, selectedId: SID });
    useMessagesStore.setState({ bySession: {} });
    usePermissionsStore.setState({ bySession: {}, autoAllow: {} });
    useQuestionsStore.setState({ bySession: {}, drafts: {}, resolvedSummaries: {} });
    useQueueStore.setState({ bySession: {} });
    useUiStore.setState({ currentProject: "/p", toast: null });

    // api 全量 mock：按 URL 分流返回最小合法形状
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/messages")) {
        return json({ sessionId: SID, entries: [msgEntry("u1")], cursor: null, leafId: null, hasMore: false, oldestId: null });
      }
      if (url.includes("/tips")) return json({ tips: [] });
      if (url.includes("/questions")) return json({ sessionId: SID, questions: [] });
      if (url.includes("/queue")) return json({ sessionId: SID, steering: [], followUp: [], ordered: [] });
      if (url.includes("/read")) return json({ ok: true });
      if (url.includes("/usage")) return json({});
      if (url.includes("/api/sessions")) return json({ sessions: [] });
      return json({ ok: true });
    }) as unknown as typeof fetch;

    // 虚拟化可视高度 stub（行挂载前提）+ scrollIntoView mock
    scrollIntoViewMock = vi.fn();
    origScrollIntoView = (Element.prototype as unknown as { scrollIntoView?: (opts?: unknown) => void }).scrollIntoView;
    (Element.prototype as unknown as { scrollIntoView: (opts?: unknown) => void }).scrollIntoView =
      scrollIntoViewMock as unknown as (opts?: unknown) => void;
    origGBCR = Element.prototype.getBoundingClientRect.bind(Element.prototype);
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      return { height: 800, width: 480, top: 0, left: 0, right: 480, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    globalThis.fetch = ORIGINAL_FETCH;
    if (origGBCR) Element.prototype.getBoundingClientRect = origGBCR;
    if (origScrollIntoView) {
      (Element.prototype as unknown as { scrollIntoView: (opts?: unknown) => void }).scrollIntoView = origScrollIntoView;
    }
  });

  test("流内卡渲染于锚点后 + 提示条点击定位 + 权限卡仍在输入区上方（DOM 序）", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ChatView));
    });
    // 消息加载落库后注入双 pending（各自锚点）
    await act(async () => {
      useQuestionsStore.getState().pushRequest(SID, makeQuestionRequest("qr-1", "u1"));
      useQuestionsStore.getState().pushRequest(SID, makeQuestionRequest("qr-2", null));
    });

    // 流内卡：渲染在滚动容器内，各自锚点（u1 后一张、流末一张）
    const scroll = document.querySelector("[data-testid=chat-scroll]") as HTMLElement | null;
    expect(scroll).not.toBeNull();
    const inlineCards = [...(scroll?.querySelectorAll("[data-question-card-id]") ?? [])];
    expect(inlineCards).toHaveLength(2);
    expect(inlineCards[0]!.getAttribute("data-question-card-id")).toBe("qr-1");
    // u1 行在前、qr-1 卡紧随（虚拟行容器按 data-entry-key 断言相对序）
    const rowKeys = [...(scroll?.querySelectorAll("[data-entry-key]") ?? [])].map((el) => el.getAttribute("data-entry-key"));
    expect(rowKeys.indexOf("u1")).toBeGreaterThanOrEqual(0);
    expect(rowKeys.indexOf("u1")).toBeLessThan(rowKeys.indexOf("question-qr-1"));

    // 提示条在输入区上方（无权限时输入区正常形态）
    const hintBar = document.querySelector("[data-testid=question-hint-bar]");
    const composerInput = document.querySelector("[data-testid=composer-input]");
    expect(hintBar).not.toBeNull();
    expect(composerInput).not.toBeNull();
    expect(
      hintBar && composerInput
        ? Boolean(hintBar.compareDocumentPosition(composerInput) & Node.DOCUMENT_POSITION_FOLLOWING)
        : false,
    ).toBe(true); // 提示条 → 输入区

    // 权限卡仍在提示条上方（权限卡位置行为不动；权限锁下输入区转锁定形态另由
    // composer-waiting-hint 系测试锁定，此处只锁 DOM 序）
    await act(async () => {
      usePermissionsStore.getState().pushRequest(SID, {
        id: "perm-1",
        method: "input",
        title: "需要输入",
        placeholder: "补充",
      });
    });
    const permCard = document.querySelector("[data-testid^=permission-card-]");
    expect(permCard).not.toBeNull();
    const hintBar2 = document.querySelector("[data-testid=question-hint-bar]");
    expect(
      permCard && hintBar2
        ? Boolean(permCard.compareDocumentPosition(hintBar2) & Node.DOCUMENT_POSITION_FOLLOWING)
        : false,
    ).toBe(true); // 权限卡 → 提示条

    // 提示条点击定位流内卡（scrollIntoView mock 断言）
    scrollIntoViewMock.mockClear();
    await act(async () => {
      document.querySelector("[data-testid=question-hint-view]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(scrollIntoViewMock).toHaveBeenCalled();

    // 队列清空后提示条消失
    await act(async () => {
      useQuestionsStore.getState().removeRequest(SID, "qr-1");
      useQuestionsStore.getState().removeRequest(SID, "qr-2");
    });
    expect(document.querySelector("[data-testid=question-hint-bar]")).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  }, 20000);
});
