// 按叶路径渲染组件面单测（session-branching todo 4 QA）：多分支 fixture 经
// filterEntriesToPath（chat-view messageEntries 同构管线）+ buildMessageItems 组装后
// renderToStaticMarkup——断言渲染输出（非日志）只有当前路径条目、兄弟分支条目缺席；
// parentId 环 fixture 断言收敛不死循环。环境说明同 tool-card.test.tsx（@ts-nocheck +
// 动态 import + renderToStaticMarkup）。
// @ts-nocheck
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const { filterEntriesToPath } = await import("@/components/chat/branch-path-data");
const { buildMessageItems } = await import("@/components/chat/message-items");

function msg(id, parentId, role, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }] },
  };
}

/** chat-view messageEntries → items 同构管线（typeOk 取消息面），渲染为行 div */
function renderChat(entries, storeLeafId, viewLeafId = null) {
  const { windowEntries } = filterEntriesToPath(
    entries,
    viewLeafId,
    storeLeafId,
    (e) => e.type === "message",
  );
  const items = buildMessageItems(windowEntries, { hasStreamingMessage: false, interrupted: false });
  const rows = items
    .filter((i) => i.kind === "entry" || i.kind === "customMessage")
    .map((i) => {
      const e = windowEntries.find((x) => x.id === i.entryId);
      const text = ((e && e.message && e.message.content) || []).map((p) => p.text || "").join("");
      return createElement("div", { "data-testid": `row-${i.entryId}`, key: i.key }, text);
    });
  return renderToStaticMarkup(createElement("div", null, rows));
}

describe("多分支 fixture 按叶渲染（todo 4 QA）", () => {
  const entries = [
    msg("u1", null, "user", "第一个问题"),
    msg("a1", "u1", "assistant", "第一答"),
    msg("u2", "a1", "user", "主线第二问"),
    msg("u2x", "a1", "user", "兄弟分支第二问"),
    msg("a2", "u2", "assistant", "主线第二答"),
    msg("a2x", "u2x", "assistant", "兄弟分支第二答"),
  ];

  test("happy：文件叶起点只渲当前路径（u1→a1→u2→a2），兄弟分支条目缺席", () => {
    const html = renderChat(entries, "a2");
    expect(html).toContain("第一个问题");
    expect(html).toContain("第一答");
    expect(html).toContain("主线第二问");
    expect(html).toContain("主线第二答");
    expect(html).not.toContain("兄弟分支第二问"); // 兄弟分支 user 缺席
    expect(html).not.toContain("兄弟分支第二答"); // 兄弟分支 assistant 缺席
    expect(html).toContain('data-testid="row-u1"');
    expect(html).not.toContain('data-testid="row-u2x"');
    expect(html).not.toContain('data-testid="row-a2x"');
  });

  test("切叶到兄弟分支（viewLeafId 语义）：只渲兄弟路径，主线尾部缺席", () => {
    const html = renderChat(entries, "a2", "a2x");
    expect(html).toContain("兄弟分支第二问");
    expect(html).toContain("兄弟分支第二答");
    expect(html).not.toContain("主线第二问");
    expect(html).not.toContain("主线第二答");
  });

  test("failure：parentId 环 fixture 收敛不死循环，环成员全部在场（环外根不可达）", () => {
    const cyclic = [
      msg("root", null, "user", "根"),
      msg("a", "b", "assistant", "环甲"),
      msg("b", "a", "assistant", "环乙"),
      msg("c", "a", "user", "环下问"),
    ];
    const html = renderChat(cyclic, "c");
    expect(html).toContain("环甲");
    expect(html).toContain("环乙");
    expect(html).toContain("环下问");
    // 环外根不可达：visited 守卫在环内收敛，不无限回溯（防环语义）
    expect(html).not.toContain("根");
  });
});
