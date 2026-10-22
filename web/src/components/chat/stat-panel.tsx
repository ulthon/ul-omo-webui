// 右栏"统计"页签（A5）：累计 tokens / 缓存命中 / 上下文水位 / 成本 + 近 N 回合 tok/s。
// 成本全景（docs08 2026-10-22 批次任务 9，GAP-11 4⑪）：成本区升级"累计/今日"双数字 +
// 按模型拆分；缓存区补命中率；速度区补末回合 tok/s；新增耗时估算（模型 vs 工具）与
// 子代理逐个花费（含合计）分区。数据源全部现成：usage 快照 + messages store 条目
// （SSE/REST 已填充，仅订阅），无新端点无新拉取；缺数据行/区省略（stat-panel-data 口径）。
// 数据源 GET /api/usage（会话级快照 + 服务端内存速度环 turnSpeed）；形状解析复用
// status-bar-data 的 toUsageStats/parseTurnSpeed（容错缺字段/NaN 不崩）；接口失败显示
// "用量不可用"降级不白屏；无回合时速度区"暂无数据"。回合落定（runState→idle）自动刷新。
// 布局按右栏窄容器（320-560px）自适应：单列分区卡片，行内两端对齐 + 数值 tabular-nums。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useSessionsStore } from "@/stores/sessions";
import { useMessagesStore } from "@/stores/messages";
import {
  formatCost,
  formatTokens,
  parseTurnSpeed,
  toUsageStats,
  type TurnSpeedStats,
  type UsageStats,
} from "./status-bar-data";
import { aggregateCostBreakdown, aggregateTimeAttribution, cacheHitRate } from "./stat-panel-data";
import { formatStepDuration } from "./step-duration";
import { collectSubagentCalls, summaryOfCall } from "./subagent-data";
import { useT } from "@/i18n/i18n";

/** 回合速度展示值：≥100 取整，否则 1 位小数（tok/s 量级不锁具体精度） */
function fmtSpeed(v: number): string {
  return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
}

