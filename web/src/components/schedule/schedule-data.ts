// schedule 定时任务纯函数与展示辅助（docs08-2026-10-22 批次任务 22）：
// 组件无逻辑，到期相对时间/循环间隔人读格式/摘要截断/状态→词典键映射全部在此，
// 导出供单测（schedule-data.test.ts）。时间字段一律 epoch 毫秒（server ScheduleJob 契约）。
import type { MessageKey } from "@/i18n/i18n";
import type { ScheduleJobItem } from "@/lib/api";

export type ScheduleState = ScheduleJobItem["state"];

/** 状态 → 词典键（schedule.state*） */
export function scheduleStateKey(state: ScheduleState): MessageKey {
  if (state === "firing") return "schedule.stateFiring";
  if (state === "failed") return "schedule.stateFailed";
  return "schedule.statePending";
}

/** 状态徽标配色（对齐 StatusDot 先例：firing=sky 运行、failed=destructive、pending=muted） */
export function scheduleStateClass(state: ScheduleState): string {
  if (state === "firing") return "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400";
  if (state === "failed") return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-border bg-muted text-muted-foreground";
}

/** 紧凑时长（与 session-item formatRelative 同风格，数字+字母不汉化）：s/m/h/d 取整档 */
export function formatDurationParts(ms: number): string {
  const abs = Math.abs(ms);
  const s = Math.floor(abs / 1000);
  if (s < 60) return `${Math.max(s, 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** 到期展示（渲染期包装）：now 缺省取当前时刻——把 Date.now() 收进非组件函数内，
 * 避免 react(purity) 在渲染作用域直呼（session-item formatRelative 同款做法） */
export function formatDueNow(dueAt: number): { text: string; past: boolean } {
  return formatDue(dueAt, Date.now());
}

/** 到期展示：未来 → { text: 紧凑时长, past: false }；已到期 → past: true（引擎下次扫描即
 * 触发，UI 明示「已到期·待触发」绝不倒挂倒计时）；非法值 null 由调用方兜底。 */
export function formatDue(dueAt: number, now: number): { text: string; past: boolean } {
  if (!Number.isFinite(dueAt)) return { text: "", past: true };
  const diff = dueAt - now;
  if (diff <= 0) return { text: "", past: true };
  return { text: formatDurationParts(diff), past: false };
}

/** 循环间隔人读格式：整小时/整分钟归档（每 2h / 每 5m / 每 90s），供 schedule.every 插值 */
export function formatEvery(everyMs: number): string {
  if (!Number.isFinite(everyMs) || everyMs <= 0) return "";
  const s = everyMs / 1000;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/** prompt 摘要：首行 + 压缩空白，超长截断加省略号（列表行主文案，边界单测覆盖） */
export function promptExcerpt(prompt: string, max = 80): string {
  const firstLine = prompt.replace(/\s+/g, " ").trim();
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, max)}…`;
}

/** 本地明天 09:00（延迟档「明天 9 点」；夏令时边界由 Date 语义兜底，仅用于预设初值） */
export function tomorrowAt9(now: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}
