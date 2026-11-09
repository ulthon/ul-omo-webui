// 右栏总览「引擎」区块（engine-ux-visibility 任务 3）：当前会话绑定引擎的状态速览
// + 停止入口——不必进设置页即可见（IS-1）可管控（IS-4）。
// 数据源 GET /api/engines/metrics（任务 1，纯读不 spawn；引擎缺席 = 空列表），
// 行匹配键 = sessionPath（引擎绑定键，与 GET /api/engines 行/SSE 信封同口径）；
// durable sessionId → sessionPath 走 sessions store byProject 反查（EngineStatusBar
// 同款选择器）。设置页进程管理分区并存不动（Must-NOT）。
// 更新策略（无轮询定时器，全部事件/请求驱动）：
// - 挂载 / 会话切换：立即拉取一次（seq 防旧响应落新会话；切换先清旧行防串台）；
// - SSE 衍生信号：engines store 本会话引擎键状态变化（engine_state 帧 / 引擎帧
//   存活推导 / 墓碑对账重取均落此处）或首次快照同步 → 重拉；
// - 手动刷新钮；停止成功后重拉。
// 停止（走既有 API 不新造）：设置页进程管理同款 POST /api/engines/stop
// {sessionPath}。空闲直接停；本会话回合进行中（sessions store runState ∈
// running/waiting/background_running，与 event-dispatch 活跃态同集）原生 confirm
// 二次确认（engine-section / notes-view 同款先例）——拒绝即零调用。
// 隐藏规则：无会话 / 行未知 / 指标无匹配行 / 拉取失败 → 整块不渲染（null）。
// 可选字段（remainingIdleMs/activityWindowExempt，任务 2 落地中）：防御渲染，
// 缺席即不渲染该行，不崩。
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type EngineMetricsRow } from "@/lib/api";
import { apiErrorMessage } from "@/i18n/errors";
import { useT, type MessageKey } from "@/i18n/i18n";
import { useEnginesStore } from "@/stores/engines";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

const OVERVIEW_SECTION_CLASS = "border-b px-3 py-2.5 last:border-b-0";
const OVERVIEW_TITLE_CLASS = "mb-1.5 text-xs font-medium text-muted-foreground";
// 与 overview-panel 其余块同款限高内部滚动
const OVERVIEW_BODY_CLASS = "max-h-64 overflow-y-auto";
// overview-plan 同款小按钮档（区块头行操作钮）
const BTN_CLASS =
  "shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 disabled:pointer-events-none";

/** 状态徽标文案键（stopped/stopping/unavailable 一律归「已回收」档） */
const STATE_KEY: Record<string, MessageKey> = {
  ready: "login.rightRail.overview.engineStateReady",
  starting: "login.rightRail.overview.engineStateStarting",
  backoff: "login.rightRail.overview.engineStateBackoff",
};

/** 回合进行中判据（与 event-dispatch 活跃态同集）：停止需 confirm 的三态 */
const ACTIVE_TURN: ReadonlySet<string> = new Set(["running", "waiting", "background_running"]);

/** 可停状态（设置页进程管理 stoppable 同款）：ready/starting */
function stoppable(state: string): boolean {
  return state === "ready" || state === "starting";
}

