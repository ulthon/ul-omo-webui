/**
 * SSE 事件桥的汇聚层（计划 todo 10）。
 *
 * 职责：把所有项目引擎子进程的 wire 事件汇聚到一条全局事件流上——全局自增
 * 游标（跨项目单调递增）、环形缓冲（断线重连续发）、订阅扇出（在线推送）。
 * SSE 端点（server/src/api/sse.ts）是它唯一的消费者形态：每客户端单条多路
 * 复用流（HTTP/1.1 同源 SSE 浏览器限 6 连接，禁止按会话开多条）。
 *
 * 装配方法（集成收口者参考，本文件不改 index.ts / process-manager.ts）：
 *
 *   import { EngineProcessManager } from "./engine/process-manager"
 *   import { EventBus, attachEventBus } from "./engine/events"
 *
 *   const manager = new EngineProcessManager({ ... })
 *   const bus = new EventBus({ capacity: 1000 })
 *   const detach = attachEventBus(manager, bus)  // manager 的 engine_event 透传进桥
 *   setEventBus(bus)                             // 见 api/sse.ts
 *
 * 进程管理器事件订阅面（todo 8）只消费 `engine_event`（wire 原样 + projectPath）；
 * 管理器自身的 state_changed / process_crashed / engine_unavailable /
 * engine_reclaimed 是管理器状态机事件，暂不进桥——前端需要"项目引擎不可用"
 * 提示时再扩展 attachEventBus，不在本 todo 范围。
 *
 * wire 透传约束（docs/verification/01 实证）：multi-session 模式下 wire 事件的
 * sessionId 是会话身份（磁盘 jsonl header id），是事件按会话路由的依据；
 * `?session=` 过滤与前端按 session 分发都吃这个字段。管理器内部 holder UUID
 * 不是会话身份，不进事件桥。
 */

import type { EngineProcessManager, RpcClientEvent } from "./process-manager"
import { log } from "../obs/logger"

/** 事件桥内部事件形态：wire 原样 + 汇聚元数据。 */
export interface BridgeEvent {
  /** 全局自增游标（跨项目单调递增）。SSE 传输时走 id 行，不侵入 wire 事件体。 */
  id: number
  /** 事件来源项目（引擎子进程 cwd）。SSE data 包装层透出，前端多项目路由用。 */
  projectPath: string
  /** 引擎 wire 事件原样透传，事件桥不改写。 */
  event: RpcClientEvent
}

export interface EventBusOptions {
  /** 环形缓冲容量（默认 1000，计划下限）。超出后淘汰最旧事件。 */
  capacity?: number
}

export interface ReplayResult {
  /** true = 客户端游标与缓冲之间有缺口，客户端必须全量重取活动会话。 */
  gap: boolean
  /** 缺口起点（客户端缺失的第一个游标）；无缺口时为 0。 */
  gapFrom: number
  /** 缺口终点（缓冲最旧可用事件的前一个游标）；无缺口时为 0。 */
  gapTo: number
  /** 缓冲内 afterId 之后的事件（id 升序）；越界时即"从最旧可用续发"。 */
  events: BridgeEvent[]
}

type EventListener = (event: BridgeEvent) => void

export class EventBus {
  private readonly capacity: number
  /** 环形缓冲（数组实现：尾部入、超容量裁头，容量 ≤1000 级别无性能问题）。 */
  private buffer: BridgeEvent[] = []
  /** 全局游标：已发出的最大事件 id，从 0 起单调递增，永不回退。 */
  private cursor = 0
  private readonly listeners = new Set<EventListener>()

  constructor(options: EventBusOptions = {}) {
    this.capacity = Math.max(options.capacity ?? 1000, 1)
  }

  /** 缓冲内事件数。 */
  get size(): number {
    return this.buffer.length
  }

  /** 最新的全局游标（从未发布过事件时为 0）。 */
  get latestId(): number {
    return this.cursor
  }

