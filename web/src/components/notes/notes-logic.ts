// 笔记页签纯逻辑（todo 15）：标签解析、标签聚合、本地过滤、相对时间。
import { formatRelativeTime } from "@/i18n/i18n";
// 全部无副作用，供 notes-view / note-inline-editor 与单测直接消费。
// 约定：updatedAt/createdAt/deletedAt 服务端可为 null（库层可空），展示一律容错为 "—"。

/**
 * 编辑态标签输入解析：中英文逗号分隔 → 去首尾空白 → 丢弃空段 → 去重（保首次出现序）。
 * 自由输入不做两级选择（计划钉死：笔记标签是内容分类向，轻量）。
 */
export function parseTagInput(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[,，]/)) {
    const tag = part.trim();
    if (tag.length > 0) seen.add(tag);
  }
  return [...seen];
}

/** 编辑态标签回显：数组 → 逗号分隔文本 */
export function tagsToInput(tags: string[]): string {
  return tags.join(", ");
}

/**
 * 列表态标签 chips 数据源：全部笔记 tags 并集，去重 + 稳定排序（代码单元序）。
 * 服务端无"全部标签"端点，chips 由当前项目全量列表派生。
 */
export function collectTags(notes: ReadonlyArray<{ tags: string[] }>): string[] {
  const seen = new Set<string>();
  for (const note of notes) {
    for (const tag of note.tags) seen.add(tag);
  }
  return [...seen].sort();
}

/**
 * 列表过滤：tag 为 null 不过滤（全量）；否则保留 tags 含该标签的行。
 * 服务端 ?tag= 是权威过滤；本函数在响应落地后再按当前激活 chip 过滤一次，
 * 防快速切换 chips 时的响应竞态把旧结果混入新筛选态的展示。
 */
export function filterNotesByTag<T extends { tags: string[] }>(
  notes: ReadonlyArray<T>,
  tag: string | null,
): T[] {
  if (tag === null) return [...notes];
  return notes.filter((n) => n.tags.includes(tag));
}

/**
 * 列表行标题兜底（r11 todo7）：标题非空原样返回；空标题取正文首行（调用方传全文或
 * 已截断的首行摘要均可，函数内先抽非空首行）截断到 maxLen，连正文都空则回退「无标题」。
 * 服务端列表 payload 的 preview 字段（首行摘要）与本函数共用同一语义（前后端一致）。
 */
export function deriveDisplayTitle(
  title: string,
  content: string | undefined,
  untitledLabel: string,
  maxLen = 40,
): string {
  const trimmed = title.trim();
  if (trimmed.length > 0) return trimmed;
  const firstLine = (content ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return untitledLabel;
  return firstLine.length > maxLen ? `${firstLine.slice(0, maxLen)}…` : firstLine;
}

/** 相对时间：30 天内走统一 i18n 实现；超过 30 天保持本页签既有 YYYY-MM-DD 契约；null/非法 → "—" */
export function relTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  if (now - t < 30 * 86_400_000) return formatRelativeTime(iso, now);
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
