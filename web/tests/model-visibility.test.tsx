// 模型可见性单测（2026-10-15 重写：B11 切换点分隔线退役，改为气泡头部常驻模型短名）：
// - messageModel 窄化访问器：正常 / 缺失 / 空串 / 非字符串 / 无 message（保留）
// - shortModelName：provider 前缀剥离（气泡头部 / 胶囊浮签共用）
// - buildMessageItems：不再产出 modelDivider 项（退役回归 pin）、条目保序、
//   流式项恒在末尾、interrupted 只标最后一条 assistant（保留回归 pin）
// - BubbleShell 助手头部行渲染模型短名（DOM 断言，非目测）
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

import { messageModel, shortModelName } from "@/lib/api";
import type { WireEntry, WireMessage } from "@/lib/api";
import { buildMessageItems, type ChatListItem } from "@/components/chat/message-items";

type MsgEntry = WireEntry & { id: string; message: WireMessage };

/** model === undefined 时不写 model 字段（构造老数据形态） */
function entry(id: string, role: string, model?: unknown): MsgEntry {
  const message: Record<string, unknown> = { role, content: [{ type: "text", text: "hi" }] };
  if (model !== undefined) message.model = model;
  return { type: "message", id, message } as MsgEntry;
}

const OPTS = { hasStreamingMessage: false, interrupted: false };

function entryIds(items: ChatListItem[]): string[] {
  const out: string[] = [];
  for (const i of items) if (i.kind === "entry") out.push(i.entryId);
  return out;
}

describe("messageModel 窄化访问器", () => {
  test("字符串 model 原样返回；空串/null/非字符串/无 message 一律 null", () => {
    expect(messageModel(entry("a", "assistant", "glm-5.3-flash"))).toBe("glm-5.3-flash");
    expect(messageModel(entry("a", "assistant", ""))).toBeNull();
    expect(messageModel(entry("a", "assistant", null))).toBeNull();
    expect(messageModel(entry("a", "assistant", 123))).toBeNull();
    expect(messageModel({ type: "message", id: "a" })).toBeNull();
  });
});

describe("shortModelName 模型短名", () => {
  test("provider/model 取首个 / 后段；无斜杠原样", () => {
    expect(shortModelName("zai-coding-cn/glm-5.3-4k")).toBe("glm-5.3-4k");
    expect(shortModelName("glm-5.3")).toBe("glm-5.3");
  });
});

describe("buildMessageItems（分隔线退役后）", () => {
  test("模型切换场景不再产出 modelDivider 项（退役回归 pin），条目保序", () => {
    const items = buildMessageItems(
      [
        entry("u1", "user"),
        entry("a1", "assistant", "model-a"),
        entry("a2", "assistant", "model-a"),
        entry("a3", "assistant", "model-b"),
      ],
      OPTS,
    );
    expect(items.filter((i) => i.kind === "modelDivider")).toEqual([]);
    expect(entryIds(items)).toEqual(["u1", "a1", "a2", "a3"]);
  });

  test("toolResult 不入列；无 model 老数据不报错", () => {
    const items = buildMessageItems([entry("t1", "toolResult"), entry("a1", "assistant")], OPTS);
    expect(entryIds(items)).toEqual(["a1"]);
  });

  test("流式项恒在末尾", () => {
    const items = buildMessageItems([entry("a1", "assistant", "model-a")], { hasStreamingMessage: true, interrupted: false });
    expect(items[items.length - 1]).toEqual({ key: "__streaming", kind: "streaming" });
  });

  test("interrupted 只标最后一条 assistant（回归 pin）", () => {
    const items = buildMessageItems([entry("a1", "assistant", "model-a"), entry("a2", "assistant", "model-a")], {
      hasStreamingMessage: false,
      interrupted: true,
    });
    const entries = items.filter((i) => i.kind === "entry");
    expect(entries.map((i) => (i.kind === "entry" ? i.interrupted : null))).toEqual([false, true]);
  });
});

