// 右栏"统计"页签（A5）：累计 tokens / 缓存命中 / 上下文水位 / 成本 + 近 N 回合 tok/s。
// 数据源 GET /api/usage（会话级快照 + 服务端内存速度环 turnSpeed）；形状解析复用
// status-bar-data 的 toUsageStats/parseTurnSpeed（容错缺字段/NaN 不崩）；接口失败显示
// "用量不可用"降级不白屏；无回合时速度区"暂无数据"。回合落定（runState→idle）自动刷新。
// 布局按右栏窄容器（320-560px）自适应：单列分区卡片，行内两端对齐 + 数值 tabular-nums。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useSessionsStore } from "@/stores/sessions";
import {
  formatCost,
  formatTokens,
  parseTurnSpeed,
  toUsageStats,
  type TurnSpeedStats,
  type UsageStats,
} from "./status-bar-data";

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

  if (!sessionId) return <PanelMessage title="未选择会话" />;
  if (failed) return <PanelMessage title="用量不可用" hint="统计服务暂时无法访问，稍后自动恢复" />;

  const tokens = stats?.tokens ?? null;
  const ctx = stats?.context ?? null;
  const pct = ctx ? Math.min(100, Math.max(0, ctx.percent)) : 0;
  const turns = speed?.turns ?? [];

  return (
    <div data-testid="stat-panel" className="h-full space-y-3 overflow-y-auto p-3">
      <StatSection title="累计 Tokens" testid="stat-tokens">
        {tokens ? (
          <div className="space-y-1">
            <StatRow label="输入" value={formatTokens(tokens.input)} testid="stat-tokens-input" />
            <StatRow label="输出" value={formatTokens(tokens.output)} testid="stat-tokens-output" />
            <StatRow label="总计" value={formatTokens(tokens.total)} testid="stat-tokens-total" />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">用量统计中…</p>
        )}
      </StatSection>

      <StatSection title="缓存命中" testid="stat-cache">
        {tokens ? (
          <div className="space-y-1">
            <StatRow label="缓存读" value={formatTokens(tokens.cacheRead)} testid="stat-cache-read" />
            <StatRow label="缓存写" value={formatTokens(tokens.cacheWrite)} testid="stat-cache-write" />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">用量统计中…</p>
        )}
      </StatSection>

      <StatSection title="上下文水位" testid="stat-context">
        {ctx ? (
          <>
            <StatRow label="占用" value={`${Math.round(ctx.percent)}%`} testid="stat-context-percent" />
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
          <p className="text-xs text-muted-foreground">暂无上下文数据</p>
        )}
      </StatSection>

      <StatSection title="成本" testid="stat-cost">
        <StatRow label="累计费用" value={formatCost(stats?.cost ?? 0)} testid="stat-cost-value" />
      </StatSection>

      <StatSection title="回合速度" testid="stat-speed">
        {turns.length > 0 ? (
          <>
            <StatRow
              label={`平均（${turns.length} 回合）`}
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
            暂无数据（回合结束后出现）
          </p>
        )}
      </StatSection>
    </div>
  );
}
