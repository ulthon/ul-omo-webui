/**
 * 流内错误卡（发送失败入流，对齐 CLI 信息流行为）挂载测试：
 * - pushError 后 data-testid=stream-error-card 渲染于消息流（最新消息之后），无 toast；
 * - 同刻同 text 未消不重复堆叠（pushError 去重）；
 * - 关闭钮（stream-error-dismiss）移除对应错误卡；
 * - mergeStreamErrors 纯函数：空错误原样返回（引用不变）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { StreamErrorCardBlock } = await import("@/components/chat/message-list");
const { buildMessageItems, mergeMemoryItems, mergeStreamErrors } = await import("@/components/chat/message-items");
const { useMessagesStore } = await import("@/stores/messages");
const { useUiStore } = await import("@/stores/ui");

const SID = "stream-error-fixture";

let root: ReturnType<typeof createRoot> | null = null;
const CONTAINERS: HTMLElement[] = [];

beforeEach(() => {
  useMessagesStore.getState().setEntries(SID, [{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "第一个问题" }] } }] as never, null, null);
});

afterEach(() => {
  for (const c of CONTAINERS) c.remove();
  CONTAINERS.length = 0;
  root = null;
  useMessagesStore.getState().clearSession(SID);
  useUiStore.setState({ toasts: [] });
});

describe("流内错误卡", () => {
  test("pushError 后流内含错误项（末尾）且无 toast", async () => {
    act(() => {
      useMessagesStore.getState().pushError(SID, "发送失败：连接被拒");
    });
    const st = useMessagesStore.getState().bySession[SID]!;
    expect(st.errors).toHaveLength(1);
    expect(st.errors[0].text).toBe("发送失败：连接被拒");
    // 合成层：错误项接在全部条目之后（最新消息后）
    const items = buildMessageItems(st.entries as never, { hasStreamingMessage: false, interrupted: false });
    const merged = mergeStreamErrors(mergeMemoryItems(items, st.entries), st.errors);
    expect(merged[merged.length - 1].kind).toBe("streamError");
    // 无 toast：ui store 零 toast，DOM 无 toast 节点
    expect(useUiStore.getState().toasts).toHaveLength(0);
    expect(document.querySelector('[data-testid="toast-item"]')).toBeNull();
  });

  test("错误卡渲染：text + 小字时间 + 关闭钮（data-testid）", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    CONTAINERS.push(container);
    const err = { id: "err-x", text: "发送失败：连接被拒", ts: new Date("2026-11-01T08:00:00").getTime() };
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(StreamErrorCardBlock, { sessionId: SID, error: err }));
      await Promise.resolve();
    });
    const card = container.querySelector('[data-testid="stream-error-card"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("发送失败：连接被拒");
    expect(card!.querySelector(".tabular-nums")!.textContent).toMatch(/\d/);
    expect(card!.querySelector('[data-testid="stream-error-dismiss"]')).not.toBeNull();
  });

  test("相同 text 未消时 pushError 不重复堆叠", () => {
    act(() => {
      useMessagesStore.getState().pushError(SID, "同一个错误");
      useMessagesStore.getState().pushError(SID, "同一个错误");
    });
    expect(useMessagesStore.getState().bySession[SID]!.errors).toHaveLength(1);
  });

  test("不同 text 各自成卡（多条并存）", () => {
    act(() => {
      useMessagesStore.getState().pushError(SID, "错误甲");
      useMessagesStore.getState().pushError(SID, "错误乙");
    });
    const errs = useMessagesStore.getState().bySession[SID]!.errors;
    expect(errs.map((e: { text: string }) => e.text)).toEqual(["错误甲", "错误乙"]);
  });

  test("关闭钮移除对应错误卡", async () => {
    act(() => {
      useMessagesStore.getState().pushError(SID, "错误甲");
      useMessagesStore.getState().pushError(SID, "错误乙");
    });
    const first = useMessagesStore.getState().bySession[SID]!.errors[0];
    const container = document.createElement("div");
    document.body.appendChild(container);
    CONTAINERS.push(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(StreamErrorCardBlock, { sessionId: SID, error: first }));
      await Promise.resolve();
    });
    const btn = container.querySelector('[data-testid="stream-error-dismiss"]');
    expect(btn).not.toBeNull();
    await act(async () => {
      (btn as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    const errs = useMessagesStore.getState().bySession[SID]!.errors;
    expect(errs.map((e: { text: string }) => e.text)).toEqual(["错误乙"]);
  });

  test("mergeStreamErrors：空错误原样返回（引用不变），非空尾部追加", async () => {
    const items = [{ key: "u1", kind: "entry" as const, entryId: "u1", interrupted: false, model: null }];
    expect(mergeStreamErrors(items, [])).toBe(items);
    const merged = mergeStreamErrors([], [{ id: "e1", text: "x", ts: 0 }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe("streamError");
  });
});
