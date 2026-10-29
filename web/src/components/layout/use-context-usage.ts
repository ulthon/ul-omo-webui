// 水位数据 hook（r10 todo 6 从 context-ring.tsx 抽出）：手机档输入框下方水位细条
// （context-usage-bar.tsx）与状态栏共用同源数据与刷新时机，保证数值永远一致。数据 GET /api/usage 的 contextUsage（toUsageStats 与 status-bar 同源）；
// 刷新时机 = 会话打开 + 生效模型变更 + 回合落定沿（status-bar.tsx:114-121 先例）+
// 压缩等非回合路径的 onUsageRefresh 广播。不做流式跟随动画。
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { usePermissionsStore } from "@/stores/permissions";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { toUsageStats, type UsageStats } from "@/components/chat/status-bar-data";
import { onUsageRefresh } from "@/components/chat/compact-run";

export function useContextUsage(sessionId: string) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const runState = useSessionsStore((s) => s.runStates[sessionId]);
  const streaming = useMessagesStore((s) => s.bySession[sessionId]?.streaming ?? false);
  const hasPendingPermission = usePermissionsStore((s) => (s.bySession[sessionId]?.length ?? 0) > 0);
  // 会话生效模型（docs08-r6 任务 8 ⑤⑥）：SSE model_changed / prompt 回执双路写入；
  // 未知（null，未见回显）时分母不校准（按引擎值）。
  const appliedModel = useSessionsStore((s) => s.appliedModels[sessionId] ?? null);
  const models = useUiStore((s) => s.models);
  const running = streaming || hasPendingPermission;
  // 第四态：后台任务运行中，独立于 running（紫）
  const background = runState === "background_running";

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

  // 压缩等非回合路径的水位刷新广播（docs08-r5 任务 8）：立即重拉，即时反映压缩效果
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

  return { stats, runState, running, background, appliedModel, models };
}
