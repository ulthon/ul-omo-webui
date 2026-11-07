// 引擎域（engine-ux-visibility 任务 4）：每会话引擎生命周期状态，输入框条件状态条数据源。
// 键 = sessionPath（引擎绑定键，与 GET /api/engines 行、SSE 信封 sessionPath 同口径）。
// 四路信号（全部事件/请求驱动，零轮询）：
//   1. 快照引导：refresh() 调 GET /api/engines（纯读不 spawn），状态条挂载时一次；
//      synced 置位后缺席的键 = 引擎不在管理器内（未拉起/已回收），由组件侧按
//      「已同步 ∧ 缺席 = stopped」派生，store 不预写 stopped。
//   2. engine_state wire 帧（服务端 state_changed 进桥后到达；当前服务端尚未发布，
//      分发层已接线，帧一到即活）：{type:"engine_state", from, to}，信封 sessionPath 定位。
//   3. 存活推导：任何信封带 sessionPath 的引擎 wire 帧 = 该引擎进程在发帧 = ready
//      （分发层逐帧标记）。
//   4. 墓碑对账：engine_permissions_invalidated（引擎死亡/回收/显式停）触发 refresh(true)
//      重取快照——崩溃退避中的引擎行如实带 backoff 状态，快照重取比猜测准。
// 状态条只消费 stopped/starting/backoff 三态文案；ready/stopping/unavailable/未知
// 一律不渲染（宁可少显不误报——unavailable 不再自动重试，展示「自动重试中」即说谎）。
import { create } from "zustand";
import { api } from "@/lib/api";
import { diag } from "@/lib/diag";

/** 引擎生命周期状态（镜像 server/src/engine/process-manager.ts EngineState）。 */
export type EngineLifecycleState = "stopped" | "starting" | "ready" | "stopping" | "backoff" | "unavailable";

/** 合法状态集合（快照行与 wire 帧的 to 字段甄别用，非法值静默忽略）。 */
const KNOWN_STATES: ReadonlySet<string> = new Set([
  "stopped",
  "starting",
  "ready",
  "stopping",
  "backoff",
  "unavailable",
]);

interface EnginesState {
  /** sessionPath → 引擎状态；缺席语义见上方「快照引导」。 */
  states: Record<string, EngineLifecycleState>;
  /** 是否已完成至少一次成功快照同步（未同步时组件不得派生 stopped，一律不显示）。 */
  synced: boolean;
  /** 进行中的快照请求（单飞去重；墓碑对账与挂载引导共用）。 */
  refreshInFlight: Promise<void> | null;

  /**
   * 快照引导 / 对账重取。force=false 且已同步时跳过（挂载引导幂等——Composer 重建
   * 不重打请求；墓碑路径传 force=true 越过跳过门）。单飞：在途请求直接复用。
   * 失败静默（diag.warn）：状态条保持现值，不加错误面（发送路径自会暴露问题）。
   */
  refresh(force?: boolean): Promise<void>;
  /** engine_state wire 帧写入（to 非法值静默忽略，对齐 applyWireEvent 容错口径）。 */
  applyEngineStateEvent(sessionPath: string, to: string): void;
  /** 引擎 wire 帧存活推导：该 sessionPath 引擎在发帧 = ready（同值 no-op 不触发渲染）。 */
  markEngineReady(sessionPath: string): void;
  /** 测试隔离用：整位复位。 */
  resetEngines(): void;
}

export const useEnginesStore = create<EnginesState>()((set, get) => ({
  states: {},
  synced: false,
  refreshInFlight: null,

  refresh: (force = false) => {
    const st = get();
    if (st.refreshInFlight !== null) return st.refreshInFlight;
    if (st.synced && !force) return Promise.resolve();
    const p = (async () => {
      try {
        const r = await api.listEngines();
        const states: Record<string, EngineLifecycleState> = {};
        for (const row of r.engines) {
          if (typeof row.sessionPath === "string" && row.sessionPath !== "" && KNOWN_STATES.has(row.state)) {
            states[row.sessionPath] = row.state as EngineLifecycleState;
          }
        }
        set({ states, synced: true });
      } catch (err) {
        diag.warn("engines", "refresh", { err: err instanceof Error ? err.message : String(err) });
      } finally {
        set({ refreshInFlight: null });
      }
    })();
    set({ refreshInFlight: p });
    return p;
  },

  applyEngineStateEvent: (sessionPath, to) => {
    if (!KNOWN_STATES.has(to)) return;
    if (get().states[sessionPath] === to) return;
    set((s) => ({ states: { ...s.states, [sessionPath]: to as EngineLifecycleState } }));
  },

  markEngineReady: (sessionPath) => {
    if (get().states[sessionPath] === "ready") return;
    set((s) => ({ states: { ...s.states, [sessionPath]: "ready" } }));
  },

  resetEngines: () => {
    set({ states: {}, synced: false, refreshInFlight: null });
  },
}));
