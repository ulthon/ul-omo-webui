// 顶栏上下文水位环（A3/A6 手机档）：SVG 圆环 + 中心百分比小字。数据 GET /api/usage 的
// contextUsage（toUsageStats 与 stat-panel/status-bar 同源）；刷新时机=会话打开 + 回合落定
// 沿（status-bar.tsx:114-121 先例），不做流式跟随动画。运行态并入（状态栏同口径
// running=streaming||hasPendingPermission）：环色随运行态变化 + 环旁小脉冲点；点环弹
// Popover 明细（tok/成本/输入输出/缓存/上下文/运行态），手机档承接退役状态栏的全部信息。
// 无会话由宿主控制不挂载；无 contextUsage 数据（接口失败/无上下文窗口）整环隐藏。
import { useEffect, useRef, useState } from "react";
import { api, shortModelName } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { usePermissionsStore } from "@/stores/permissions";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatCost, formatTokens, toUsageStats, type UsageStats } from "@/components/chat/status-bar-data";
import { onUsageRefresh } from "@/components/chat/compact-run";
import { useT } from "@/i18n/i18n";

const RADIUS = 15.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 水位环分母校准（docs08-r6 任务 8 ⑥）：引擎实测值优先——GET /api/models 所选模型的
 * contextWindow 与引擎上报分母一致（setModel 后引擎已随模型更新）或模型侧无配置时，
 * 按引擎 percent；不一致（引擎未随 setModel 更新 contextUsage.contextWindow，隔离实例
 * 实测见 .omo/evidence/docs08-r6/task-8-qa.md）时以模型侧窗口为分母用 tokens 重算。
 * 兜底分支不假装引擎值存在：tokens/模型窗口直接重算，而非沿用错误 percent。 */
export function calibrateContextPercent(
  context: { tokens: number; contextWindow: number; percent: number },
  modelContextWindow: number | null | undefined,
): number {
  const clamp = (p: number): number => Math.min(100, Math.max(0, p));
  if (typeof modelContextWindow !== "number" || !(modelContextWindow > 0)) return clamp(context.percent);
  if (modelContextWindow === context.contextWindow) return clamp(context.percent);
  return clamp((context.tokens / modelContextWindow) * 100);
}

function DetailRow({ label, value, testid }: { label: string; value: string; testid?: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span data-testid={testid} className="min-w-0 truncate text-right tabular-nums">
        {value}
      </span>
    </div>
  );
}

export function ContextWaterRing({ sessionId }: { sessionId: string }) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const runState = useSessionsStore((s) => s.runStates[sessionId]);
  const streaming = useMessagesStore((s) => s.bySession[sessionId]?.streaming ?? false);
  const hasPendingPermission = usePermissionsStore((s) => (s.bySession[sessionId]?.length ?? 0) > 0);
  // 会话生效模型（docs08-r6 任务 8 ⑤⑥）：SSE model_changed / prompt 回执双路写入；
  // 未知（null，未见回显）时 tooltip 不附模型短名、分母不校准（按引擎值）。
  const appliedModel = useSessionsStore((s) => s.appliedModels[sessionId] ?? null);
  const models = useUiStore((s) => s.models);
  const t = useT();
  const running = streaming || hasPendingPermission;
  const appliedModelWindow = appliedModel
    ? (models.find((m) => `${m.provider}/${m.id}` === appliedModel)?.contextWindow ?? null)
    : null;

  // 快照：会话打开拉取（切换会话 props 变更即重拉；拉取期间保留旧值防闪烁）；
  // 生效模型变更（setModel 落定）也重拉——contextUsage 分母随模型而变
  useEffect(() => {
    let cancelled = false;
    api
      .getUsage(sessionId)
      .then((r) => {
        if (!cancelled) setStats(toUsageStats(r.usage));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, appliedModel]);

  // 回合落定沿（running→idle / runState→idle 边沿）刷新权威快照（status-bar 先例）
  const prevRunRef = useRef(runState);
  useEffect(() => {
    const prev = prevRunRef.current;
    prevRunRef.current = runState;
    if (runState !== "idle" || prev === "idle") return;
    api
      .getUsage(sessionId)
      .then((r) => setStats(toUsageStats(r.usage)))
      .catch(() => {});
  }, [runState, sessionId]);

  // 压缩等非回合路径的水位刷新广播（docs08-r5 任务 8）：立即重拉，环即时反映压缩效果
  useEffect(
    () =>
      onUsageRefresh(() => {
        api
          .getUsage(sessionId)
          .then((r) => setStats(toUsageStats(r.usage)))
          .catch(() => {});
      }),
    [sessionId],
  );

  // 无数据整环隐藏（接口失败 / 无 contextUsage）
  if (!stats || !stats.context) return null;
  const ctx = stats.context;
  const tokens = stats.tokens;
  // 分母校准（任务 8 ⑥）：模型侧窗口与引擎分母不一致时以模型侧重算
  const pct = calibrateContextPercent(ctx, appliedModelWindow);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="context-ring"
          aria-label={t("login.contextRing.ringLabel", { pct: Math.round(pct) })}
          title={
            appliedModel
              ? t("login.contextRing.ringTitleWithModel", { pct: Math.round(pct), model: shortModelName(appliedModel) })
              : t("login.contextRing.ringTitle", { pct: Math.round(pct) })
          }
          className="relative flex size-9 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <svg viewBox="0 0 36 36" className="size-9 -rotate-90" aria-hidden>
            <circle cx="18" cy="18" r={RADIUS} fill="none" strokeWidth="3.5" className="stroke-muted" />
            <circle
              cx="18"
              cy="18"
              r={RADIUS}
              fill="none"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - pct / 100)}
              className={running ? "stroke-amber-500" : "stroke-primary"}
            />
          </svg>
          <span
            data-testid="context-ring-percent"
            className="absolute inset-0 flex items-center justify-center text-[9px] font-medium tabular-nums"
          >
            {Math.round(pct)}%
          </span>
          {running && (
            <span
              data-testid="context-ring-running-dot"
              className="absolute -right-0.5 -top-0.5 size-2 animate-pulse rounded-full bg-amber-500"
              aria-hidden
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-3 text-xs" data-testid="context-ring-detail">
        <div className="mb-2 flex items-center gap-1.5">
          <span
            className={`inline-block size-1.5 shrink-0 rounded-full ${running ? "animate-pulse bg-primary" : "bg-muted-foreground/40"}`}
            aria-hidden
          />
          <span data-testid="context-ring-run-state" data-running={running ? "true" : "false"} className="shrink-0">
            {running ? t("login.contextRing.running") : t("login.contextRing.idle")}
          </span>
          <span className="ml-auto truncate text-muted-foreground">{t("login.contextRing.usage")}</span>
        </div>
        <div className="space-y-1.5">
          <DetailRow label={t("login.contextRing.total")} value={`${formatTokens(tokens.total)} tok`} testid="context-ring-tok" />
          <DetailRow
            label={t("login.contextRing.inputOutput")}
            value={`↑${formatTokens(tokens.input)} ↓${formatTokens(tokens.output)}`}
            testid="context-ring-io"
          />
          <DetailRow
            label={t("login.contextRing.cache")}
            value={formatTokens(tokens.cacheRead + tokens.cacheWrite)}
            testid="context-ring-cache"
          />
          <DetailRow label={t("login.contextRing.cost")} value={formatCost(stats.cost)} testid="context-ring-cost" />
          <DetailRow label={t("login.contextRing.context")} value={`${Math.round(pct)}%`} testid="context-ring-ctx" />
        </div>
      </PopoverContent>
    </Popover>
  );
}
