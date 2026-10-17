// 常用语单测（todo 14）：插入光标逻辑、4KB 字节边界（导入筛选/新增校验共用判定）、
// 移动排序与 sort 重编、直发/插入按钮禁用判定。
// SSR 段说明（同 chat/__tests__/tool-card.test.tsx）：renderToStaticMarkup 锁定
// SnippetEntryList 在 actionDisabled 两态下的 disabled 属性（「直发 busy/sending 禁用」
// 的展示契约；完整交互走浏览器 QA .omo/qa/W4/snippets.md）。
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { InputHistoryItem } from "@/lib/api";
import {
  SNIPPET_MAX_BYTES,
  insertSnippet,
  isSnippetOverLimit,
  moveSnippet,
  partitionImportable,
  renumberSnippets,
  snippetActionDisabled,
  utf8ByteLength,
} from "@/components/composer/snippet-logic";

const { SnippetEntryList } = await import("@/components/composer/snippet-panel");

const noop = () => {};

describe("insertSnippet 插入光标逻辑", () => {
  test("空文本插入：内容即全文，光标落末尾", () => {
    expect(insertSnippet("", 0, "你好")).toEqual({ content: "你好", caret: 2 });
  });

  test("有草稿时在光标处插入并拼接，光标落插入内容之后", () => {
    expect(insertSnippet("前缀", 2, "内容")).toEqual({ content: "前缀内容", caret: 4 });
    expect(insertSnippet("AB|CD", 3, "X")).toEqual({ content: "AB|XCD", caret: 4 });
  });

  test("caret 越界钳制到 [0, length]（负数归 0，超长归末尾）", () => {
    expect(insertSnippet("ab", -5, "X")).toEqual({ content: "Xab", caret: 1 });
    expect(insertSnippet("ab", 99, "X")).toEqual({ content: "abX", caret: 3 });
  });
});

describe("4KB 字节边界（与服务端 SNIPPET_MAX_BYTES 对齐）", () => {
  test("utf8ByteLength：ASCII 1 字节、中文 3 字节", () => {
    expect(utf8ByteLength("a".repeat(10))).toBe(10);
    expect(utf8ByteLength("中".repeat(3))).toBe(9);
  });

  test("isSnippetOverLimit：4096 字节通过（含边界），4097 拒绝", () => {
    expect(SNIPPET_MAX_BYTES).toBe(4096);
    expect(isSnippetOverLimit("a".repeat(4096))).toBe(false);
    // 4093 个 ASCII + 1 个中文 = 4096 字节（多字节内容贴边）
    expect(isSnippetOverLengthCase(4093, 1)).toBe(false);
    expect(isSnippetOverLimit("a".repeat(4097))).toBe(true);
    // 4094 个 ASCII + 1 个中文 = 4097 字节
    expect(isSnippetOverLengthCase(4094, 1)).toBe(true);
  });

  /** 构造 ascii+中文混合字节长度再判定 */
  function isSnippetOverLengthCase(ascii: number, cjk: number): boolean {
    return isSnippetOverLimit("a".repeat(ascii) + "中".repeat(cjk));
  }
});

describe("partitionImportable 导入筛选", () => {
  const item = (id: number, content: string): InputHistoryItem => ({ id, projectPath: "/p", content, createdAt: "" });

  test("可导入与超限分组，各自保持原顺序", () => {
    const items = [
      item(1, "小条目"),
      item(2, "a".repeat(4097)),
      item(3, "b".repeat(4096)),
      item(4, "a".repeat(4098)),
    ];
    const parts = partitionImportable(items);
    expect(parts.importable.map((x) => x.id)).toEqual([1, 3]);
    expect(parts.oversized.map((x) => x.id)).toEqual([2, 4]);
  });

  test("全部可导入 / 全部超限 / 空列表", () => {
    expect(partitionImportable([item(1, "x")]).oversized).toEqual([]);
    expect(partitionImportable([item(1, "a".repeat(4097))]).importable).toEqual([]);
    expect(partitionImportable([])).toEqual({ importable: [], oversized: [] });
  });
});

describe("moveSnippet 与 renumberSnippets", () => {
  test("上移/下移交换相邻；首行上移与末行下移无变化", () => {
    const list = ["a", "b", "c"];
    expect(moveSnippet(list, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveSnippet(list, 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveSnippet(list, 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveSnippet(list, 2, 1)).toEqual(["a", "b", "c"]);
    // 不改原数组
    expect(list).toEqual(["a", "b", "c"]);
  });

  test("renumberSnippets：sort 重编为索引序", () => {
    expect(renumberSnippets([{ content: "x", sort: 5 }, { content: "y", sort: 0 }])).toEqual([
      { content: "x", sort: 0 },
      { content: "y", sort: 1 },
    ]);
  });
});

describe("snippetActionDisabled 直发/插入禁用判定", () => {
  test("busy 或 sending 任一为真即禁用", () => {
    expect(snippetActionDisabled(false, false)).toBe(false);
    expect(snippetActionDisabled(true, false)).toBe(true);
    expect(snippetActionDisabled(false, true)).toBe(true);
    expect(snippetActionDisabled(true, true)).toBe(true);
  });
});

describe("SnippetEntryList 禁用属性（SSR 契约）", () => {
  const entries = [{ content: "帮我写个单测", sort: 0 }];

  test("actionDisabled=true：条目与直发按钮均带 disabled", () => {
    const html = renderToStaticMarkup(
      <SnippetEntryList
        scope="global"
        label="全局常用语"
        entries={entries}
        actionDisabled
        onInsert={noop}
        onSendNow={noop}
      />,
    );
    expect(html).toContain('data-testid="snippet-item-global-0"');
    expect(html).toContain('data-testid="snippet-send-global-0"');
    // React 对 disabled={true} 输出 disabled="" 属性（类名中的 disabled: 变体不匹配）
    expect(html.match(/disabled=""/g)?.length).toBe(2);
    // 预览文本渲染（多行折叠单行）
    expect(html).toContain("帮我写个单测");
  });

  test("actionDisabled=false：按钮可点（无 disabled 属性）", () => {
    const html = renderToStaticMarkup(
      <SnippetEntryList scope="project" label="项目" entries={entries} actionDisabled={false} onInsert={noop} onSendNow={noop} />,
    );
    expect(html).not.toContain('disabled=""');
  });

  test("空列表渲染空提示", () => {
    const html = renderToStaticMarkup(
      <SnippetEntryList scope="global" label="全局" entries={[]} actionDisabled={false} onInsert={noop} onSendNow={noop} />,
    );
    expect(html).toContain("暂无");
  });
});
