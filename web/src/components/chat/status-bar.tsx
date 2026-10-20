// 会话 token/费用状态条（todo 24）。两路更新：
//   1) 会话打开 / 回合落定 → GET /api/usage 权威快照（get_session_stats，verification/05 P1-4）；
//   2) 流式事件增量 → 订阅 messages store 的 entries 变化，新落盘 assistant 条目的
//      message.usage 累加进快照（message_end 驱动；message_update 流式中多为 0 不增量）。
//   增量为暂示值（QA 实证：agent_end 可能早于引擎统计终值，消息级 totalTokens 与会话级
//   stats 的口径也有差），防抖快照刷新保证落定后收敛。
// 运行指示与 composer 锁同口径（todo 18 锁协同）：streaming || 未决权限请求。
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { usePermissionsStore } from "@/stores/permissions";
import { useSessionsStore } from "@/stores/sessions";
import type { WireEntry } from "@/lib/api";
import { addMessageUsage, formatCost, formatTokens, toUsageStats, type UsageStats } from "./status-bar-data";
import { useT } from "@/i18n/i18n";
import { onUsageRefresh } from "./compact-run";

function entryId(entry: WireEntry): string | null {
  return typeof entry.id === "string" ? entry.id : null;
}

const SNAPSHOT_REFRESH_MS = 1200;

export function StatusBar({ sessionId }: { sessionId: string }) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [failed, setFailed] = useState(false);
  const runState = useSessionsStore((s) => s.runStates[sessionId]);
  const streaming = useMessagesStore((s) => s.bySession[sessionId]?.streaming ?? false);
  const hasPendingPermission = usePermissionsStore((s) => (s.bySession[sessionId]?.length ?? 0) > 0);
  const t = useT();
  const running = streaming || hasPendingPermission;

  const baselineRef = useRef<UsageStats | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const lastEntriesRef = useRef<WireEntry[] | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 应用快照：置换基线并把当前 entries 全部标记为已计（防重复累加） */
  const applySnapshot = useCallback(
    (usage: unknown) => {
      const next = toUsageStats(usage);
      baselineRef.current = next;
      setStats(next);
      const entries = useMessagesStore.getState().bySession[sessionId]?.entries ?? [];
      seenIdsRef.current = new Set(entries.map(entryId).filter((id): id is string => id !== null));
      lastEntriesRef.current = entries;
    },
    [sessionId],
  );

  /** 防抖快照刷新（落定/增量后拉权威快照收敛漂移） */
  const scheduleSnapshotRefresh = useCallback(
    (delayMs = SNAPSHOT_REFRESH_MS) => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        api
          .getUsage(sessionId)
          .then((r) => applySnapshot(r.usage))
          .catch(() => {});
      }, delayMs);
    },
    [sessionId, applySnapshot],
  );

  // 卸载时清防抖定时器
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  // 路一：会话打开拉快照（ChatSession 按 key 重挂载，本 effect 即会话打开时机；
  // 失败态置位走异步回调，effect 内不做同步 setState）
  useEffect(() => {
    let cancelled = false;
    api
      .getUsage(sessionId)
      .then((r) => {
        if (!cancelled) applySnapshot(r.usage);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, applySnapshot]);

  // 路二：事件增量——订阅 store，新落盘 assistant 条目的 usage 累加。
  // entries 引用未变（流式 delta 只动 streamingMessage）时跳过，避免逐 delta 全量扫描。
  useEffect(() => {
    const check = () => {
      const baseline = baselineRef.current;
      const entries = useMessagesStore.getState().bySession[sessionId]?.entries ?? null;
      if (!baseline || entries === lastEntriesRef.current) return;
      lastEntriesRef.current = entries;
      let next: UsageStats | null = null;
      for (const entry of entries) {
        const id = entryId(entry);
        if (id === null) continue;
        if (seenIdsRef.current.has(id)) continue;
        seenIdsRef.current.add(id);
        const msg = entry.message as Record<string, unknown> | undefined;
        if (!msg || msg.role !== "assistant") continue;
        next = addMessageUsage(next ?? baseline, msg);
      }
      if (next) {
        setStats(next);
        scheduleSnapshotRefresh();
      }
    };
    check();
    return useMessagesStore.subscribe(check);
  }, [sessionId, scheduleSnapshotRefresh]);

  // 回合落定（runState→idle）拉权威快照收敛漂移
  const prevRunStateRef = useRef(runState);
  useEffect(() => {
    const prev = prevRunStateRef.current;
    prevRunStateRef.current = runState;
    if (runState !== "idle" || prev === "idle") return;
    scheduleSnapshotRefresh();
  }, [runState, sessionId, scheduleSnapshotRefresh]);

  // 压缩等非回合路径的水位刷新广播（docs08-r5 任务 8）：立即重拉权威快照
  useEffect(() => onUsageRefresh(() => scheduleSnapshotRefresh(0)), [scheduleSnapshotRefresh]);

  const tokens = stats?.tokens;

  return (
    <div
      data-testid="status-bar"
      data-running={running ? "true" : "false"}
      className="shrink-0 border-t px-3 py-1.5 text-xs text-muted-foreground"
    >
      <div className="mx-auto flex w-full max-w-3xl min-w-0 items-center gap-2">
        <span
          data-testid="status-running-dot"
          className={`inline-block size-1.5 shrink-0 rounded-full ${
            running ? "animate-pulse bg-primary" : "bg-muted-foreground/40"
          }`}
          aria-hidden
        />
        <span data-testid="status-run-state" className="shrink-0">
          {running ? t("chat.statusBar.running") : t("chat.statusBar.idle")}
        </span>
        {stats && tokens ? (
          <span className="ml-auto flex min-w-0 items-center gap-2 tabular-nums">
            <span data-testid="status-tokens" className="whitespace-nowrap">
              {formatTokens(tokens.total)} tok
            </span>
            <span data-testid="status-cost" className="whitespace-nowrap">
              {formatCost(stats.cost)}
            </span>
            <span data-testid="status-detail" className="hidden whitespace-nowrap sm:inline">
              {t("chat.statusBar.detail", {
                input: formatTokens(tokens.input),
                output: formatTokens(tokens.output),
                cache: formatTokens(tokens.cacheRead + tokens.cacheWrite),
              })}
              {stats.context ? t("chat.statusBar.context", { n: Math.round(stats.context.percent) }) : ""}
            </span>
          </span>
        ) : (
          <span className="ml-auto min-w-0 truncate">
            {failed ? t("chat.statusBar.usageFailed") : t("chat.statusBar.usageLoading")}
          </span>
        )}
      </div>
    </div>
  );
}
