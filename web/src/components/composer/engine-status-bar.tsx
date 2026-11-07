// 引擎条件状态条（engine-ux-visibility 任务 4）：输入框上方，仅在当前会话引擎非就绪
// 时可见，就绪（及未知/停机中/放弃重试态）即不渲染任何节点。纯展示派生组件——
// 不锁输入、不承载交互（「发送消息将自动拉起」由发送链既有 ensure 语义兑现）。
// 数据四路（见 stores/engines.ts 头注释）：挂载快照引导 + engine_state 帧 + 引擎帧
// 存活推导 + 墓碑对账，零轮询。
// 会话身份 → 引擎键：durable sessionId 自 sessions store byProject 反查行 path
//（与 topbar selectedSession 同型选择器）；行未知 = 无从定位引擎，不显示。
import { useEffect } from "react";
import { useT } from "@/i18n/i18n";
import { useEnginesStore, type EngineLifecycleState } from "@/stores/engines";
import { useSessionsStore } from "@/stores/sessions";

/** 状态条可见态（其余一律 null）：文案键映射。 */
const COPY_KEY: Partial<Record<EngineLifecycleState, "composer.engineStateStopped" | "composer.engineStateStarting" | "composer.engineStateBackoff">> = {
  stopped: "composer.engineStateStopped",
  starting: "composer.engineStateStarting",
  backoff: "composer.engineStateBackoff",
};

export function EngineStatusBar({ sessionId }: { sessionId: string }) {
  // durable id → 会话文件路径（引擎键）。引用稳定：命中即返回行 path 原值。
  const sessionPath = useSessionsStore((s) => {
    for (const list of Object.values(s.byProject)) {
      const hit = list.find((item) => item.id === sessionId);
      if (hit) return hit.path;
    }
    return null;
  });
  // 有效状态：帧/快照值优先；已同步 ∧ 缺席 = 引擎不在管理器内（未拉起/已回收）= stopped；
  // 未同步（快照未到）= 未知 → 不显示（冷启动页不得凭空喊「引擎未启动」）。
  const state = useEnginesStore((s) =>
    sessionPath === null ? undefined : (s.states[sessionPath] ?? (s.synced ? "stopped" : undefined)),
  );

  // 快照引导：挂载一次（refresh 内部 synced 门 + 单飞，Composer 重建不重打）。
  useEffect(() => {
    void useEnginesStore.getState().refresh();
  }, []);

  const t = useT();
  const key = state === undefined ? undefined : COPY_KEY[state];
  if (key === undefined) return null;
  return (
    <div
      data-testid="engine-status-bar"
      data-state={state}
      className="flex items-center gap-1.5 rounded-lg border bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
    >
      <span className="min-w-0 truncate">{t(key)}</span>
    </div>
  );
}
