// thinking_level_changed 消费单测（W2 todo 8）：引擎回显仅同步前台选中会话的 chip；
// 后台会话（SSE 全局多路复用）不得篡改前台选择。显示层同步——零 PATCH、零偏好写入。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useMessagesStore } from "@/stores/messages";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { dispatchSseEvent, resetDispatchState } from "@/lib/event-dispatch";

const ORIGINAL_FETCH = globalThis.fetch;
let patchCount = 0;

beforeEach(() => {
  patchCount = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "PATCH") patchCount++;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  useUiStore.setState({
    selectedThinkingLevel: "low",
    currentProject: "/p1",
    projects: [{ projectPath: "/p1", preferredModel: null, lastOpenedAt: null }],
    toast: null,
  });
  useSessionsStore.setState({ selectedId: "s1" });
  useMessagesStore.setState({ bySession: {} });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  resetDispatchState();
});

describe("applyWireEvent：thinking_level_changed 同会话同步", () => {
  test("选中会话的事件 → selectedThinkingLevel 跟随", () => {
    useMessagesStore.getState().applyWireEvent("s1", { type: "thinking_level_changed", level: "max" });
    expect(useUiStore.getState().selectedThinkingLevel).toBe("max");
  });

  test("跨会话事件（不同 durableSessionId）→ 前台 chip 不动", () => {
    useMessagesStore.getState().applyWireEvent("s2", { type: "thinking_level_changed", level: "max" });
    expect(useUiStore.getState().selectedThinkingLevel).toBe("low");
  });

  test("level 缺失 / 非字符串 → 忽略", () => {
    useMessagesStore.getState().applyWireEvent("s1", { type: "thinking_level_changed" });
    useMessagesStore.getState().applyWireEvent("s1", { type: "thinking_level_changed", level: 42 });
    expect(useUiStore.getState().selectedThinkingLevel).toBe("low");
  });

  test("显示层同步：零 PATCH（不落偏好）", async () => {
    useMessagesStore.getState().applyWireEvent("s1", { type: "thinking_level_changed", level: "high" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(patchCount).toBe(0);
  });
});

describe("dispatchSseEvent：信封 durableSessionId 路由（完整分发链）", () => {
  test("信封指向选中会话 → 同步；指向后台会话 → 不同步", () => {
    dispatchSseEvent(
      "thinking_level_changed",
      JSON.stringify({ event: { type: "thinking_level_changed", level: "high" }, durableSessionId: "s1" }),
      1,
    );
    expect(useUiStore.getState().selectedThinkingLevel).toBe("high");

    dispatchSseEvent(
      "thinking_level_changed",
      JSON.stringify({ event: { type: "thinking_level_changed", level: "low" }, durableSessionId: "s9" }),
      2,
    );
    expect(useUiStore.getState().selectedThinkingLevel).toBe("high");
  });
});
