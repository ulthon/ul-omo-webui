// 常用语纯逻辑（todo 14）：插入光标计算、4KB 字节判定（与服务端 SNIPPET_MAX_BYTES
// 对齐）、输入历史导入筛选、列表移动排序。可测逻辑全部收敛在此（组件层只做渲染
// 与请求编排，同 composer-logic / file-tree-logic 分工）。
import type { InputHistoryItem, SnippetEntry } from "@/lib/api";

/** 单条 content 上限（UTF-8 字节数；与服务端 routes-snippets.ts SNIPPET_MAX_BYTES 一致） */
export const SNIPPET_MAX_BYTES = 4 * 1024;

/** UTF-8 字节数（TextEncoder 不产生 BOM，与 Buffer.byteLength(string,"utf8") 一致） */
export function utf8ByteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

/** 超 4KB 上限判定：导入子面板禁选依据（服务端对超限条目整批 400，前端禁选避免一条超限拖垮整批） */
export function isSnippetOverLimit(content: string): boolean {
  return utf8ByteLength(content) > SNIPPET_MAX_BYTES;
}

/**
 * 常用语插入（insertMention 同协议）：在 caret 处插入内容，返回新文本与光标位置
 * （落插入内容之后）。caret 越界钳制到 [0, text.length]。
 */
export function insertSnippet(text: string, caret: number, snippet: string): { content: string; caret: number } {
  const at = Math.min(Math.max(caret, 0), text.length);
  return { content: text.slice(0, at) + snippet + text.slice(at), caret: at + snippet.length };
}

/** 条目列表单行预览（折叠空白截断，同 historyPreview 口径） */
export function snippetPreview(content: string, max = 60): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * 输入历史导入筛选：按 4KB 上限分两组（各自保持原顺序，列表新在前由服务端排序决定）。
 * 超限组在 UI 禁选并标注，仅可导入 importable 组。
 */
export function partitionImportable(items: InputHistoryItem[]): {
  importable: InputHistoryItem[];
  oversized: InputHistoryItem[];
} {
  const importable: InputHistoryItem[] = [];
  const oversized: InputHistoryItem[] = [];
  for (const item of items) {
    (isSnippetOverLimit(item.content) ? oversized : importable).push(item);
  }
  return { importable, oversized };
}

/** 列表内移动条目（上移 -1 / 下移 +1），越界返回等价副本（无变化） */
export function moveSnippet<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const to = index + dir;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item);
  return next;
}

/** 条目列表 sort 重编为索引序（整替写入前统一归位；服务端整替后按 sort 升序回显） */
export function renumberSnippets(entries: SnippetEntry[]): SnippetEntry[] {
  return entries.map((entry, i) => ({ content: entry.content, sort: i }));
}

/** 条目插入/直发按钮的统一禁用判定（sending=组件发送中；busy 态 composer 整体替换，面板不可达） */
export function snippetActionDisabled(busy: boolean, sending: boolean): boolean {
  return busy || sending;
}
