// B11 模型切换点标记单测（docs08-r3 任务 15）：
// - messageModel 窄化访问器：正常 / 缺失 / 空串 / 非字符串 / 无 message
// - buildMessageItems：首条 assistant 初始标记、切换点标记、连续同模型无标记、
//   用户消息不插标记、无 model 字段（老数据）不显示不报错且不更新比较基线、
//   流式项恒在末尾且不带标记、interrupted 只标最后一条 assistant（回归 pin）
// - ModelDivider 组件渲染：data-testid/data-model DOM 断言（非目测）
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

import { messageModel } from "@/lib/api";
import type { WireEntry, WireMessage } from "@/lib/api";
import { buildMessageItems, type ChatListItem } from "@/components/chat/message-items";
import { ModelDivider } from "@/components/chat/message-list";

type MsgEntry = WireEntry & { id: string; message: WireMessage };

/** model === undefined 时不写 model 字段（构造老数据形态） */
function entry(id: string, role: string, model?: unknown): MsgEntry {
  const message: Record<string, unknown> = { role, content: [{ type: "text", text: "hi" }] };
  if (model !== undefined) message.model = model;
  return { type: "message", id, message } as MsgEntry;
}

const OPTS = { hasStreamingMessage: false, interrupted: false };

function dividerModels(items: ChatListItem[]): string[] {
  const out: string[] = [];
  for (const i of items) if (i.kind === "modelDivider") out.push(i.model);
  return out;
}

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

describe("buildMessageItems：模型切换点标记", () => {
  test("首条 assistant 有初始标记（divider 在其前）", () => {
    const items = buildMessageItems([entry("u1", "user"), entry("a1", "assistant", "model-a")], OPTS);
    expect(dividerModels(items)).toEqual(["model-a"]);
    expect(items.findIndex((i) => i.kind === "modelDivider")).toBeLessThan(
      items.findIndex((i) => i.kind === "entry" && i.entryId === "a1"),
    );
  });

  test("切换点标记：A 段一条标记，切 B 处一条标记，段内无重复", () => {
    const items = buildMessageItems(
      [entry("a1", "assistant", "model-a"), entry("a2", "assistant", "model-a"), entry("a3", "assistant", "model-b")],
      OPTS,
    );
    expect(dividerModels(items)).toEqual(["model-a", "model-b"]);
    expect(entryIds(items)).toEqual(["a1", "a2", "a3"]);
    const bDivider = items.findIndex((i) => i.kind === "modelDivider" && i.model === "model-b");
    const a3 = items.findIndex((i) => i.kind === "entry" && i.entryId === "a3");
    expect(bDivider).toBe(a3 - 1); // 紧贴切换后的首条
  });

  test("连续同模型多段（A→A→B→B）只在两处出现标记", () => {
    const items = buildMessageItems(
      [
        entry("a1", "assistant", "model-a"),
        entry("a2", "assistant", "model-a"),
        entry("a3", "assistant", "model-b"),
        entry("a4", "assistant", "model-b"),
      ],
      OPTS,
    );
    expect(dividerModels(items)).toEqual(["model-a", "model-b"]);
  });

  test("用户消息间插不插标记、不影响比对", () => {
    const items = buildMessageItems(
      [entry("u0", "user"), entry("a1", "assistant", "model-a"), entry("u1", "user"), entry("a2", "assistant", "model-a")],
      OPTS,
    );
    expect(dividerModels(items)).toEqual(["model-a"]);
  });

  test("无 model 字段（老数据）不显示标记不报错", () => {
    const items = buildMessageItems([entry("a1", "assistant"), entry("a2", "assistant")], OPTS);
    expect(dividerModels(items)).toEqual([]);
    expect(entryIds(items)).toEqual(["a1", "a2"]);
  });

  test("空串/null model 与缺失同待遇（不显示、不更新基线）", () => {
    expect(dividerModels(buildMessageItems([entry("a1", "assistant", ""), entry("a2", "assistant", null)], OPTS))).toEqual([]);
    // null-model 条目夹在两段同模型之间：不更新基线，后续同模型不误报切换
    const items = buildMessageItems(
      [entry("a1", "assistant", "model-a"), entry("a2", "assistant", ""), entry("a3", "assistant", "model-a")],
      OPTS,
    );
    expect(dividerModels(items)).toEqual(["model-a"]);
  });

  test("老数据后首条带 model 的 assistant 视为首条出标记", () => {
    const items = buildMessageItems([entry("a1", "assistant"), entry("a2", "assistant", "model-a")], OPTS);
    expect(dividerModels(items)).toEqual(["model-a"]);
  });

  test("流式项恒在末尾且不带标记（流式期间无标记抖动的组装面保障）", () => {
    const items = buildMessageItems([entry("a1", "assistant", "model-a")], { hasStreamingMessage: true, interrupted: false });
    expect(dividerModels(items)).toEqual(["model-a"]);
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

describe("ModelDivider 组件渲染（DOM 断言）", () => {
  test("渲染 data-testid=model-divider 与 data-model 原样模型名", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ModelDivider, { model: "glm-5.3-flash" }));
    });
    const el = container.querySelector('[data-testid="model-divider"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute("data-model")).toBe("glm-5.3-flash");
    expect(el?.textContent).toContain("glm-5.3-flash");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
