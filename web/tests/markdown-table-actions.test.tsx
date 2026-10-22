// 表格行操作测试（todo 8）：纯助手（TSV/CSV 序列化/DOM 读数）+ 结构（移动端常显/桌面悬停
// 类切换、每行操作单元格）+ 交互（复制表格 TSV/下载 CSV wiring，happy-dom 真点击）。环境沿
// session-dialogs.test.tsx：GlobalRegistrator 双注册守卫 + IS_REACT_ACT_ENVIRONMENT。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// 剪贴板 mock 须先于被测模块（markdown.tsx 顶层 import copyText）
const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyText }));

const {
  ROW_ACTIONS_CELL_CLASS,
  csvEscapeField,
  downloadTableCsv,
  rowCellsFromDom,
  tableDataFromDom,
  tableToCsv,
  tableToTsv,
} = await import("@/components/chat/markdown-table");
const { Markdown } = await import("@/components/chat/markdown");
const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { useUiStore } = await import("@/stores/ui");

/** 含逗号/引号/中文的 fixture 表格（3 列表头 + 2 数据行） */
const TABLE_MD = ['| 名称 | 数值 | 备注 |', '| --- | --- | --- |', '| 甲 | 1 | 普通 |', '| 乙,丙 | 2 | 含"引号" |'].join(
  "\n",
);

/** 构造真实 DOM 表格：th 表头行 + 含行内标记的数据行 */
function domTable(): { table: HTMLTableElement; headerRow: HTMLTableRowElement; bodyRow: HTMLTableRowElement } {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const name of ["名称", "数值"]) {
    const th = document.createElement("th");
    th.textContent = name;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  const tbody = document.createElement("tbody");
  const bodyRow = document.createElement("tr");
  const strong = document.createElement("td");
  strong.innerHTML = "<strong>甲</strong> 1";
  const plain = document.createElement("td");
  plain.textContent = "普通";
  bodyRow.append(strong, plain);
  tbody.appendChild(bodyRow);
  table.append(thead, tbody);
  return { table, headerRow, bodyRow };
}

describe("markdown-table 纯助手", () => {
  test("tableToTsv：制表符分隔、行\\n 分隔、行列一致（TSV 列对齐）", () => {
    const tsv = tableToTsv({
      header: ["名称", "数值", "备注"],
      rows: [
        ["甲", "1", "普通"],
        ["乙,丙", '2', '含"引号"'],
      ],
    });
    expect(tsv).toBe("名称\t数值\t备注\n甲\t1\t普通\n乙,丙\t2\t含\"引号\"");
    // 列对齐：每行制表符分段数一致（3 列 → 每行 3 段）
    const lines = tsv.split("\n");
    expect(lines.map((l) => l.split("\t").length)).toEqual([3, 3, 3]);
  });

  test("tableToTsv：逗号/引号格原样（TSV 无引号机制）；空表输出空串不崩", () => {
    expect(tableToTsv({ header: ["a,b"], rows: [['c"d'], ["e\tf"]] })).toBe('a,b\nc"d\ne\tf');
    expect(tableToTsv({ header: [], rows: [] })).toBe("");
  });

  test("csvEscapeField：RFC4180（逗号/引号/换行加引号，内部引号翻倍；普通值原样）", () => {
    expect(csvEscapeField("plain")).toBe("plain");
    expect(csvEscapeField("中文")).toBe("中文");
    expect(csvEscapeField("a,b")).toBe('"a,b"');
    expect(csvEscapeField('a"b')).toBe('"a""b"');
    expect(csvEscapeField("a\nb")).toBe('"a\nb"');
    expect(csvEscapeField('x,"y",z')).toBe('"x,""y"",z"');
  });

  test("tableToCsv：表头+数据行行列一致，逗号/引号/换行格转义正确", () => {
    const csv = tableToCsv({
      header: ["名称", "数值"],
      rows: [
        ["甲", "1"],
        ["乙,丙", '含"引"号'],
        ["多\n行", "ok"],
      ],
    });
    expect(csv).toBe('名称,数值\n甲,1\n"乙,丙","含""引""号"\n"多\n行",ok');
  });

  test("tableToCsv：空表（无表头无数据行）输出空串不崩", () => {
    expect(tableToCsv({ header: [], rows: [] })).toBe("");
  });

  test("rowCellsFromDom：行内标记只取文字并归一空白（含制表符折叠）；跳过行操作单元格", () => {
    const { bodyRow } = domTable();
    const actions = document.createElement("td");
    actions.className = ROW_ACTIONS_CELL_CLASS;
    actions.textContent = "按钮区";
    bodyRow.appendChild(actions);
    const tabCell = document.createElement("td");
    tabCell.textContent = "a\tb";
    bodyRow.appendChild(tabCell);
    expect(rowCellsFromDom(bodyRow)).toEqual(["甲 1", "普通", "a b"]);
  });

  test("tableDataFromDom：th 行归表头、td 行归数据；空表零行不崩", () => {
    const { table } = domTable();
    expect(tableDataFromDom(table)).toEqual({ header: ["名称", "数值"], rows: [["甲 1", "普通"]] });
    expect(tableDataFromDom(document.createElement("table"))).toEqual({ header: [], rows: [] });
  });
});

