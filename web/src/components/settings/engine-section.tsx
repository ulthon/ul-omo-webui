// 引擎分区（2026-11-04 用户定版）：设置页「引擎」两块——空闲回收档位 + 进程管理。
// - 空闲回收：meta_kv engine.idleTimeoutMinutes（"30"|"60"|"240"|"1440"|"10080"|"never"），
//   走既有 PUT /api/settings；服务端 onSettingsChanged 钩子即时重排已拉起引擎的
//   回收定时器，免重启生效。缺省 7 天（process-manager DEFAULTS，对齐 openchamber
//   常驻理念；30 分钟旧值曾误杀安静后台长任务，诊断 2026-11-04 实锤）。
// - 探活窗档位（2026-11-07 session-polish T2）：meta_kv engine.activityWindowMinutes
//   （"1"|"5"|"15"|"30"|"60"|"never"，缺省 5 分钟，"0" 读作 never）。纯看（未发过
//   消息）引擎按此档判收，正在跑回合不受影响；never 关窗回落上方空闲回收档。
//   写路径与空闲回收同走既有 PUT /api/settings（零新端点），服务端 onSettingsChanged
//   钩子即时重排挂起定时器。
// - 进程管理（2026-11-05 multi-session-parallel T6）：GET /api/engines 每会话引擎一行
//   （项目·会话/状态/pid/运行回合/最后活动；无引擎已知项目灰显 inactive 行）+
//   POST /api/engines/stop 手动停（行内 {sessionPath} 定向停单会话；头部「全部停止」
//   按项目去重逐个 {project} 项目级停）。停止会连根终止该会话运行中回合与后台任务，
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

// 探活窗档位：值口径镜像 server applyActivityWindowFromKv（"never"/0 关窗；分钟数直接入 kv）
export const ENGINE_ACTIVITY_WINDOW_KV = "engine.activityWindowMinutes";
export type EngineActivityValue = "1" | "5" | "15" | "30" | "60" | "never";
const DEFAULT_ACTIVITY: EngineActivityValue = "5";

const ACTIVITY_OPTIONS: ReadonlyArray<{ value: EngineActivityValue; labelKey: MessageKey }> = [
  { value: "1", labelKey: "login.settingsPage.engineActivity1m" },
  { value: "5", labelKey: "login.settingsPage.engineActivity5m" },
  { value: "15", labelKey: "login.settingsPage.engineActivity15m" },
  { value: "30", labelKey: "login.settingsPage.engineActivity30m" },
  { value: "60", labelKey: "login.settingsPage.engineActivity60m" },
  { value: "never", labelKey: "login.settingsPage.engineActivityNever" },
];

/** kv 原值 → 档位（"0"=never 同义；非档位值/缺席回落缺省 5 分钟） */
function parseActivityValue(raw: string | undefined): EngineActivityValue {
  if (raw === "0") return "never";
  return ACTIVITY_OPTIONS.some((o) => o.value === raw) ? (raw as EngineActivityValue) : DEFAULT_ACTIVITY;
}

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

const rowKey = (row: EngineAdminRow) => row.sessionPath ?? row.projectPath;
const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const sessionBase = (sessionPath: string) => baseName(sessionPath).replace(/\.[^.]+$/, "");
const stoppable = (row: EngineAdminRow) =>
  row.sessionPath !== null && (row.state === "ready" || row.state === "starting");

