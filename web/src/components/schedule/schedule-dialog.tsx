// 会话行菜单「定时任务…」弹框（docs08-2026-10-22 批次任务 22）：该会话任务过滤列表 +
// 新建表单（prompt textarea + 延迟档 1h/明天 9 点/自定义 ISO + 循环间隔秒可选 + 说明）。
// POST 走任务 21 契约（due=epoch ms | ISO；everyMs≥60000）；503 schedule_runner_unavailable
// 即置降级态（创建禁用+提示，列表/取消仍可用）；空 prompt 客户端拦截。
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import type { SessionListItem, ScheduleListResponse } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { tomorrowAt9 } from "./schedule-data";
import { ScheduleRow } from "./schedule-section";

type DuePreset = "1h" | "tomorrow" | "custom";

const DUE_PRESETS: ReadonlyArray<{ value: DuePreset; labelKey: "schedule.preset1h" | "schedule.presetTomorrow" | "schedule.presetCustom" }> = [
  { value: "1h", labelKey: "schedule.preset1h" },
  { value: "tomorrow", labelKey: "schedule.presetTomorrow" },
  { value: "custom", labelKey: "schedule.presetCustom" },
];

export function ScheduleDialog({ session, onClose }: { session: SessionListItem; onClose: () => void }) {
  const t = useT();
  const showToast = useUiStore((s) => s.showToast);

  const [data, setData] = useState<ScheduleListResponse | null>(null);
  const [prompt, setPrompt] = useState("");
  const [preset, setPreset] = useState<DuePreset>("1h");
  const [customDue, setCustomDue] = useState("");
  const [everySeconds, setEverySeconds] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    api
      .listSchedule()
      .then((res) => {
        if (!disposed) setData(res);
      })
      .catch((err) => {
        if (disposed || (err instanceof ApiError && err.status === 401)) return;
        // 弹框列表拉取失败不拦新建（POST 有自己的错误通道），仅置空列表
        setData({ jobs: [], invalid: [], runner: { alive: true } });
      });
    return () => {
      disposed = true;
    };
  }, []);

  const refresh = () => {
    api
      .listSchedule()
      .then((res) => setData(res))
      .catch(() => {});
  };

  const jobs = (data?.jobs ?? []).filter((j) => j.sessionId === session.id);

  const cancel = async (id: string) => {
    if (cancellingId) return;
    setCancellingId(id);
    try {
      await api.cancelSchedule(id);
      setData((prev) => (prev ? { ...prev, jobs: prev.jobs.filter((j) => j.id !== id) } : prev));
      showToast(t("schedule.cancelled"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      if (err instanceof ApiError && err.status === 404) {
        setData((prev) => (prev ? { ...prev, jobs: prev.jobs.filter((j) => j.id !== id) } : prev));
        return;
      }
      showToast(apiErrorMessage(err, "schedule.cancelFailed"), "error");
    } finally {
      setCancellingId(null);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || degraded) return;
    const trimmed = prompt.trim();
    if (trimmed === "") {
      setError(t("schedule.promptRequired"));
      return;
    }
    let due: number | string;
    if (preset === "1h") {
      due = Date.now() + 3_600_000;
    } else if (preset === "tomorrow") {
      due = tomorrowAt9(Date.now());
    } else {
      if (Number.isNaN(Date.parse(customDue))) {
        setError(t("schedule.dueInvalid"));
        return;
      }
      due = customDue;
    }
    let everyMs: number | null = null;
    if (everySeconds.trim() !== "") {
      const s = Number(everySeconds);
      if (!Number.isInteger(s) || s < 60) {
        setError(t("schedule.everyInvalid"));
        return;
      }
      everyMs = s * 1000;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createSchedule({ sessionId: session.id, prompt: trimmed, due, everyMs });
      showToast(t("schedule.created"));
      setPrompt("");
      setEverySeconds("");
      setPreset("1h");
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      if (err instanceof ApiError && err.status === 503) setDegraded(true);
      setError(apiErrorMessage(err, "schedule.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle data-testid="schedule-dialog-title">
            {t("schedule.dialogTitle")}
            <span className="ml-1.5 text-sm font-normal text-muted-foreground" title={session.title}>
              · {session.title}
            </span>
          </DialogTitle>
          <DialogDescription>{t("schedule.dialogDesc", { title: session.title })}</DialogDescription>
        </DialogHeader>

        {/* 该会话已有任务（过滤列表 + 取消；新建成功后 refresh 对账）。min-w-0：列表行含
            truncate span，grid 轨道 intrinsic 贡献按 max-content 计会撑破 sm:max-w-md 弹框
            （实测 1173px 溢出），根上 min-w-0 切断贡献链 */}
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("schedule.listHeading")}</p>
          {jobs.length === 0 ? (
            <p className="rounded-md border border-dashed px-2 py-1.5 text-sm text-muted-foreground">{t("schedule.listEmpty")}</p>
          ) : (
            jobs.map((job) => (
              <ScheduleRow key={job.id} job={job} sessionTitle={session.title} cancelling={cancellingId === job.id} onCancel={(id) => void cancel(id)} />
            ))
          )}
        </div>

        <form onSubmit={submit} data-testid="schedule-form" className="min-w-0 space-y-3 border-t pt-3">
          <p className="text-sm font-medium">{t("schedule.formHeading")}</p>
          <div className="space-y-1.5">
            <label htmlFor="schedule-prompt" className="text-sm font-medium">
              {t("schedule.promptLabel")}
            </label>
            <textarea
              id="schedule-prompt"
              data-testid="schedule-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("schedule.promptPlaceholder")}
              rows={3}
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("schedule.dueLabel")}</p>
            <div role="radiogroup" aria-label={t("schedule.dueLabel")} className="space-y-1" data-testid="schedule-due-group">
              {DUE_PRESETS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex min-h-9 items-center gap-2 rounded-md px-1 text-sm hover:bg-accent/50 lg:min-h-7"
                  data-testid={`schedule-due-preset-${opt.value}`}
                >
                  <input
                    type="radio"
                    name="schedule-due"
                    value={opt.value}
                    checked={preset === opt.value}
                    onChange={() => setPreset(opt.value)}
                    className="size-4 accent-primary"
                  />
                  {t(opt.labelKey)}
                </label>
              ))}
            </div>
            {preset === "custom" && (
              <Input
                value={customDue}
                onChange={(e) => setCustomDue(e.target.value)}
                placeholder={t("schedule.customPlaceholder")}
                inputMode="url"
                data-testid="schedule-due-custom"
                className="mt-1"
              />
            )}
          </div>
          <div className="space-y-1">
            <label htmlFor="schedule-every" className="text-sm font-medium">
              {t("schedule.everyLabel")}
            </label>
            <Input
              id="schedule-every"
              data-testid="schedule-every"
              type="number"
              min={60}
              step={60}
              value={everySeconds}
              onChange={(e) => setEverySeconds(e.target.value)}
              placeholder=""
              inputMode="numeric"
            />
            <p className="text-xs text-muted-foreground">{t("schedule.everyHint")}</p>
          </div>
          <p className="text-xs text-muted-foreground">{t("schedule.help")}</p>
          {degraded && (
            <p className="text-sm text-amber-600 dark:text-amber-400" data-testid="schedule-degraded">
              {t("schedule.degraded")}
            </p>
          )}
          {error && <p className="text-sm text-destructive" data-testid="schedule-form-error">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" data-testid="schedule-submit" disabled={busy || degraded}>
              {busy ? t("schedule.submitting") : t("schedule.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
