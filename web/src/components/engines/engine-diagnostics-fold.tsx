// 引擎监控折叠诊断区（engine-ux-visibility 任务 6）：总览引擎区块的折叠细节层。
// 自包含组件——数据由自身拉取（展开/手动刷新驱动，一次请求双接口并发，无轮询循环），
// 宿主（任务 3 的总览引擎区块或总览页）一行 <EngineDiagnosticsFold /> 即可挂载。
// 折叠（默认）→ 零请求零渲染；展开 → 每引擎一行：CPU 瞬时+累计 / IO 读写字节 /
// 最近错误（计数+尾行）/ RPC 队列深度，外加全局「最近回收」历史（时间+原因，
// GET /api/engines/reclaims，服务端内存环，重启即清空）。
// 字段口径与渲染对齐任务 1 指标接口：进程不可得字段为 null 时显示「—」。
import { useCallback, useEffect, useState } from "react";
import { api, type EngineMetricsRow, type EngineReclaimRecord } from "@/lib/api";
import { apiErrorMessage } from "@/i18n/errors";
import { useT, type MessageKey } from "@/i18n/i18n";
import { relTime } from "@/components/notes/notes-logic";
import { formatBytes } from "@/components/file-tree/file-tree-logic";
import { Button } from "@/components/ui/button";

const sessionBase = (path: string) =>
  path.split("/").filter(Boolean).pop()?.replace(/\.[^.]+$/, "") ?? path;

/** CPU 累计毫秒展示档：秒级一位小数，毫秒级原值 */
function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

const STATE_KEY: Record<string, MessageKey> = {
  ready: "login.settingsPage.engineStateReady",
  starting: "login.settingsPage.engineStateStarting",
  stopping: "login.settingsPage.engineStateStopping",
  stopped: "login.settingsPage.engineStateStopped",
  inactive: "login.settingsPage.engineStateInactive",
};

const RECLAIM_REASON_KEY: Record<string, MessageKey> = {
  idle_timeout: "diagnostics.engineFold.reclaimIdleTimeout",
  activity_window: "diagnostics.engineFold.reclaimActivityWindow",
};

