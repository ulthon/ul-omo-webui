// 运行态水合锁（docs08-r5 任务 6）：刷新/会话打开后、该会话首个权威运行态信号到达前，
// 默认按「进行中」悲观阻塞（禁发送、命令直发禁用）。语义裁决（计划定死）：锁定仅限
// 水合窗口——runStates 首次写入（任意态）或 sessions REST 探询带回 active（true/false）
// 即解锁；探询完成仍 unknown（active 持续 null，如引擎不可用）也解锁（宁缺勿错，
// 不得永久锁死，状态点按既有三态显示）；解锁后不回锁，下次刷新/会话打开（组件重挂载）
// 才重置窗口。r4 排队语义不动：已知 running（running/waiting）解锁后照常可输入、发送转排队。
import { useEffect, useState } from "react";
import { useSessionsStore } from "@/stores/sessions";

/** 在 byProject 全项目里找会话行的 active 字段（探询三态：true/false/null；行不存在 = null）。
 * 选择器返回原始值，引用稳定不触发多余重渲染。 */
function pickActive(s: ReturnType<typeof useSessionsStore.getState>, sessionId: string): boolean | null {
  for (const list of Object.values(s.byProject)) {
    const hit = list.find((item) => item.id === sessionId);
    if (hit) return hit.active;
  }
  return null;
}

export function useHydrationRunLock(sessionId: string): { hydrationLocked: boolean; knownRunning: boolean } {
  // 解锁闩（once）：权威信号（runStates 写入 / 探询 active）渲染期即时置位——React 允许
  // 同组件渲染期调整自身 state（立即重渲，不提交）；探询完成置位走异步 finally。
  // 解锁后不回锁，重挂载（刷新/切换会话）才重置。
  const [unlocked, setUnlocked] = useState(false);
  const runState = useSessionsStore((s) => s.runStates[sessionId]);
  const probeActive = useSessionsStore((s) => pickActive(s, sessionId));
  // 权威信号一：runStates 首次写入（任意态）；二：探询带回 active true/false
  if (!unlocked && (runState !== undefined || probeActive !== null)) setUnlocked(true);

  useEffect(() => {
    if (unlocked) return;
    // 显式探询一次（store.refreshSessions 同一端点同一写入口）：完成即视为探询结束——
    // 无论 active 是否拿到（引擎不可用时 null），都不永久锁死。失败已被 store 内部吞掉。
    let cancelled = false;
    void useSessionsStore
      .getState()
      .refreshSessions()
      .finally(() => {
        if (!cancelled) setUnlocked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [unlocked]);

  return {
    hydrationLocked: !unlocked,
    // 已知运行中：SSE 权威链 running/waiting，或未见 SSE 事件时探询 active=true
    // （与 session-item StatusDot 的 runStates > active 权威链同口径）——解锁后排队态可用
    knownRunning:
      runState === "running" || runState === "waiting" || (runState === undefined && probeActive === true),
  };
}