describe("BubbleShell 助手头部模型短名（DOM 断言）", () => {
  test("assistant 头部行渲染模型短名；user 气泡无模型行", async () => {
    const { BubbleShell } = await import("@/components/chat/message-bubble");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          BubbleShell,
          { role: "assistant", timestamp: null, model: "zai-coding-cn/glm-5.3-4k" },
          createElement("div", null, "内容"),
        ),
      );
    });
    const header = container.querySelector("div.mb-1");
    expect(header).not.toBeNull();
    expect(header?.textContent).toContain("glm-5.3-4k");
    await act(async () => {
      root.render(
        createElement(
          BubbleShell,
          { role: "user", timestamp: null, model: "zai-coding-cn/glm-5.3-4k" },
          createElement("div", null, "内容"),
        ),
      );
    });
    expect(container.textContent).not.toContain("glm-5.3-4k");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

// docs08-r5 任务 12：流式态头部放宽为"正在回复 + 模型短名"（脉冲点保留）；settle 态不变；
// 无 model 字段（老数据/裸流）不误报。streamingModelOf 整链用 store 种子 + StreamingBubble 真渲染断言。
describe("流式头部模型短名（docs08-r5 任务 12）", () => {
  test("BubbleShell live 态：头部显示 正在回复 + 模型短名，脉冲点保留", async () => {
    const { BubbleShell } = await import("@/components/chat/message-bubble");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          BubbleShell,
          { role: "assistant", timestamp: null, model: "zai-coding-cn/glm-5.3-4k", live: true },
          createElement("div", null, "流式内容"),
        ),
      );
    });
    const header = container.querySelector("div.mb-1");
    expect(header).not.toBeNull();
    expect(header?.textContent).toContain("正在回复");
    expect(header?.textContent).toContain("glm-5.3-4k");
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  test("settle 态回归：标签 助手 + 短名保留，无脉冲点", async () => {
    const { BubbleShell } = await import("@/components/chat/message-bubble");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          BubbleShell,
          { role: "assistant", timestamp: null, model: "zai-coding-cn/glm-5.3-4k" },
          createElement("div", null, "定格内容"),
        ),
      );
    });
    const header = container.querySelector("div.mb-1");
    expect(header?.textContent).toContain("助手");
    expect(header?.textContent).toContain("glm-5.3-4k");
    expect(header?.textContent).not.toContain("正在回复");
    expect(container.querySelector(".animate-pulse")).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  /** 种一条流式 assistant 消息进 messages store（model 缺省时不写 model 字段，老数据形态） */
  async function seedStreaming(sessionId: string, model?: unknown) {
    const { useMessagesStore } = await import("@/stores/messages");
    const streamingMessage: Record<string, unknown> = { role: "assistant", content: [] };
    if (model !== undefined) streamingMessage.model = model;
    useMessagesStore.setState({
      bySession: {
        [sessionId]: {
          entries: [],
          cursor: null,
          leafId: null,
          loaded: true,
          streaming: true,
          streamingMessage,
          streamingEntryId: null,
          toolRuns: {},
        },
      },
    });
    return useMessagesStore;
  }

  test("store 种子 → StreamingBubble：live 头部透出短名（streamingModelOf 整链）", async () => {
    const store = await seedStreaming("s-t12", "zai-coding-cn/glm-5.3-4k");
    const { StreamingBubble } = await import("@/components/chat/message-bubble");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(StreamingBubble, { sessionId: "s-t12" }));
    });
    const header = container.querySelector("div.mb-1");
    expect(header?.textContent).toContain("正在回复");
    expect(header?.textContent).toContain("glm-5.3-4k");
    await act(async () => {
      root.unmount();
    });
    store.setState({ bySession: {} });
    container.remove();
  });

  test("无 model 流：StreamingBubble 渲染无报错无占位（老数据/裸流）", async () => {
    const store = await seedStreaming("s-t12-nomodel");
    const { StreamingBubble } = await import("@/components/chat/message-bubble");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(StreamingBubble, { sessionId: "s-t12-nomodel" }));
    });
    expect(container.querySelector("div.mb-1")?.textContent).toContain("正在回复");
    // 不误报：无短名 span，也无 undefined/null 占位文本泄漏
    expect(container.querySelector("div.mb-1")?.querySelector(".opacity-70")).toBeNull();
    expect(container.textContent).not.toContain("undefined");
    expect(container.textContent).not.toContain("null");
    await act(async () => {
      root.unmount();
    });
    store.setState({ bySession: {} });
    container.remove();
  });
});