/** ISO → "HH:MM"（无效时间戳降级 "--:--"） */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function StatSection({ title, testid, children }: { title: string; testid: string; children: ReactNode }) {
  return (
    <section data-testid={testid} className="rounded-lg border p-3">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function StatRow({ label, value, testid }: { label: string; value: string; testid?: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span data-testid={testid} className="min-w-0 truncate text-right tabular-nums">
        {value}
      </span>
    </div>
  );
}

function PanelMessage({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <p className="text-sm text-muted-foreground">{title}</p>
      {hint ? <p className="text-xs text-muted-foreground/70">{hint}</p> : null}
    </div>
  );
}

export function StatPanel({ sessionId }: { sessionId: string | null }) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [speed, setSpeed] = useState<TurnSpeedStats | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  // 今日窗口基准（快照拉取时刻）：与整卡数据同节奏（回合落定刷新收敛）；避免渲染期取墙钟
  const [usageAt, setUsageAt] = useState(0);
  const runState = useSessionsStore((s) => (sessionId ? s.runStates[sessionId] : undefined));

  // 快照拉取：会话切换 / 回合落定重拉（reloadTick）/ 页签重挂时生效
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    api
      .getUsage(sessionId)
      .then((r) => {
        if (cancelled) return;
        setStats(toUsageStats(r.usage));
        setSpeed(parseTurnSpeed(r.usage));
        setUsageAt(Date.now());
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadTick]);

  // 回合落定沿（status-bar 同款 prev-ref 模式）：running→idle 边沿触发权威快照刷新
  const prevRunRef = useRef(runState);
  useEffect(() => {
    const prev = prevRunRef.current;
    prevRunRef.current = runState;
    if (runState !== "idle" || prev === "idle") return;
    setReloadTick((t) => t + 1);
  }, [runState]);

  // 成本全景聚合（任务 9）：订阅 messages store 已填充会话态（无新拉取），
  // 纯函数聚合今日/累计费用、耗时估算与子代理花费；entries/toolRuns 引用仅在变更时替换
  const sessionMessages = useMessagesStore((s) => (sessionId ? s.bySession[sessionId] : undefined));
  const entries = sessionMessages?.entries;
  const toolRuns = sessionMessages?.toolRuns;
  const breakdown = useMemo(
    () => aggregateCostBreakdown(stats?.cost ?? 0, entries ?? [], usageAt),
    [stats, entries, usageAt],
  );
  const timeAttr = useMemo(() => aggregateTimeAttribution(entries ?? []), [entries]);
  const costedSubagents = useMemo(
    () =>
      collectSubagentCalls(entries ?? [], toolRuns ?? {})
        .map((c) => ({
          key: c.toolCallId,
          label: summaryOfCall(c).primary || c.final?.taskId || c.toolCallId,
          cost: c.final?.runStats?.costUsd,
        }))
        .filter((r): r is { key: string; label: string; cost: number } => typeof r.cost === "number"),
    [entries, toolRuns],
  );
  const subagentTotal = costedSubagents.reduce((sum, r) => sum + r.cost, 0);

  const t = useT();
  if (!sessionId) return <PanelMessage title={t("chat.statPanel.noSession")} />;
  if (failed) return <PanelMessage title={t("chat.statPanel.unavailable")} hint={t("chat.statPanel.unavailableHint")} />;

  const tokens = stats?.tokens ?? null;
  const cacheRate = tokens ? cacheHitRate(tokens) : null;
  const ctx = stats?.context ?? null;
  const pct = ctx ? Math.min(100, Math.max(0, ctx.percent)) : 0;
  const turns = speed?.turns ?? [];

  return (
    <div data-testid="stat-panel" className="h-full space-y-3 overflow-y-auto p-3">
      <StatSection title={t("chat.statPanel.tokensTitle")} testid="stat-tokens">
        {tokens ? (
          <div className="space-y-1">
            <StatRow label={t("chat.statPanel.input")} value={formatTokens(tokens.input)} testid="stat-tokens-input" />
            <StatRow label={t("chat.statPanel.output")} value={formatTokens(tokens.output)} testid="stat-tokens-output" />
            <StatRow label={t("chat.statPanel.total")} value={formatTokens(tokens.total)} testid="stat-tokens-total" />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("chat.statPanel.loading")}</p>
        )}
      </StatSection>

      <StatSection title={t("chat.statPanel.cacheTitle")} testid="stat-cache">
        {tokens ? (
          <div className="space-y-1">
            <StatRow label={t("chat.statPanel.cacheRead")} value={formatTokens(tokens.cacheRead)} testid="stat-cache-read" />
            <StatRow label={t("chat.statPanel.cacheWrite")} value={formatTokens(tokens.cacheWrite)} testid="stat-cache-write" />
            {cacheRate !== null ? (
              <StatRow
                label={t("chat.statPanel.cacheRate")}
                value={`${Math.round(cacheRate * 100)}%`}
                testid="stat-cache-rate"
              />
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("chat.statPanel.loading")}</p>
        )}
      </StatSection>

      <StatSection title={t("chat.statPanel.contextTitle")} testid="stat-context">
        {ctx ? (
          <>
            <StatRow label={t("chat.statPanel.contextUsage")} value={`${Math.round(ctx.percent)}%`} testid="stat-context-percent" />
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1.5 text-xs tabular-nums text-muted-foreground">
              {formatTokens(ctx.tokens)} / {formatTokens(ctx.contextWindow)}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t("chat.statPanel.noContext")}</p>
        )}
      </StatSection>

      <StatSection title={t("chat.statPanel.costTitle")} testid="stat-cost">
        <StatRow label={t("chat.statPanel.costTotal")} value={formatCost(breakdown.cumulative)} testid="stat-cost-value" />
        <StatRow label={t("chat.statPanel.costToday")} value={formatCost(breakdown.todayTotal)} testid="stat-cost-today" />
        {breakdown.byModel.length > 0 ? (
          <ul className="mt-1.5 space-y-1 border-t pt-1.5">
            {breakdown.byModel.map((m) => (
              <li
                key={m.model}
                data-testid="stat-cost-model"
                className="flex min-w-0 items-baseline justify-between gap-2 text-xs"
              >
                <span className="min-w-0 truncate text-muted-foreground">{m.model}</span>
                <span className="shrink-0 tabular-nums">{formatCost(m.cost)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </StatSection>

      <StatSection title={t("chat.statPanel.speedTitle")} testid="stat-speed">
        {turns.length > 0 ? (
          <>
            <StatRow
              label={t("chat.statPanel.lastTurn")}
              value={`${fmtSpeed(turns[turns.length - 1].tokPerSec)} tok/s`}
              testid="stat-speed-last"
            />
            <StatRow
              label={t("chat.statPanel.avgTurns", { n: turns.length })}
              value={`${fmtSpeed(speed?.averageTokPerSec ?? 0)} tok/s`}
              testid="stat-speed-average"
            />
            <ul className="mt-2 space-y-1">
              {[...turns].reverse().map((t, i) => (
                <li
                  key={`${t.endedAt}-${i}`}
                  data-testid="stat-speed-turn"
                  className="flex min-w-0 items-baseline justify-between gap-2"
                >
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{shortTime(t.endedAt)}</span>
                  <span className="min-w-0 truncate text-right text-xs tabular-nums">
                    {fmtSpeed(t.tokPerSec)} tok/s
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p data-testid="stat-speed-empty" className="text-xs text-muted-foreground">
            {t("chat.statPanel.noData")}
          </p>
        )}
      </StatSection>

      {timeAttr.modelMs !== null || timeAttr.toolMs !== null ? (
        <StatSection title={t("chat.statPanel.timeTitle")} testid="stat-time">
          {timeAttr.modelMs !== null ? (
            <StatRow
              label={t("chat.statPanel.timeModel")}
              value={formatStepDuration(timeAttr.modelMs)}
              testid="stat-time-model"
            />
          ) : null}
          {timeAttr.toolMs !== null ? (
            <StatRow
              label={t("chat.statPanel.timeTool")}
              value={formatStepDuration(timeAttr.toolMs)}
              testid="stat-time-tool"
            />
          ) : null}
        </StatSection>
      ) : null}

      {costedSubagents.length > 0 ? (
        <StatSection title={t("chat.statPanel.subagentsTitle")} testid="stat-subagents">
          {costedSubagents.map((r) => (
            <StatRow key={r.key} label={r.label} value={formatCost(r.cost)} testid="stat-subagent-cost" />
          ))}
          <StatRow
            label={t("chat.statPanel.subagentTotal")}
            value={formatCost(subagentTotal)}
            testid="stat-subagent-total"
          />
        </StatSection>
      ) : null}
    </div>
  );
}