// —— 单引擎诊断行：折叠区四类字段（CPU/IO/错误/队列） ——
function EngineDiagRow({ row }: { row: EngineMetricsRow }) {
  const t = useT();
  const errCount = row.recentErrors.length;
  return (
    <div data-testid="engine-diagnostics-engine" className="space-y-1">
      <p className="truncate text-xs font-medium text-muted-foreground/80" title={row.sessionPath}>
        {t("diagnostics.engineFold.engine")} · {sessionBase(row.sessionPath)} ·{" "}
        {t(STATE_KEY[row.state] ?? "login.settingsPage.engineStateInactive")}
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span data-testid="engine-diag-cpu">
          {t("diagnostics.engineFold.cpuLabel")}{" "}
          <span className="tabular-nums text-foreground">
            {row.cpuPct === null ? "—" : `${row.cpuPct.toFixed(1)}%`}
          </span>
          {row.cpuTotalMs !== null && (
            <>
              {" "}
              · {t("diagnostics.engineFold.cpuTotal")}{" "}
              <span className="tabular-nums text-foreground">{formatMs(row.cpuTotalMs)}</span>
            </>
          )}
        </span>
        <span data-testid="engine-diag-io">
          {t("diagnostics.engineFold.ioRead")}{" "}
          <span className="tabular-nums text-foreground">
            {row.ioBytes === null ? "—" : formatBytes(row.ioBytes.readBytes)}
          </span>{" "}
          / {t("diagnostics.engineFold.ioWrite")}{" "}
          <span className="tabular-nums text-foreground">
            {row.ioBytes === null ? "—" : formatBytes(row.ioBytes.writeBytes)}
          </span>
        </span>
        <span data-testid="engine-diag-rpc">
          {t("diagnostics.engineFold.rpcQueue")}{" "}
          <span className="tabular-nums text-foreground">{row.rpcQueueDepth}</span>
        </span>
        <span data-testid="engine-diag-errors">
          {t("diagnostics.engineFold.errors")}{" "}
          <span className="tabular-nums text-foreground">
            {t("diagnostics.engineFold.errorsCount", { n: String(errCount) })}
          </span>
          {errCount === 0 && ` · ${t("diagnostics.engineFold.noErrors")}`}
        </span>
      </div>
      {errCount > 0 && (
        <ul className="space-y-0.5">
          {row.recentErrors.slice(-3).map((e, i) => (
            <li
              key={i}
              data-testid="engine-diag-error-line"
              className="truncate text-[11px] text-muted-foreground"
              title={e.detail}
            >
              {e.ev} · {e.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// —— 回收历史（全局，非按引擎）：时间 + 会话 + 原因 ——
function ReclaimList({ reclaims }: { reclaims: EngineReclaimRecord[] }) {
  const t = useT();
  return (
    <div data-testid="engine-diag-reclaims" className="space-y-0.5">
      <p className="text-xs font-medium text-muted-foreground/80">{t("diagnostics.engineFold.reclaimsTitle")}</p>
      {reclaims.length === 0 ? (
        <p data-testid="engine-diag-reclaims-empty" className="text-xs text-muted-foreground">
          {t("diagnostics.engineFold.reclaimsEmpty")}
        </p>
      ) : (
        <ul>
          {reclaims.map((r, i) => (
            <li
              key={i}
              data-testid="engine-diag-reclaim-entry"
              className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground"
            >
              <span className="shrink-0 tabular-nums">{relTime(new Date(r.at).toISOString())}</span>
              <span className="min-w-0 flex-1 truncate" title={r.sessionPath}>
                {sessionBase(r.sessionPath)}
              </span>
              <span className="shrink-0">
                {t(RECLAIM_REASON_KEY[r.reason] ?? "diagnostics.engineFold.reclaimIdleTimeout")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 折叠诊断区（导出供任务 3 总览引擎区块/总览页装配；默认收起，展开驱动采样） */
export function EngineDiagnosticsFold() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<EngineMetricsRow[] | null>(null);
  const [reclaims, setReclaims] = useState<EngineReclaimRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, r] = await Promise.all([api.getEngineMetrics(), api.getEngineReclaims()]);
      setRows(m.engines);
      setReclaims(r.reclaims);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, "diagnostics.engineFold.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  // 采样由展开驱动：false→true 翻转取一次 + 手动刷新取一次；无轮询
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <div data-testid="engine-diagnostics-fold" className="text-sm">
      <div className="flex items-center">
        <button
          type="button"
          data-testid="engine-diagnostics-fold-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-7 flex-1 items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground hover:bg-accent/50"
        >
          <span aria-hidden className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>
            ▶
          </span>
          {t("diagnostics.engineFold.title")}
        </button>
        {open && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => void load()}
            data-testid="engine-diagnostics-refresh"
          >
            {t("diagnostics.refresh")}
          </Button>
        )}
      </div>
      {open && (
        <div data-testid="engine-diagnostics-fold-body" className="mt-1 space-y-2 px-1">
          {error && (
            <p data-testid="engine-diagnostics-error" className="text-xs text-red-500">
              {error}
            </p>
          )}
          {loading && <p className="text-xs text-muted-foreground">{t("diagnostics.engineFold.loading")}</p>}
          {rows !== null && rows.length === 0 && (
            <p data-testid="engine-diagnostics-no-engines" className="text-xs text-muted-foreground">
              {t("diagnostics.engineFold.noEngines")}
            </p>
          )}
          {rows?.map((row) => (
            <EngineDiagRow key={row.sessionPath} row={row} />
          ))}
          {reclaims !== null && <ReclaimList reclaims={reclaims} />}
        </div>
      )}
    </div>
  );
}
