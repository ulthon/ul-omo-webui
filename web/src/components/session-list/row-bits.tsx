// 会话行展示小件（r10 todo 3 抽取）：供会话切换全屏 sheet 行复用的状态点/置顶标/
// 未读徽标。与 session-item.tsx 行内同款视觉语义保持一致（权威链 SSE runStates →
// 行 runState → 引擎探询 active；未读 >99 → "99+"）。纯渲染组件，零请求。
// 不改动 session-item.tsx / session-list.tsx（r10-wave1 并行任务约束），后续如需
// 收敛为单源可由 session-item 反向引用本文件。
import { Pin } from "lucide-react";
import type { SessionListItem } from "@/lib/api";
import { useSessionsStore } from "@/stores/sessions";
import { useT } from "@/i18n/i18n";

/** 状态点：颜色/呼吸语义与 session-item 的 StatusDot 同款（running 天蓝呼吸、
 * waiting 琥珀呼吸、background_running 紫色呼吸、error 红、idle 灰）。 */
export function RowStatusDot({ session }: { session: SessionListItem }) {
  const runState = useSessionsStore((s) => s.runStates[session.id] ?? null);
  const t = useT();
  const effective = runState ?? (session.runState ?? null);
  let cls = "bg-muted-foreground/30";
  let title = t("sessionList.item.statusIdle");
  if (effective === "waiting") {
    cls = "bg-amber-500 animate-busy-pulse";
    title = t("sessionList.item.statusWaiting");
  } else if (effective === "background_running") {
    cls = "bg-violet-500 animate-busy-pulse";
    title = t("sessionList.item.statusBackground");
  } else if (effective === "error") {
    cls = "bg-destructive";
    title = t("sessionList.item.statusError");
  } else if (effective === "running" || (effective === null && session.active === true)) {
    cls = "bg-sky-500 animate-busy-pulse";
    title = t("sessionList.item.statusRunning");
  }
  return <span className={`size-1.5 shrink-0 rounded-full ${cls}`} title={title} />;
}

/** 置顶标识：Pin 图标（与 session-item 行内同款对齐），非置顶不渲染。 */
export function RowPinnedBadge() {
  return <Pin className="mr-0.5 inline size-3 shrink-0 align-[-1px] text-muted-foreground" aria-label="pinned" />;
}

/** 未读徽标：>99 → "99+"（与 session-item 同一溢出规则），0 不渲染。 */
export function RowUnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="row-unread-badge"
      className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-medium leading-none text-primary-foreground"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
