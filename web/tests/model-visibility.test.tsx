// 模型可见性单测（2026-10-15 重写：B11 切换点分隔线退役，改为气泡头部常驻模型短名）：
// - messageModel 窄化访问器：正常 / 缺失 / 空串 / 非字符串 / 无 message（保留）
// - shortModelName：provider 前缀剥离（气泡头部 / 胶囊浮签共用）
// - buildMessageItems：不再产出 modelDivider 项（退役回归 pin）、条目保序、
//   流式项恒在末尾、interrupted 只标最后一条 assistant（保留回归 pin）
// - BubbleShell 助手头部行渲染模型短名（DOM 断言，非目测）
import { describe, expect, test } from "bun:test";
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
