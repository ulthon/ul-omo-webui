// 右栏总览「计划」区块（r10 todo 12）：绑定当前会话的 goal 计划 todo 勾选态速览。
// 数据源 GET /api/sessions/:id/plan-progress（只读；会话→work 绑定规则与计划 todo
// 行语法见 server/src/api/routes-plans.ts 头注释——boulder session_ids 去 agent 前缀
// 后与 durable 会话 id 精确相等，boulder 只按会话所属项目 cwd 读取，多会话/多项目不串台）。
// 更新策略（无轮询定时器）：
// - 会话切换/挂载：立即拉取一次；
// - 本会话消息活动（SSE → messages store entries 引用变化）：1.5s 尾沿去抖重拉——
//   计划文件由引擎在回合中改写，工具帧到达即 entries 变化，尾沿去抖合并流式帧间隙的
//   重复触发，每轮活动收敛为一次请求（非轮询，仅在事件后触发）；
// - visibilitychange 回前台：拉取一次（补会话外进程改写的计划进度）。
// 隐藏规则：无会话 / 拉取失败 / bound=false（无绑定 goal）/ total=0（计划无 todo 行
// 或文件缺失）→ 整块不渲染（null，不留空面板）。
import { useEffect, useRef, useState } from "react";
import { api, type PlanProgressSnapshot } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { useT } from "@/i18n/i18n";

const OVERVIEW_SECTION_CLASS = "border-b px-3 py-2.5 last:border-b-0";
const OVERVIEW_TITLE_CLASS = "mb-1.5 text-xs font-medium text-muted-foreground";
// 与 overview-panel 其余块同款限高内部滚动
const OVERVIEW_BODY_CLASS = "max-h-64 overflow-y-auto";

/** 消息活动触发重拉的去抖间隔（尾沿）：合流式帧间隙的连续 entries 变化 */
const ACTIVITY_REFETCH_DEBOUNCE_MS = 1500;

export function OverviewPlan({ sessionId }: { sessionId: string | null }) {
  const t = useT();
  const [snap, setSnap] = useState<PlanProgressSnapshot | null>(null);
  const entries = useMessagesStore((s) => (sessionId ? s.bySession[sessionId]?.entries : undefined));
  // 挂载首跑不算「消息活动」：entries 引用未变（含 undefined）时不调度去抖重拉
  const prevEntries = useRef(entries);

  // 会话切换/挂载：立即拉取；回前台补拉。stale 标记防竞态（旧会话响应不落新会话状态）
  useEffect(() => {
    if (!sessionId) {
      setSnap(null);
      return;
    }
    let stale = false;
    const load = (): void => {
      api
        .getPlanProgress(sessionId)
        .then((r) => {
          if (!stale) setSnap(r);
        })
        .catch(() => {
          if (!stale) setSnap(null);
        });
    };
    load();
    const onVisible = (): void => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stale = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId]);

  // 本会话消息活动 → 尾沿去抖重拉（事件驱动，无周期定时器；清理时取消未到期调度）
  useEffect(() => {
    if (!sessionId || entries === prevEntries.current) return;
    prevEntries.current = entries;
    const timer = setTimeout(() => {
      api
        .getPlanProgress(sessionId)
        .then((r) => setSnap(r))
        .catch(() => {});
    }, ACTIVITY_REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sessionId, entries]);

  // 隐藏规则：无数据 / 未绑定 / 无 todo 行 → 整块不渲染
  if (!sessionId || !snap?.bound || (snap.total ?? 0) === 0) return null;

  return (
    <section data-testid="overview-plan" className={OVERVIEW_SECTION_CLASS}>
      <h3 className={OVERVIEW_TITLE_CLASS}>{t("login.rightRail.overview.planTitle")}</h3>
      <div className={OVERVIEW_BODY_CLASS}>
        <p className="flex items-baseline justify-between gap-2 text-sm">
          <span className="min-w-0 truncate text-foreground" title={snap.planName}>
            {snap.planName}
          </span>
          <span data-testid="overview-plan-count" className="shrink-0 tabular-nums text-xs text-muted-foreground">
            {t("login.rightRail.overview.planCount", { done: snap.done, total: snap.total })}
          </span>
        </p>
        {snap.currentTitle ? (
          <p className="mt-1 flex items-baseline gap-2 text-sm leading-relaxed">
            <span className="shrink-0 text-xs font-medium text-primary">{t("login.rightRail.overview.planCurrent")}</span>
            <span
              data-testid="overview-plan-current"
              className="min-w-0 truncate font-medium text-primary"
              title={snap.currentTitle}
            >
              {snap.currentTitle}
            </span>
          </p>
        ) : (
          <p data-testid="overview-plan-all-done" className="mt-1 text-xs text-muted-foreground">
            {t("login.rightRail.overview.planAllDone")}
          </p>
        )}
      </div>
    </section>
  );
}
