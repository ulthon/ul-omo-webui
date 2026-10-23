// 「发现模型」分区纯逻辑（docs08-2026-10-22 批次任务 23）：选择集操作与结果摘要。
// 导出供单测（web/tests/models-discover.test.tsx）。
import type { DiscoverProvider, DiscoverReport } from "@/lib/api";

/** 勾选/取消一个可导入 id（选择集以 Set 语义存数组，保序稳定渲染） */
export function toggleSelected(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/** 当前选择是否等于全部可导入（全选态判定，供「全选导入」文案与校验） */
export function isAllSelected(added: string[], selected: string[]): boolean {
  return added.length > 0 && added.every((id) => selected.includes(id));
}

/** provider 选项展示副标（baseUrl + 既有模型数；缺 baseUrl 显式标注不可发现） */
export function providerOptionLabel(p: DiscoverProvider): string {
  const base = p.baseUrl === "" ? "-" : p.baseUrl;
  return `${base} · ${p.modelCount}`;
}

/** 导入结果摘要：imported 数（null=预览未导入），配合 i18n 键选择 */
export function summarizeImport(report: DiscoverReport): { kind: "done" | "nothing"; count: number } {
  if (report.imported === null || report.imported.length === 0) return { kind: "nothing", count: 0 };
  return { kind: "done", count: report.imported.length };
}
