// 设置面板「定时任务」分区（docs08-2026-10-22 批次任务 22）：全局列表（prompt 摘要/
// 会话名/到期/循环/状态/取消）+ runner 存活指示 + invalid 记录如实回显。
// 刷新策略（计划口径：轮询，不引入 websocket）：挂载即拉取 + 10s 可见态轮询 +
// visibilitychange 回前台即刷 + 取消后静默对账；轮询失败保持既有展示不打扰（下次轮询重试）。
// 导出供单测（web/tests/schedule-ui.test.tsx）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { ScheduleJobItem, ScheduleListResponse } from "@/lib/api";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { Button } from "@/components/ui/button";
import {
  formatDueNow,
  formatEvery,
  promptExcerpt,
  scheduleStateClass,
  scheduleStateKey,
} from "./schedule-data";

/** 轮询周期（可见态才拉，后台页签零流量） */
const POLL_MS = 10_000;

/** 单行：到期相对时间 + 循环 + 状态徽标 + 取消（触控行 ≥36px；取消为次要动作 min-h-9）。导出供弹框复用 */
export function ScheduleRow({
  job,
  sessionTitle,
  cancelling,
  onCancel,
}: {
  job: ScheduleJobItem;
  sessionTitle: string;
  cancelling: boolean;
  onCancel: (id: string) => void;
}) {
  const t = useT();
  const due = formatDueNow(job.dueAt);
  const dueText = due.past ? t("schedule.dueOverdue") : t("schedule.dueIn", { t: due.text });
  const metaTitle = [
    `${new Date(job.dueAt).toLocaleString()}`,
    job.everyMs !== null ? t("schedule.every", { interval: formatEvery(job.everyMs) }) : t("schedule.oneShot"),
    job.fireCount > 0 ? t("schedule.firedCount", { n: job.fireCount }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div data-testid="schedule-item" className="space-y-0.5 rounded-md border px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm" title={job.prompt}>
          {promptExcerpt(job.prompt)}
        </span>
        <span
          data-testid="schedule-item-state"
          className={`shrink-0 rounded border px-1 py-px text-[11px] leading-none ${scheduleStateClass(job.state)}`}
        >
          {t(scheduleStateKey(job.state))}
        </span>
      </div>
      <div className="flex min-h-9 items-center gap-1.5 text-xs text-muted-foreground lg:min-h-7">
        <span className="min-w-0 shrink truncate" title={job.sessionId}>
          {sessionTitle}
        </span>
        <span aria-hidden>·</span>
        <span className="shrink-0" title={metaTitle}>
          {dueText}
        </span>
        <span aria-hidden>·</span>
        <span className="shrink-0">
          {job.everyMs !== null ? t("schedule.every", { interval: formatEvery(job.everyMs) }) : t("schedule.oneShot")}
        </span>
        <Button
          type="button"
          variant="outline"
          className="ml-auto min-h-9 shrink-0 px-2.5 text-xs lg:min-h-7"
          data-testid={`schedule-cancel-${job.id}`}
          disabled={cancelling}
          onClick={() => onCancel(job.id)}
        >
          {cancelling ? t("schedule.cancelling") : t("schedule.cancel")}
        </Button>
      </div>
      {job.state === "failed" && job.lastError && (
        <p className="truncate text-xs text-destructive" title={job.lastError}>
          {t("schedule.lastError", { error: job.lastError })}
        </p>
      )}
    </div>
  );
}

export function ScheduleSection() {
  const t = useT();
  const showToast = useUiStore((s) => s.showToast);
  const byProject = useSessionsStore((s) => s.byProject);
  const [data, setData] = useState<ScheduleListResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  // 会话名查找（计划列「会话名」）：跨项目扁平化 id → title；未加载/已删除回退短 id（title 全文）
  const sessionsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const list of Object.values(byProject)) {
      for (const s of list) map.set(s.id, s.title);
    }
    return map;
  }, [byProject]);

  // 拉取（.then 形态：setState 全在微任务回调内，避免 set-state-in-effect 同步直呼告警）
  const load = useCallback((opts?: { silent?: boolean }) => {
    api.listSchedule().then(
      (res) => {
        setData(res);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return;
        // 静默轮询失败保持既有展示（下轮重试）；首次加载失败才亮错误行（挂载即唯一非静默
        // 调用，错误态无需复位——重挂载即新状态）
        if (!opts?.silent) setLoadFailed(true);
      },
    );
  }, []);

  useEffect(() => {
    load();
    const visible = () => document.visibilityState === "visible";
    const iv = setInterval(() => {
      if (visible()) load({ silent: true });
    }, POLL_MS);
    const onVisibility = () => {
      if (visible()) load({ silent: true });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const cancel = async (id: string) => {
    if (cancellingId) return;
    setCancellingId(id);
    try {
      await api.cancelSchedule(id);
      // 取消即移除（本地先行），再静默对账一次 GET
      setData((prev) => (prev ? { ...prev, jobs: prev.jobs.filter((j) => j.id !== id) } : prev));
      showToast(t("schedule.cancelled"));
      load({ silent: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      if (err instanceof ApiError && err.status === 404) {
        // 已在触发中/已取消：语义上等价已移除，行内摘除即可
        setData((prev) => (prev ? { ...prev, jobs: prev.jobs.filter((j) => j.id !== id) } : prev));
        return;
      }
      showToast(apiErrorMessage(err, "schedule.cancelFailed"), "error");
    } finally {
      setCancellingId(null);
    }
  };

  const alive = data?.runner.alive ?? true;
  const jobs = data?.jobs ?? [];

  return (
    <div className="min-w-0 border-t pt-1" data-testid="schedule-section">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("schedule.heading")}</p>
        <p
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          data-testid="schedule-runner-status"
          title={alive ? t("schedule.runnerUp") : t("schedule.runnerDownNote")}
        >
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${alive ? "bg-emerald-500" : "bg-destructive"}`} />
          {alive ? t("schedule.runnerUp") : t("schedule.runnerDown")}
        </p>
        {data && data.invalid.length > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400" title={data.invalid.map((r) => `${r.file}: ${r.error}`).join("\n")}>
            {t("schedule.invalidBadge", { n: data.invalid.length })}
          </p>
        )}
        {loadFailed && <p className="text-xs text-destructive">{t("schedule.loadFailed")}</p>}
        {data === null && !loadFailed && <p className="text-xs text-muted-foreground">…</p>}
        {data !== null && jobs.length === 0 && (
          <div className="space-y-0.5 rounded-md border border-dashed px-2 py-1.5">
            <p className="text-sm text-muted-foreground">{t("schedule.empty")}</p>
            <p className="text-xs text-muted-foreground/70">{t("schedule.emptyHint")}</p>
          </div>
        )}
        {jobs.map((job) => (
          <ScheduleRow
            key={job.id}
            job={job}
            sessionTitle={sessionsById.get(job.sessionId) ?? job.sessionId}
            cancelling={cancellingId === job.id}
            onCancel={(id) => void cancel(id)}
          />
        ))}
        <p className="text-xs text-muted-foreground">{t("schedule.note")}</p>
      </div>
    </div>
  );
}
