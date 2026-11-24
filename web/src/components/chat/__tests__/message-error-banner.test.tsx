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
const { ErrorRunCardBlock, StreamErrorCardBlock } = await import("../message-list");
const { useMessagesStore } = await import("@/stores/messages");
const { useLocaleStore } = await import("@/i18n/i18n");

useLocaleStore.setState({ locale: "zh-CN" });

const RATE_LIMIT_TEXT = "429 rate limit exceeded: too many requests, retry in 30s";

describe("消息级 stopReason 错误渲染", () => {
  test("定格：stopReason=error + errorMessage 渲染 banner 与原文", () => {
    const msg = { role: "assistant", stopReason: "error", errorMessage: RATE_LIMIT_TEXT };
    const text = messageErrorText(msg);
    expect(text).toBe(RATE_LIMIT_TEXT);
    const html = renderToStaticMarkup(createElement(MessageErrorBanner, { message: msg }));
    expect(html).toContain('data-testid="message-error-banner"');
    expect(html).not.toContain('data-testid="message-error-part"');
    expect(html).toContain("retry in 30s");
    expect(html).toContain("whitespace-pre-wrap");
  });

  test("归类标签（罗列收敛批 2026-11-21）：引擎结构化字段命中时贴标签前缀，缺席不贴", () => {
    // errorCause.type=usage_limit → 额度用完
    const usage = renderToStaticMarkup(
      createElement(MessageErrorBanner, {
        message: { role: "assistant", stopReason: "error", errorMessage: "limit reached", errorCause: { type: "usage_limit" } },
      })
    );
    expect(usage).toContain("额度用完 · ");
    // providerDiagnostic.httpStatus=429 → 限流
    const rate = renderToStaticMarkup(
      createElement(MessageErrorBanner, {
        message: { role: "assistant", stopReason: "error", errorMessage: "429 boom", providerDiagnostic: { httpStatus: 429 } },
      })
    );
    expect(rate).toContain("限流 · ");
    // 无结构化字段 → 不贴标签只显原文
    const bare = renderToStaticMarkup(
      createElement(MessageErrorBanner, { message: { role: "assistant", stopReason: "error", errorMessage: "429 boom" } })
    );
    expect(bare).not.toContain("限流 · ");
    expect(bare).not.toContain("额度用完 · ");
    expect(bare).toContain("429 boom");
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
    expect(renderToStaticMarkup(createElement(MessageErrorBanner, { message: undefined }))).toBe("");
    expect(renderToStaticMarkup(createElement(MessageErrorBanner, { message: { role: "assistant", stopReason: "error" } }))).toBe("");
  });
});

describe("折叠卡与计数徽标渲染（罗列收敛批 2026-11-21）", () => {
  test("ErrorRunCardBlock：×N 徽标 + 归类标签 + 末次时间 + 原文", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorRunCardBlock, {
        item: {
          key: "error-run-e1",
          kind: "errorRun",
          entryId: "e1",
          text: RATE_LIMIT_TEXT,
          count: 3,
          lastTs: new Date("2026-11-21T07:00:00Z").getTime(),
          category: "rateLimit",
        },
      })
    );
    expect(html).toContain('data-testid="error-run-card"');
    expect(html).toContain("×3");
    expect(html).toContain("限流 · ");
    expect(html).toContain(RATE_LIMIT_TEXT);
  });

  test("ErrorRunCardBlock：count=1 无徽标，无归类不贴标签", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorRunCardBlock, {
        item: { key: "error-run-e1", kind: "errorRun", entryId: "e1", text: RATE_LIMIT_TEXT, count: 1, lastTs: null, category: null },
      })
    );
    expect(html).not.toContain("×");
    expect(html).not.toContain("限流");
    expect(html).toContain(RATE_LIMIT_TEXT);
  });

  test("StreamErrorCardBlock：同文计数 >1 显示 ×N 与最近一次时间", () => {
    const html = renderToStaticMarkup(
      createElement(StreamErrorCardBlock, { sessionId: "s1", error: { id: "err-1", text: "发送失败", ts: 1_000_000, count: 4 } })
    );
    expect(html).toContain('data-testid="stream-error-card"');
    expect(html).toContain("×4");
    expect(html).toContain("发送失败");
  });
});