/** 字节人性化（B/KB/MB/GB，GB 两位小数；与 file-tree-logic formatBytes 同阶梯补 GB 档） */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 毫秒时长人性化（ms/s/m/h；subagent-panel 同款阶梯） */
function fmtMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function OverviewEngine({ sessionId }: { sessionId: string | null }) {
  const t = useT();
  const pushGlobalError = useUiStore((s) => s.pushGlobalError);
  // durable id → 会话文件路径（引擎键）。引用稳定：命中即返回行 path 原值。
  const sessionPath = useSessionsStore((s) => {
    if (!sessionId) return null;
    for (const list of Object.values(s.byProject)) {
      const hit = list.find((item) => item.id === sessionId);
      if (hit) return hit.path;
    }
    return null;
  });
  // 本会话回合进行态（SSE 驱动 runStates）：停止确认门的判据
  const turnActive = useSessionsStore((s) => !!sessionId && ACTIVE_TURN.has(s.runStates[sessionId] ?? ""));
  const [row, setRow] = useState<EngineMetricsRow | null>(null);
  const [stopping, setStopping] = useState(false);
  // 在途请求序号：旧响应不落新状态（会话切换 / 快速连刷竞态）
  const seqRef = useRef(0);

  const load = useCallback((): Promise<void> => {
    if (sessionPath === null) return Promise.resolve();
    const seq = ++seqRef.current;
    return api
      .getEngineMetrics()
      .then((r) => {
        if (seq !== seqRef.current) return;
        setRow(r.engines.find((e) => e.sessionPath === sessionPath) ?? null);
      })
      .catch(() => {
        if (seq !== seqRef.current) return;
        setRow(null); // 拉取失败 = 不可知：整块隐藏，观测面不误报
      });
  }, [sessionPath]);

  // 挂载 / 会话切换拉取（先清旧行）+ SSE 衍生重拉（本会话引擎键状态变化或首次
  // 快照同步；engine_state 帧/存活推导/墓碑对账全部收敛到 engines store 状态键）。
  useEffect(() => {
    setRow(null);
    if (sessionPath === null) return;
    void load();
    return useEnginesStore.subscribe((s, prev) => {
      if (s.states[sessionPath] !== prev.states[sessionPath] || s.synced !== prev.synced) void load();
    });
  }, [sessionPath, load]);

  // 停止：空闲直呼既有 API；回合进行中 confirm 门（拒绝即零调用）。
  const onStop = useCallback((): void => {
    if (row === null || stopping) return;
    if (turnActive && !window.confirm(t("login.rightRail.overview.engineStopConfirm"))) return;
    setStopping(true);
    api
      .stopEngine({ sessionPath: row.sessionPath })
      .then(() => load())
      .catch((err: unknown) => {
        pushGlobalError(apiErrorMessage(err, "login.rightRail.overview.engineStopFailed"));
      })
      .finally(() => setStopping(false));
  }, [row, stopping, turnActive, load, t, pushGlobalError]);

  // 隐藏规则：无可匹配行即整块不渲染
  if (row === null) return null;

  const stateKey = STATE_KEY[row.state];
  const stateClass =
    row.state === "ready"
      ? "shrink-0 text-xs font-medium text-primary"
      : row.state === "backoff"
        ? "shrink-0 text-xs text-red-500"
        : row.state === "starting"
          ? "shrink-0 text-xs font-medium"
          : "shrink-0 text-xs text-muted-foreground";
  const memValue =
    typeof row.treeRssBytes === "number"
      ? `${fmtBytes(row.treeRssBytes)} · ${t("login.rightRail.overview.engineChildren", { n: String(row.childCount) })}`
      : "—";
  const startupParts: string[] = [];
  if (typeof row.startupMs === "number") {
    startupParts.push(`${t("login.rightRail.overview.engineStartupNow")} ${fmtMs(row.startupMs)}`);
  }
  if (typeof row.lastStartupMs === "number") {
    startupParts.push(`${t("login.rightRail.overview.engineStartupLast")} ${fmtMs(row.lastStartupMs)}`);
  }
  const startupValue = startupParts.length > 0 ? startupParts.join(" · ") : "—";
  // 探活窗可选字段（任务 2 落地中）：豁免态优先于倒计时；两者皆缺席不渲染该行
  const idleExempt = row.activityWindowExempt === true;
  const idleLeftMs = !idleExempt && typeof row.remainingIdleMs === "number" && Number.isFinite(row.remainingIdleMs) ? row.remainingIdleMs : null;

  return (
    <section data-testid="overview-engine" className={OVERVIEW_SECTION_CLASS}>
      <div className="flex items-center justify-between gap-2">
        <h3 className={OVERVIEW_TITLE_CLASS}>{t("login.rightRail.overview.engineTitle")}</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="overview-engine-stop"
            className={BTN_CLASS}
            disabled={!stoppable(row.state) || stopping}
            onClick={onStop}
          >
            {stopping ? "…" : t("login.rightRail.overview.engineStop")}
          </button>
          <button type="button" data-testid="overview-engine-refresh" className={BTN_CLASS} onClick={() => void load()}>
            {t("login.rightRail.overview.engineRefresh")}
          </button>
        </div>
      </div>
      <div className={OVERVIEW_BODY_CLASS}>
        <p className="flex min-w-0 items-baseline gap-2 text-sm leading-relaxed">
          <span data-testid="overview-engine-state" data-state={row.state} className={stateClass}>
            {t(stateKey ?? "login.rightRail.overview.engineStateReclaimed")}
          </span>
          {row.boundSession !== null && (
            <>
              <span className="min-w-0 flex-1 truncate text-foreground" title={row.boundSession.title}>
                {row.boundSession.title}
              </span>
              <span data-testid="overview-engine-session-size" className="shrink-0 tabular-nums text-xs text-muted-foreground">
                {fmtBytes(row.boundSession.fileSizeBytes)}
              </span>
            </>
          )}
        </p>
        <ul className="mt-1 space-y-0.5 text-sm">
          <li data-testid="overview-engine-mem" className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">{t("login.rightRail.overview.engineMemTree")}</span>
            <span className="tabular-nums">{memValue}</span>
          </li>
          <li data-testid="overview-engine-startup" className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">{t("login.rightRail.overview.engineStartup")}</span>
            <span className="tabular-nums">{startupValue}</span>
          </li>
          <li data-testid="overview-engine-uptime" className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">{t("login.rightRail.overview.engineUptime")}</span>
            <span className="tabular-nums">{typeof row.uptimeMs === "number" ? fmtMs(row.uptimeMs) : "—"}</span>
          </li>
          <li data-testid="overview-engine-restarts" className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">{t("login.rightRail.overview.engineRestarts")}</span>
            <span className="tabular-nums">{t("login.rightRail.overview.engineRestartsTimes", { n: String(row.workerRestartCount) })}</span>
          </li>
          {(idleExempt || idleLeftMs !== null) && (
            <li data-testid="overview-engine-idle" className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground">{t("login.rightRail.overview.engineIdleLeft")}</span>
              <span className="tabular-nums">{idleExempt ? t("login.rightRail.overview.engineIdleExempt") : fmtMs(idleLeftMs as number)}</span>
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}
