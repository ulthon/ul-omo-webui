// GFM 表格渲染回归（2026-10-15：用户实测模型回复的 markdown 表格未渲染成表格，
// 根因 = W5 重写渲染管线时未接 remark-gfm，remarkParse 默认 CommonMark 不含表格）。
// 结构断言：renderMarkdownCached 输出的 React 元素树应含 table/thead/th/td。
import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { renderMarkdownCached } from "@/components/chat/markdown";

function collectTags(node: ReactNode, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectTags(child, out);
    return;
  }
  if (!isValidElement(node)) return;
  if (typeof node.type === "string") out.add(node.type);
  const children = (node.props as { children?: ReactNode }).children;
  if (children !== undefined) collectTags(children, out);
}

describe("markdown GFM 表格", () => {
  test("GFM 表格渲染为 table 元素（th/td 齐全）", () => {
    const text = "| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |";
    const tags = new Set<string>();
    collectTags(renderMarkdownCached(text), tags);
    expect(tags.has("table")).toBe(true);
    expect(tags.has("th")).toBe(true);
    expect(tags.has("td")).toBe(true);
  });

  test("GFM 删除线渲染为 del 元素", () => {
    const tags = new Set<string>();
    collectTags(renderMarkdownCached("~~已废弃~~ 后续方案"), tags);
    expect(tags.has("del")).toBe(true);
  });

  test("无 GFM 语法干扰既有 CommonMark 渲染（标题/段落照常）", () => {
    const tags = new Set<string>();
    collectTags(renderMarkdownCached("## 标题\n\n段落文本"), tags);
    expect(tags.has("h2")).toBe(true);
    expect(tags.has("p")).toBe(true);
  });
});
