// markdown 表格行操作助手（todo 8）：TSV 行序列化、RFC4180 CSV 序列化、
// Blob 下载与 DOM 侧表格数据读取（点击时经 closest 取当前行/表，无需组件覆写 table）。

/** 表格原始数据：表头与数据行（每格为归一后的纯文本） */
export interface TableData {
  header: string[];
  rows: string[][];
}

/** RFC4180 字段转义：含引号/逗号/换行即整体加引号，内部引号翻倍 */
export function csvEscapeField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 全表 CSV 序列化（表头 + 数据行，\n 行分隔；行列与源表格一致） */
export function tableToCsv(data: TableData): string {
  return [data.header, ...data.rows]
    .map((row) => row.map(csvEscapeField).join(","))
    .join("\n");
}

/** 全表 TSV 序列化（制表符分隔，粘贴即列对齐；单元格文本已经 DOM 读数归一，制表符不会入格） */
export function tableToTsv(data: TableData): string {
  return [data.header, ...data.rows]
    .map((row) => row.join("\t"))
    .join("\n");
}

/** Blob 下载 CSV（UTF-8 BOM 保 Excel 直开中文不乱码；游离 anchor click 现代浏览器均支持） */
export function downloadTableCsv(csv: string): void {
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "table.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 行操作单元格标记类：DOM 读数时据此排除操作钮自身所在格 */
export const ROW_ACTIONS_CELL_CLASS = "table-row-actions-cell";

/** 从 <tr> 读取单元格文本（跳过行操作单元格；行内标记经 textContent 只取文字） */
export function rowCellsFromDom(row: HTMLTableRowElement): string[] {
  return Array.from(row.children)
    .filter(
      (cell): cell is HTMLTableCellElement =>
        (cell.tagName === "TD" || cell.tagName === "TH") && !cell.classList.contains(ROW_ACTIONS_CELL_CLASS),
    )
    .map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim());
}

/** 从 <table> 读取全表数据：首个 th 行为表头，其余为数据行 */
export function tableDataFromDom(table: HTMLTableElement): TableData {
  let header: string[] = [];
  const rows: string[][] = [];
  for (const row of Array.from(table.querySelectorAll("tr"))) {
    const cells = rowCellsFromDom(row);
    const isHeader = row.querySelector(`th:not(.${ROW_ACTIONS_CELL_CLASS})`) !== null;
    if (isHeader && header.length === 0 && rows.length === 0) header = cells;
    else rows.push(cells);
  }
  return { header, rows };
}
