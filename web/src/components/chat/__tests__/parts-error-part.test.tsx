// @ts-nocheck
// 模型错误 part 渲染（fix: 限流/额度/上下文超限等 error part 此前无分支渲染为空白）：
// - 定格 PartsView：type:"error" part 渲染红色错误卡（testid=message-error-part，
//   destructive 色系 + 错误原文），文本鸭子形提取 {message} 形态；
// - {error:{message}} 嵌套形态（AI SDK 风格）同卡呈现；
// - retry 提示文本原样随文显示（"retry in Xs" 不翻译不剥离）；
// - 流式 StreamingParts：store streamingMessage 含 error part 时同卡可见（同一
//   PartView 分发，定格/流式形态一致）。
// 环境（collision-error-card 惯例）：@happy-dom 全局注册 + 被测模块动态 import；
// 渲染断言 renderToStaticMarkup + 查询 data-testid。
import { describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
window.matchMedia = ((query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PartsView, StreamingParts } = await import("../parts");
const { useMessagesStore } = await import("@/stores/messages");

const RATE_LIMIT_TEXT = "429 rate limit exceeded: too many requests, retry in 30s";

function renderParts(parts: unknown[]): string {
  return renderToStaticMarkup(
    createElement(PartsView, { parts, sessionId: "s1", live: false })
  );
}

describe("parts error part 渲染", () => {
  test("定格：{message} 形态渲染错误卡与原文（含 retry 提示）", () => {
    const html = renderParts([{ type: "error", message: RATE_LIMIT_TEXT }]);
    expect(html).toContain('data-testid="message-error-part"');
    expect(html).toContain("429 rate limit exceeded");
    expect(html).toContain("retry in 30s");
    expect(html).not.toContain("unsupported-chip");
  });

  test("定格：{error:{message}} 嵌套形态提取文本", () => {
    const html = renderParts([
      { type: "error", error: { name: "UsageLimitError", message: "usage limit has been reached" } },
    ]);
    expect(html).toContain('data-testid="message-error-part"');
    expect(html).toContain("usage limit has been reached");
  });

  test("定格：text 字段形态同样渲染", () => {
    const html = renderParts([{ type: "error", text: "context length exceeded" }]);
    expect(html).toContain('data-testid="message-error-part"');
    expect(html).toContain("context length exceeded");
  });

  test("流式：store streamingMessage 含 error part 时同卡可见", () => {
    useMessagesStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        s1: {
          ...s.bySession.s1,
          streamingMessage: {
            role: "assistant",
            content: [
              { type: "text", text: "partial answer" },
              { type: "error", message: RATE_LIMIT_TEXT },
            ],
          },
        },
      },
    }));
    try {
      const html = renderToStaticMarkup(createElement(StreamingParts, { sessionId: "s1" }));
      expect(html).toContain('data-testid="message-error-part"');
      expect(html).toContain("429 rate limit exceeded");
      expect(html).toContain("partial answer");
    } finally {
      useMessagesStore.setState((s) => ({ bySession: { ...s.bySession, s1: { ...s.bySession.s1, streamingMessage: null } } }));
    }
  });
});
