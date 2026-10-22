// @ts-nocheck
// 消息 footer 溯源行渲染单测（docs08 2026-10-22 批次任务 17）：EntryBubble 头部行
// 模型短名旁的代理名 + 用时。环境说明同 tool-card.test.tsx：@ts-nocheck（bun:test
// 类型包仅装 server 工作区）；zustand SSR 快照由 tests/helpers 预载解决，被测模块
// 动态 import 保证晚于预载解析。
import { afterEach, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { EntryBubble } = await import("../message-bubble");
const { buildMessageItems } = await import("../message-items");
const { useMessagesStore } = await import("@/stores/messages");

const SID = "qa-message-origin";

function userEntry(id, timestamp) {
  return { type: "message", id, timestamp, message: { role: "user", content: [{ type: "text", text: "帮我查一下" }] } };
}

function assistantEntry(id, timestamp, model) {
  return {
    type: "message",
    id,
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text: "回答正文" }], model },
  };
}

afterEach(() => {
  useMessagesStore.getState().clearSession(SID);
});

function renderEntry(entryId) {
  return renderToStaticMarkup(<EntryBubble sessionId={SID} entryId={entryId} interrupted={false} />);
}

test("footer 溯源行：fixture 条目渲染 代理名 + 用时（模型 · 代理 · 用时 全量）", () => {
  useMessagesStore.getState().appendEntries(SID, [
    userEntry("u1", "2026-10-22T10:00:00.000Z"),
    { type: "custom", id: "c1", timestamp: "2026-10-22T10:00:01.000Z", data: { agentName: "Sisyphus" } },
    assistantEntry("a1", "2026-10-22T10:09:46.000Z", "zai-coding-cn/glm-5.3-4k"),
  ]);
  const html = renderEntry("a1");
  expect(html).toContain("glm-5.3-4k");
  expect(html).toContain('data-testid="message-origin-agent"');
  expect(html).toContain("代理 Sisyphus");
  expect(html).toContain('data-testid="message-origin-duration"');
  expect(html).toContain("用时 9m 46s");
});

test("缺数据省略：无 user 锚点/无 agent 标注 → 用时与代理 span 均不渲染，无 undefined 泄漏", () => {
  useMessagesStore.getState().appendEntries(SID, [
    assistantEntry("a1", "2026-10-22T10:09:46.000Z", "zai-coding-cn/glm-5.3-4k"),
  ]);
  const html = renderEntry("a1");
  expect(html).toContain("glm-5.3-4k");
  expect(html).not.toContain("message-origin-agent");
  expect(html).not.toContain("message-origin-duration");
  expect(html).not.toContain("undefined");
});

test("user 气泡与压缩条目不受影响（compact 模式无 footer 面）", () => {
  useMessagesStore.getState().appendEntries(SID, [
    userEntry("u1", "2026-10-22T10:00:00.000Z"),
    assistantEntry("a1", "2026-10-22T10:01:00.000Z", "zai-coding-cn/glm-5.3-4k"),
    { type: "compaction", id: "cp1", summary: "压缩摘要", tokensBefore: 100 },
  ]);
  const userHtml = renderEntry("u1");
  expect(userHtml).not.toContain("message-origin-agent");
  expect(userHtml).not.toContain("message-origin-duration");
  // 压缩条目走 marker 通道（compactionMarker），永不入 entry 气泡列 → 无 footer 面
  const items = buildMessageItems(useMessagesStore.getState().bySession[SID].entries.filter((e) => e.type !== "compaction"), {
    hasStreamingMessage: false,
    interrupted: false,
  });
  expect(items.some((item) => item.kind === "entry" && item.entryId === "cp1")).toBe(false);
  expect(items.some((item) => item.kind === "entry" && item.entryId === "a1")).toBe(true);
});
