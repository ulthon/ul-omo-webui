// 右栏「子代理」页签（docs08-r6 任务 17，GAP-8）：父会话 task 工具调用的聚合呈现。
// 复用右栏页签体系（stat-panel/memory-panel 范式：sessionId 入参 + data-testid 根 +
// 分区卡片 + 诚实空态）。数据源 messages store 双路合并（subagent-data.collectSubagentCalls）：
// toolRuns 事件实时态（start args / update 最新 LIVE 快照 / end 终态）+ entries 历史终态
// （task toolCall part + toolResult 配对消息）——刷新后历史卡仍在；运行中实时态只在
// 事件流在线时可得（D3 纪律：不重开任何订阅通道，全部走前台帧）。
// 运行中卡：状态徽标 + 模型 + 引擎拼好的 progress.activity 一行 + turns/工具/tokens/
// tok-s 计数 + lastAssistantLine 摘要行；零中间帧的快调用（spike 风险留档：快任务每调用
// 仅 2 帧、长任务未测）自动降级为「摘要 + 运行中」，不崩不空转。终态卡：状态/模型/用量
// （run_stats：时长·回合·工具·tokens·速率·费用·缓存命中率）+ 最终回复（result.content
// 文本剥 [task_id] 尾注，可展开，附完整提示词）。布局按右栏窄容器（320-560px）自适应。
import { useMemo, useState } from "react";
import { ChevronDown, CircleCheck, CircleX, Loader2 } from "lucide-react";
import { useMessagesStore } from "@/stores/messages";
import { formatCost, formatTokens } from "./status-bar-data";
import { collectSubagentCalls, summaryOfCall, type SubagentCall } from "./subagent-data";
import { useT } from "@/i18n/i18n";

