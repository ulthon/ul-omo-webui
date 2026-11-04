// 引擎分区（2026-11-04 用户定版）：设置页「引擎」两块——空闲回收档位 + 进程管理。
// - 空闲回收：meta_kv engine.idleTimeoutMinutes（"30"|"60"|"240"|"1440"|"10080"|"never"），
//   走既有 PUT /api/settings；服务端 onSettingsChanged 钩子即时重排已拉起引擎的
//   回收定时器，免重启生效。缺省 7 天（process-manager DEFAULTS，对齐 openchamber
//   常驻理念；30 分钟旧值曾误杀安静后台长任务，诊断 2026-11-04 实锤）。
// - 进程管理：GET /api/engines 全量快照（项目/状态/pid/运行回合/最后活动）+
//   POST /api/engines/stop 手动停。停止会连根终止该项目运行中回合与后台任务，
//   运行回合>0 时原生 confirm 二次确认（notes-view 同款先例）。
import { useCallback, useEffect, useState } from "react";
import { api, type EngineAdminRow } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { apiErrorMessage } from "@/i18n/errors";
import { useT, type MessageKey } from "@/i18n/i18n";
import { relTime } from "@/components/notes/notes-logic";
import { Button } from "@/components/ui/button";

export const ENGINE_IDLE_TIMEOUT_KV = "engine.idleTimeoutMinutes";
export type EngineIdleValue = "30" | "60" | "240" | "1440" | "10080" | "never";
const DEFAULT_IDLE: EngineIdleValue = "10080";

const IDLE_OPTIONS: ReadonlyArray<{ value: EngineIdleValue; labelKey: MessageKey }> = [
  { value: "30", labelKey: "login.settingsPage.engineIdle30m" },
  { value: "60", labelKey: "login.settingsPage.engineIdle1h" },
  { value: "240", labelKey: "login.settingsPage.engineIdle4h" },
  { value: "1440", labelKey: "login.settingsPage.engineIdle1d" },
  { value: "10080", labelKey: "login.settingsPage.engineIdle7d" },
  { value: "never", labelKey: "login.settingsPage.engineIdleNever" },
];

const STATE_KEY: Record<string, MessageKey> = {
  ready: "login.settingsPage.engineStateReady",
  starting: "login.settingsPage.engineStateStarting",
  stopping: "login.settingsPage.engineStateStopping",
  stopped: "login.settingsPage.engineStateStopped",
  inactive: "login.settingsPage.engineStateInactive",
};

function stateLabel(state: string, t: (k: MessageKey) => string): string {
  return t(STATE_KEY[state] ?? "login.settingsPage.engineStateInactive");
}