describe("markdown 表格行操作结构", () => {
  test("类切换：按钮容器移动端常显（opacity-100）、桌面悬停显（lg:group-hover/row），行挂命名组 group/row", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: TABLE_MD }));
    expect(html).toContain("group/row");
    expect(html).toContain("lg:opacity-0");
    expect(html).toContain("lg:group-hover/row:opacity-100");
    expect(html).toContain("opacity-100");
  });

  test("每行（含表头行）都有操作单元格，双钮 aria-label 与 title 齐备（复制表格/下载 CSV）", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: TABLE_MD }));
    expect((html.match(/table-row-actions-cell/g) ?? []).length).toBe(3);
    expect((html.match(/aria-label="复制表格"/g) ?? []).length).toBe(3);
    expect((html.match(/aria-label="下载 CSV"/g) ?? []).length).toBe(3);
    expect(html).toContain('title="复制表格"');
    expect(html).toContain('title="下载 CSV"');
  });

  test("表头-only 表格（空数据行）渲染不崩且仍有操作钮", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: "| 唯一 |\n| --- |" }));
    expect(html).toContain("<table");
    expect(html).toContain('aria-label="下载 CSV"');
  });
});

describe("markdown 表格行操作 wiring（happy-dom 真点击）", () => {
  beforeEach(() => {
    copyText.mockReset();
  });

  test("点击复制钮：copyText 收到全表 TSV（逐格制表符分隔），成功 toast 提示", async () => {
    copyText.mockResolvedValue(true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Markdown, { text: TABLE_MD }));
    });
    const btn = container.querySelector('button[aria-label="复制表格"]');
    expect(btn).not.toBeNull();
    await act(async () => {
      (btn as HTMLButtonElement).click();
    });
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copyText).toHaveBeenCalledWith('名称\t数值\t备注\n甲\t1\t普通\n乙,丙\t2\t含"引号"');
    expect(useUiStore.getState().toast?.text).toBe("已复制表格");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  test("点击下载钮：游离 anchor 承载 table.csv，Blob 带 BOM 且 CSV 转义正确", async () => {
    const anchors: Array<{ href: string; download: string; clicks: number; click(): void }> = [];
    const realCreate = document.createElement.bind(document);
    const createSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation(((tag: string) => {
        if (tag === "a") {
          const anchor = {
            href: "",
            download: "",
            clicks: 0,
            click() {
              this.clicks += 1;
            },
          };
          anchors.push(anchor);
          return anchor;
        }
        return realCreate(tag);
      }) as typeof document.createElement);
    const createObjectURL = vi.fn((_blob: Blob) => "blob:fake-1");
    const revokeObjectURL = vi.fn();
    (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectURL;

    try {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(Markdown, { text: TABLE_MD }));
      });
      const btn = container.querySelector('button[aria-label="下载 CSV"]');
      expect(btn).not.toBeNull();
      await act(async () => {
        (btn as HTMLButtonElement).click();
      });
      expect(anchors).toHaveLength(1);
      expect(anchors[0].download).toBe("table.csv");
      expect(anchors[0].href).toBe("blob:fake-1");
      expect(anchors[0].clicks).toBe(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-1");
      const blob = createObjectURL.mock.calls[0][0];
      const text = await blob.text();
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(text.slice(1)).toBe('名称,数值,备注\n甲,1,普通\n"乙,丙",2,"含""引号"""');
      await act(async () => {
        root.unmount();
      });
      container.remove();
    } finally {
      createSpy.mockRestore();
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    }
  });

  test("downloadTableCsv 直调：同产 Blob 下载（纯函数与 DOM 侧衔接）", () => {
    const anchors: Array<{ href: string; download: string; clicks: number; click(): void }> = [];
    const realCreate = document.createElement.bind(document);
    const createSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation(((tag: string) => {
        if (tag === "a") {
          const anchor = { href: "", download: "", clicks: 0, click() { this.clicks += 1; } };
          anchors.push(anchor);
          return anchor;
        }
        return realCreate(tag);
      }) as typeof document.createElement);
    const createObjectURL = vi.fn((_blob: Blob) => "blob:fake-2");
    (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
    try {
      downloadTableCsv("名称,数值\n甲,1");
      expect(anchors[0].download).toBe("table.csv");
      expect(anchors[0].href).toBe("blob:fake-2");
      expect(anchors[0].clicks).toBe(1);
    } finally {
      createSpy.mockRestore();
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
