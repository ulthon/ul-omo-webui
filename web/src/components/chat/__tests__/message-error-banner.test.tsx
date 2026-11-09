// @ts-nocheck
// 消息级 stopReason 错误渲染（限流/额度错误主路径补齐）：
// - 定格：stopReason==="error" + errorMessage 非空 → MessageErrorBanner 渲染
//   message-error-banner（复用 ErrorPartCard 样式，原文 whitespace-pre-wrap）；
// - 流式：store streamingMessage 同字段 → StreamingErrorBanner 同样可见；
// - 去重：error part 文本与 errorMessage 相等时 part 卡跳过，消息级 banner 为准；
// - 无 errorMessage（缺失/非 error stopReason）不渲染。
// 环境同 parts-error-part.test.tsx：@happy-dom 全局注册 + renderToStaticMarkup。
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
const { PartsView, MessageErrorBanner, StreamingErrorBanner, messageErrorText } = await import("../parts");
const { useMessagesStore } = await import("@/stores/messages");

const RATE_LIMIT_TEXT = "429 rate limit exceeded: too many requests, retry in 30s";

describe("消息级 stopReason 错误渲染", () => {
  test("定格：stopReason=error + errorMessage 渲染 banner 与原文", () => {
    const text = messageErrorText({ role: "assistant", stopReason: "error", errorMessage: RATE_LIMIT_TEXT });
    expect(text).toBe(RATE_LIMIT_TEXT);
    const html = renderToStaticMarkup(createElement(MessageErrorBanner, { text }));
    expect(html).toContain('data-testid="message-error-banner"');
    expect(html).not.toContain('data-testid="message-error-part"');
    expect(html).toContain("retry in 30s");
    expect(html).toContain("whitespace-pre-wrap");
  });

  test("流式：streamingMessage stopReason=error 时 StreamingErrorBanner 可见", () => {
    useMessagesStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        s1: {
          ...s.bySession.s1,
          streamingMessage: {
            role: "assistant",
            stopReason: "error",
            errorMessage: RATE_LIMIT_TEXT,
            content: [{ type: "text", text: "partial answer" }],
          },
        },
      },
    }));
    try {
      const html = renderToStaticMarkup(createElement(StreamingErrorBanner, { sessionId: "s1" }));
      expect(html).toContain('data-testid="message-error-banner"');
      expect(html).toContain("429 rate limit exceeded");
    } finally {
      useMessagesStore.setState((s) => ({ bySession: { ...s.bySession, s1: { ...s.bySession.s1, streamingMessage: null } } }));
    }
  });

  test("去重：error part 文本与 errorMessage 相等时 part 卡跳过", () => {
    const html = renderToStaticMarkup(
      createElement(PartsView, {
        parts: [{ type: "error", message: RATE_LIMIT_TEXT }],
        sessionId: "s1",
        live: false,
        suppressErrorText: RATE_LIMIT_TEXT,
      })
    );
    expect(html).not.toContain('data-testid="message-error-part"');
    // 文本不同不去重，part 卡照常
    const html2 = renderToStaticMarkup(
      createElement(PartsView, {
        parts: [{ type: "error", message: RATE_LIMIT_TEXT }],
        sessionId: "s1",
        live: false,
        suppressErrorText: "other error",
      })
    );
    expect(html2).toContain('data-testid="message-error-part"');
  });

  test("无 errorMessage / 非 error stopReason 不渲染", () => {
    expect(messageErrorText({ role: "assistant", stopReason: "error" })).toBe("");
    expect(messageErrorText({ role: "assistant", errorMessage: RATE_LIMIT_TEXT })).toBe("");
    expect(messageErrorText(undefined)).toBe("");
    expect(renderToStaticMarkup(createElement(MessageErrorBanner, { text: "" }))).toBe("");
  });
});