/** 空闲回收 + 进程管理（导出供单测与设置页装配） */
export function EngineSection() {
  const t = useT();
  const showToast = useUiStore((s) => s.showToast);

  // ---- 空闲回收档位 ----
  const [idle, setIdle] = useState<EngineIdleValue | null>(null);
  const [savingIdle, setSavingIdle] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .getSettings()
      .then((r) => {
        if (!alive) return;
        const raw = r.settings[ENGINE_IDLE_TIMEOUT_KV];
        setIdle(IDLE_OPTIONS.some((o) => o.value === raw) ? (raw as EngineIdleValue) : DEFAULT_IDLE);
      })
      .catch(() => alive && setIdle(DEFAULT_IDLE));
    return () => {
      alive = false;
    };
  }, []);

  const changeIdle = async (mode: EngineIdleValue) => {
    if (mode === idle || savingIdle) return;
    setSavingIdle(true);
    try {
      await api.putSettings({ [ENGINE_IDLE_TIMEOUT_KV]: mode });
      setIdle(mode);
    } catch (err) {
      showToast(apiErrorMessage(err, "login.settingsPage.engineIdleSaveFailed"), "error");
    } finally {
      setSavingIdle(false);
    }
  };

  // ---- 进程管理 ----
  const [rows, setRows] = useState<EngineAdminRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const r = await api.listEngines();
      setRows(r.engines);
      setListError(null);
    } catch (err) {
      setListError(apiErrorMessage(err, "login.settingsPage.engineListFailed"));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stopEngine = async (row: EngineAdminRow) => {
    const name = row.projectPath.split("/").filter(Boolean).pop() ?? row.projectPath;
    if (row.runningSessions > 0) {
      const ok = window.confirm(t("login.settingsPage.engineStopConfirm", { name: String(name) }));
      if (!ok) return;
    }
    setStopping(row.projectPath);
    try {
      await api.stopEngine(row.projectPath);
      await refresh();
    } catch (err) {
      showToast(apiErrorMessage(err, "login.settingsPage.engineStopFailed"), "error");
    } finally {
      setStopping(null);
    }
  };

  return (
    <div className="border-t pt-1">
      {/* 空闲回收档位 */}
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("login.settingsPage.engineIdleHeading")}</p>
        <p className="text-xs text-muted-foreground">{t("login.settingsPage.engineIdleNote")}</p>
        <div role="radiogroup" aria-label={t("login.settingsPage.engineIdleHeading")} data-testid="engine-idle-group" className="flex flex-wrap gap-1">
          {IDLE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex min-h-7 items-center gap-1.5 rounded-md px-1.5 text-sm hover:bg-accent/50"
              data-testid={`engine-idle-option-${opt.value}`}
            >
              <input
                type="radio"
                name="engine-idle-timeout"
                value={opt.value}
                checked={idle === opt.value}
                disabled={savingIdle || idle === null}
                onChange={() => void changeIdle(opt.value)}
                className="size-4 accent-primary"
              />
              {t(opt.labelKey)}
            </label>
          ))}
        </div>
      </div>
      {/* 进程管理 */}
      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t("login.settingsPage.engineProcHeading")}</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} data-testid="engine-proc-refresh">
            {t("login.settingsPage.engineProcRefresh")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("login.settingsPage.engineProcNote")}</p>
        {listError && <p className="text-xs text-red-500">{listError}</p>}
        {rows === null && !listError && <p className="text-xs text-muted-foreground">…</p>}
        {rows !== null && rows.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("login.settingsPage.engineProcEmpty")}</p>
        )}
        <div className="space-y-1" data-testid="engine-proc-list">
          {rows?.map((row) => {
            const name = row.projectPath.split("/").filter(Boolean).pop() ?? row.projectPath;
            const stoppable = row.state === "ready" || row.state === "starting";
            return (
              <div key={row.projectPath} className="flex min-h-9 items-center gap-2 rounded-md px-1 text-sm" data-testid={`engine-proc-row-${name}`}>
                <span className="min-w-0 flex-1 truncate" title={row.projectPath}>{name}</span>
                <span className="text-xs text-muted-foreground">{stateLabel(row.state, t)}</span>
                {row.state !== "inactive" && (
                  <span className="text-xs text-muted-foreground">
                    {row.runningSessions > 0
                      ? t("login.settingsPage.engineProcRunningSessions", { n: String(row.runningSessions) })
                      : t("login.settingsPage.engineProcIdle")}
                  </span>
                )}
                {row.pid !== undefined && <span className="hidden text-xs text-muted-foreground sm:inline">pid {row.pid}</span>}
                {row.state !== "inactive" && row.lastActivityAt !== null && (
                  <span className="hidden text-xs text-muted-foreground md:inline">
                    {t("login.settingsPage.engineProcLastActivity", { time: relTime(new Date(row.lastActivityAt).toISOString()) })}
                  </span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!stoppable || stopping !== null}
                  onClick={() => void stopEngine(row)}
                  data-testid={`engine-proc-stop-${name}`}
                >
                  {stopping === row.projectPath ? "…" : t("login.settingsPage.engineProcStop")}
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