/** runtime_ms → "123ms" / "8.5s" / "1m 23s" */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** 速率整数位收敛（54 → "54"；53.7 → "53.7"） */
function formatSpeed(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/** 终态 status 词表 → 失败族（其余原样显示，不虚标完成） */
const FAILURE_STATUSES = new Set(["failed", "errored", "error", "cancelled", "canceled"]);

function StatusPill({ call }: { call: SubagentCall }) {
  const t = useT();
  const failed = call.isError || (call.final?.status != null && FAILURE_STATUSES.has(call.final.status));
  const label = call.running
    ? t("chat.subagentPanel.statusRunning")
    : failed
      ? t("chat.subagentPanel.statusFailed")
      : call.final == null
        ? "—"
        : call.final.status != null && call.final.status !== "completed"
          ? call.final.status
          : t("chat.subagentPanel.statusDone");
  return (
    <span
      data-testid="subagent-card-status"
      className={`flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs ${
        failed ? "border-destructive/30 text-destructive" : "border-border text-muted-foreground"
      } ${call.running ? "animate-pulse" : ""}`}
    >
      {call.running ? (
        <Loader2 className="size-3 shrink-0 animate-spin" />
      ) : failed ? (
        <CircleX className="size-3 shrink-0" />
      ) : (
        <CircleCheck className="size-3 shrink-0" />
      )}
      {label}
    </span>
  );
}

function SubagentCard({ call }: { call: SubagentCall }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { primary, category, prompt } = summaryOfCall(call);
  const modelDisplay = call.final?.modelDisplay ?? call.live?.modelDisplay ?? null;
  const taskId = call.final?.taskId ?? call.live?.taskId ?? null;

  // 计数行（LIVE 与终态同槽）：仅渲染存在的字段，join " · "
  let metrics: string[] = [];
  if (call.running) {
    const live = call.live;
    if (live) {
      metrics = [
        live.turns != null ? t("chat.subagentPanel.metricTurns", { n: live.turns }) : null,
        live.toolCalls != null ? t("chat.subagentPanel.metricToolCalls", { n: live.toolCalls }) : null,
        live.tokens != null ? t("chat.subagentPanel.metricTokens", { n: formatTokens(live.tokens) }) : null,
        live.outputTokens != null ? t("chat.subagentPanel.metricOutput", { n: formatTokens(live.outputTokens) }) : null,
        live.tokensPerSecond != null ? `${formatSpeed(live.tokensPerSecond)} tok/s` : null,
      ].filter((s): s is string => s != null);
    }
  } else {
    const rs = call.final?.runStats;
    if (rs) {
      metrics = [
        rs.runtimeMs != null ? t("chat.subagentPanel.metricRuntime", { dur: formatDuration(rs.runtimeMs) }) : null,
        rs.turns != null ? t("chat.subagentPanel.metricTurns", { n: rs.turns }) : null,
        rs.toolCalls != null ? t("chat.subagentPanel.metricToolCalls", { n: rs.toolCalls }) : null,
        rs.totalTokens != null ? t("chat.subagentPanel.metricTokens", { n: formatTokens(rs.totalTokens) }) : null,
        rs.outputTokens != null ? t("chat.subagentPanel.metricOutput", { n: formatTokens(rs.outputTokens) }) : null,
        rs.tokensPerSecond != null ? `${formatSpeed(rs.tokensPerSecond)} tok/s` : null,
        rs.costUsd != null ? formatCost(rs.costUsd) : null,
        rs.cacheHitRateRun != null ? t("chat.subagentPanel.metricCache", { pct: `${(rs.cacheHitRateRun * 100).toFixed(1)}%` }) : null,
      ].filter((s): s is string => s != null);
    }
  }

  return (
    <article data-testid="subagent-card" data-tool-call={call.toolCallId} className="rounded-lg border p-3">
      <div className="flex min-w-0 items-center gap-2">
        <StatusPill call={call} />
        {category ? (
          <span data-testid="subagent-card-category" className="shrink-0 rounded border bg-muted/40 px-1 py-px font-mono text-[10px] leading-4 text-muted-foreground">
            {category}
          </span>
        ) : null}
        {modelDisplay ? (
          <span data-testid="subagent-card-model" className="min-w-0 truncate text-xs text-muted-foreground" title={modelDisplay}>
            {modelDisplay}
          </span>
        ) : null}
      </div>
      {primary ? (
        <p data-testid="subagent-card-summary" className="mt-1.5 truncate text-sm text-foreground/90" title={primary}>
          {primary}
        </p>
      ) : null}
      {taskId ? <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/70">{taskId}</p> : null}

      {call.running ? (
        <>
          {call.live?.activity ? (
            <p data-testid="subagent-card-activity" className="mt-1 truncate text-xs text-muted-foreground" title={call.live.activity}>
              {call.live.activity}
            </p>
          ) : null}
          {metrics.length > 0 ? (
            <p data-testid="subagent-card-metrics" className="mt-1 text-xs tabular-nums text-muted-foreground">
              {metrics.join(" · ")}
            </p>
          ) : null}
          {call.live?.lastAssistantLine ? (
            <p data-testid="subagent-card-lastline" className="mt-1 truncate font-mono text-xs text-muted-foreground/80" title={call.live.lastAssistantLine}>
              ↳ {call.live.lastAssistantLine}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {metrics.length > 0 ? (
            <p data-testid="subagent-card-metrics" className="mt-1 text-xs tabular-nums text-muted-foreground">
              {metrics.join(" · ")}
            </p>
          ) : null}
          {call.final ? (
            <div className="mt-2">
              <button
                type="button"
                data-testid="subagent-card-expand"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="flex min-h-9 w-full items-center gap-1 text-left"
              >
                <span className="text-xs font-medium text-muted-foreground/80">{t("chat.subagentPanel.responseTitle")}</span>
                <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
              </button>
              {open ? (
                <div className="mt-1.5 space-y-2">
                  <pre
                    data-testid="subagent-card-response"
                    className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-xs leading-relaxed text-muted-foreground"
                  >
                    {call.final.responseText || t("chat.subagentPanel.responseEmpty")}
                  </pre>
                  {prompt ? (
                    <section>
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground/80">{t("chat.subagentPanel.promptTitle")}</div>
                      <pre
                        data-testid="subagent-card-prompt"
                        className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-xs leading-relaxed text-muted-foreground"
                      >
                        {prompt}
                      </pre>
                    </section>
                  ) : null}
                </div>
              ) : call.final.responseText ? (
                <p data-testid="subagent-card-response-preview" className="mt-1 truncate text-xs text-muted-foreground">
                  {(call.final.responseText.split("\n", 1)[0] ?? "").trim()}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}

function PanelMessage({ title, hint, testid }: { title: string; hint?: string; testid?: string }) {
  return (
    <div data-testid={testid} className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <p className="text-sm text-muted-foreground">{title}</p>
      {hint ? <p className="text-xs text-muted-foreground/70">{hint}</p> : null}
    </div>
  );
}

export function SubagentPanel({ sessionId }: { sessionId: string | null }) {
  const t = useT();
  const entries = useMessagesStore((s) => (sessionId ? s.bySession[sessionId]?.entries : undefined));
  const toolRuns = useMessagesStore((s) => (sessionId ? s.bySession[sessionId]?.toolRuns : undefined));
  // 双路聚合（useMemo 稳定：entries/toolRuns 引用各自仅在变更时替换）
  const calls = useMemo(
    () => (sessionId ? collectSubagentCalls(entries ?? [], toolRuns ?? {}) : []),
    [sessionId, entries, toolRuns],
  );

  if (!sessionId) return <PanelMessage testid="subagent-nosession" title={t("chat.subagentPanel.noSession")} />;
  if (calls.length === 0) {
    return (
      <PanelMessage
        testid="subagent-empty"
        title={t("chat.subagentPanel.emptyTitle")}
        hint={t("chat.subagentPanel.emptyHint")}
      />
    );
  }
  return (
    <div data-testid="subagent-panel" className="h-full space-y-3 overflow-y-auto p-3">
      {/* 最新在前（首见序反序）：运行中的卡恒在可视区顶部 */}
      {[...calls].reverse().map((call) => (
        <SubagentCard key={call.toolCallId} call={call} />
      ))}
    </div>
  );
}