/** 空闲回收 + 进程管理（导出供单测与设置页装配） */
export function EngineSection() {
  const t = useT();
  const showToast = useUiStore((s) => s.showToast);

  // ---- 空闲回收档位 ----
  const [idle, setIdle] = useState<EngineIdleValue | null>(null);
  const [savingIdle, setSavingIdle] = useState(false);
  // ---- 探活窗档位（与空闲回收同一次 getSettings 读两个键） ----
  const [activity, setActivity] = useState<EngineActivityValue | null>(null);
  const [savingActivity, setSavingActivity] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .getSettings()
      .then((r) => {
        if (!alive) return;
        const raw = r.settings[ENGINE_IDLE_TIMEOUT_KV];
        setIdle(IDLE_OPTIONS.some((o) => o.value === raw) ? (raw as EngineIdleValue) : DEFAULT_IDLE);
        setActivity(parseActivityValue(r.settings[ENGINE_ACTIVITY_WINDOW_KV]));
      })
      .catch(() => {
        if (!alive) return;
        setIdle(DEFAULT_IDLE);
        setActivity(DEFAULT_ACTIVITY);
      });
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

  const changeActivity = async (mode: EngineActivityValue) => {
    if (mode === activity || savingActivity) return;
    setSavingActivity(true);
    try {
      await api.putSettings({ [ENGINE_ACTIVITY_WINDOW_KV]: mode });
      setActivity(mode);
    } catch (err) {
      showToast(apiErrorMessage(err, "login.settingsPage.engineActivitySaveFailed"), "error");
    } finally {
      setSavingActivity(false);
    }
  };

  // ---- 进程管理 ----
  const [rows, setRows] = useState<EngineAdminRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [stoppingAll, setStoppingAll] = useState(false);
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
    if (row.sessionPath === null) return;
    if (row.runningSessions > 0) {
      const ok = window.confirm(
        t("login.settingsPage.engineStopConfirmSession", { name: sessionBase(row.sessionPath) }),
      );
      if (!ok) return;
    }
    const key = rowKey(row);
    setStopping(key);
    try {
      await api.stopEngine({ sessionPath: row.sessionPath });
      await refresh();
    } catch (err) {
      showToast(apiErrorMessage(err, "login.settingsPage.engineStopFailed"), "error");
    } finally {
      setStopping(null);
    }
  };

  // 项目级停止入口（T6 保留）：可停行按项目去重，逐个 {project} 项目级停。
  const stopAll = async () => {
    const targets = rows?.filter(stoppable) ?? [];
    if (targets.length === 0 || stoppingAll || stopping !== null) return;
    if (targets.some((r) => r.runningSessions > 0)) {
      if (!window.confirm(t("login.settingsPage.engineStopConfirmAll"))) return;
    }
    setStoppingAll(true);
    let failed = false;
    try {
      for (const project of [...new Set(targets.map((r) => r.projectPath))]) {
        try {
          await api.stopEngine({ project });
        } catch {
          failed = true;
        }
      }
      await refresh();
    } finally {
      setStoppingAll(false);
    }
    if (failed) showToast(apiErrorMessage(new Error("stop-all partial failure"), "login.settingsPage.engineStopFailed"), "error");
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
      {/* 探活窗档位（session-polish T2）：小号 select，档位口径见上方选项表 */}
      <div className="mt-4 space-y-1.5">
        <label htmlFor="settings-engine-activity-window" className="text-sm font-medium">
          {t("login.settingsPage.engineActivityHeading")}
        </label>
        <select
          id="settings-engine-activity-window"
          data-testid="engine-activity-window-select"
          value={activity ?? ""}
          disabled={savingActivity || activity === null}
          onChange={(e) => void changeActivity(e.target.value as EngineActivityValue)}
          className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {ACTIVITY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{t("login.settingsPage.engineActivityNote")}</p>
      </div>
      {/* 进程管理 */}
      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t("login.settingsPage.engineProcHeading")}</p>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rows === null || stoppingAll || stopping !== null || !rows.some(stoppable)}
              onClick={() => void stopAll()}
              data-testid="engine-proc-stop-all"
            >
              {stoppingAll ? "…" : t("login.settingsPage.engineProcStopAll")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} data-testid="engine-proc-refresh">
              {t("login.settingsPage.engineProcRefresh")}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("login.settingsPage.engineProcNote")}</p>
        {listError && <p className="text-xs text-red-500">{listError}</p>}
        {rows === null && !listError && <p className="text-xs text-muted-foreground">…</p>}
        {rows !== null && rows.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("login.settingsPage.engineProcEmpty")}</p>
        )}
        <div className="space-y-1" data-testid="engine-proc-list">
          {rows?.map((row) => {
            const projectName = baseName(row.projectPath);
            const key = rowKey(row);
            const base = row.sessionPath === null ? projectName : sessionBase(row.sessionPath);
            return (
              <div
                key={key}
                className={`flex min-h-9 items-center gap-2 rounded-md px-1 text-sm${row.sessionPath === null ? " opacity-50" : ""}`}
                data-testid={`engine-proc-row-${base}`}
              >
                <span className="min-w-0 flex-1 truncate" title={key}>
                  {row.sessionPath === null ? projectName : `${projectName} · ${base}`}
                </span>
                <span className="text-xs text-muted-foreground">{stateLabel(row.state, t)}</span>
                {row.sessionPath !== null && (
                  <span className="text-xs text-muted-foreground">
                    {row.runningSessions > 0
                      ? t("login.settingsPage.engineProcRunningSessions", { n: String(row.runningSessions) })
                      : t("login.settingsPage.engineProcIdle")}
                  </span>
                )}
                {row.pid !== undefined && <span className="hidden text-xs text-muted-foreground sm:inline">pid {row.pid}</span>}
                {row.sessionPath !== null && row.lastActivityAt !== null && (
                  <span className="hidden text-xs text-muted-foreground md:inline">
                    {t("login.settingsPage.engineProcLastActivity", { time: relTime(new Date(row.lastActivityAt).toISOString()) })}
                  </span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!stoppable(row) || stoppingAll || stopping !== null}
                  onClick={() => void stopEngine(row)}
                  data-testid={`engine-proc-stop-${base}`}
                >
                  {stopping === key ? "…" : t("login.settingsPage.engineProcStop")}
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