  /**
   * 发布事件：游标自增 → 进环形缓冲（超容量裁最旧）→ 同步扇出给全部订阅者。
   * 单线程同步扇出保证了各订阅者队列内的事件顺序与游标顺序一致。
   * 订阅者抛异常只吞掉该次回调，不阻断其他订阅者。
   */
  publish(projectPath: string, event: RpcClientEvent): BridgeEvent {
    this.cursor += 1
    const bridge: BridgeEvent = { id: this.cursor, projectPath, event }
    // 采集增强批：帧级观测（debug 级，默认零输出）；debug 门控先行省字段构造
    if (log.isDebugEnabled()) {
      const rawType = (event as { type?: unknown }).type
      const rawSession = (event as { sessionId?: unknown }).sessionId
      log.debug("bridge", "frame", {
        id: bridge.id,
        type: typeof rawType === "string" ? rawType : undefined,
        proj: projectPath,
        session: typeof rawSession === "string" ? rawSession.slice(0, 16) : undefined,
      })
    }
    this.buffer.push(bridge)
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity)
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(bridge)
      } catch {
        // 订阅者异常不阻断扇出
      }
    }
    return bridge
  }

  /** 订阅实时事件（同步回调）。返回退订函数。 */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 重连续发查询：客户端持有 Last-Event-ID = afterId，需要 afterId 之后的事件。
   *
   * 语义：
   *   - afterId + 1 落在缓冲覆盖范围内（或缓冲尚无历史）→ 正常续发，无 gap；
   *   - afterId 早于缓冲起点（游标越界，缺的事件已被淘汰）→ gap = true，
   *     缺口区间 [afterId + 1, oldest - 1]，events = 缓冲现存全部（从最旧可用续发）；
   *   - afterId > 最新游标（典型于服务端重启游标归零而客户端持旧大 id）→
   *     gap = true 且 events 为空，客户端按 gap 全量重取后以服务端游标为基点续听。
   */
  replay(afterId: number): ReplayResult {
    const events = this.buffer.filter((e) => e.id > afterId)
    // 客户端游标超前于服务端：服务端无任何可续内容，标记缺口
    if (afterId > this.cursor) {
      return { gap: true, gapFrom: afterId + 1, gapTo: this.cursor, events: [] }
    }
    const oldest = this.buffer.length > 0 ? this.buffer[0].id : null
    if (oldest !== null && afterId + 1 < oldest) {
      return { gap: true, gapFrom: afterId + 1, gapTo: oldest - 1, events }
    }
    return { gap: false, gapFrom: 0, gapTo: 0, events }
  }
}

/**
 * 权限失效墓碑（W1 #4）：项目引擎进程崩溃 / 空闲回收 / 显式停止后发布一次。
 * 重放过滤（api/sse.ts）据此丢弃「早于本墓碑的 extension_ui_request」——旧进程
 * 的挂起权限请求永不会被任何进程应答，重放它们会导致前端输入区永久锁死。
 * wire 形态稳定为 `{ type, projectPath }`（todo 13 前端 applyWireEvent 对未知
 * 类型默认忽略，实时流多出该帧无副作用）。
 */
export const ENGINE_PERMISSIONS_INVALIDATED = "engine_permissions_invalidated"

/** 发布一条项目引擎权限失效墓碑（幂等：重放过滤按「其后存在墓碑」判定，重复发布无害）。 */
export function publishPermissionsInvalidated(bus: EventBus, projectPath: string): BridgeEvent {
  return bus.publish(projectPath, { type: ENGINE_PERMISSIONS_INVALIDATED, projectPath } as never)
}

/**
 * 把进程管理器的 engine_event 透传接进事件桥（装配口）。
 * 返回退订函数（server 关停时调用）。
 */
export function attachEventBus(manager: EngineProcessManager, bus: EventBus): () => void {
  return manager.onEvent((e) => {
    if (e.type === "engine_event") {
      bus.publish(e.projectPath, e.event)
    }
  })
}
