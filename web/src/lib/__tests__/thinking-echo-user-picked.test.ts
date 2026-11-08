// 思考档三链 B：引擎 thinking_level_changed 回显条件化——用户显式手选过的档位不被
// 引擎回显覆盖（引擎自身 settings.json 默认 high 会把手选 max 打回）；未手选（回退链/
// 程序化链）照常同步；程序化落定（applyProjectDecision / 建会话链）清手选标记后恢复同步。
// @ts-nocheck
import { describe, expect, test, beforeEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");

const SID = "th-echo-1";

function echo(level: string) {
  useMessagesStore.getState().applyWireEvent(SID, { type: "thinking_level_changed", level });
}

beforeEach(() => {
  useMessagesStore.setState({ bySession: {} });
  useSessionsStore.setState({ selectedId: SID });
  useUiStore.setState({ selectedThinkingLevel: null, userPickedThinking: false });
});

describe("thinking_level_changed 回显（思考档三链 B）", () => {
  test("未手选：引擎回显照常同步 chip", () => {
    echo("high");
    expect(useUiStore.getState().selectedThinkingLevel).toBe("high");
  });

  test("手选 max 后引擎回显 high 不覆盖显示", () => {
    useUiStore.getState().pickThinkingLevel("max");
    echo("high");
    expect(useUiStore.getState().selectedThinkingLevel).toBe("max");
    expect(useUiStore.getState().userPickedThinking).toBe(true);
  });

  test("程序化落定清手选标记：回显恢复同步", () => {
    useUiStore.getState().pickThinkingLevel("max");
    useUiStore.getState().setSelectedThinkingLevel("low");
    useUiStore.getState().clearUserPickedThinking();
    echo("high");
    expect(useUiStore.getState().selectedThinkingLevel).toBe("high");
  });

  test("非选中会话的回显不篡改前台 chip（既有口径回归）", () => {
    useSessionsStore.setState({ selectedId: "other-session" });
    echo("high");
    expect(useUiStore.getState().selectedThinkingLevel).toBeNull();
  });
});
