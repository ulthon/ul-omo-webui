/**
 * GET /api/events —— 每客户端单条多路复用 SSE 流（计划 todo 10）。
 *
 * 硬约束（docs/02「通信」+ 计划 191 行）：HTTP/1.1 下浏览器对同源 SSE 限 6
 * 连接，**禁止按会话开多条流**——全部项目、全部会话的事件在一条流上多路复用，
 * 客户端用 `?session=<sessionId>` 可只收单个会话（服务端过滤）。
 *
 * SSE 契约（W3 todo 14 前端按此解析）：
 *   - event 行 = 引擎 wire 事件 type（如 message_update / agent_end / gap）；
 *   - data 行 = JSON `{projectPath, event}`，event 为 wire 原样对象（sessionId
 *     是会话路由依据，见 engine/events.ts 注释）；
 *   - id 行 = 事件桥全局游标（自增，不侵入 wire 事件体）；
 *   - 断点续传：客户端（原生 EventSource）重连自动带 Last-Event-ID 头，服务端
 *     从游标之后续发，不丢不重；
 *   - 游标越界（早于服务端环形缓冲起点，或服务端重启后客户端游标超前）：
 *     先发一条 `event: gap`（data `{from, to}`，id = 当前续发基点）再从最旧
 *     可用事件续发——客户端收到 gap 必须对活动会话做全量重取（todo 14）；
 *   - 心跳：每 heartbeatMs（默认 15s）写一行注释 `: ping` 保活。
 *
 * 挂载与装配（集成收口者参考，本文件不改 index.ts）：
 *
 *   import { sseRoutes, setEventBus } from "./api/sse"
 *   import { EventBus, attachEventBus } from "./engine/events"
 *
 *   const bus = new EventBus({ capacity: 1000 })
 *   attachEventBus(processManager, bus)  // manager 的 engine_event 透传进桥
 *   setEventBus(bus, { heartbeatMs: 15000 })
 *   app.route("/api", sseRoutes)         // 注册路径 /events，完整路径 /api/events
 *
 * 鉴权：index.ts 已有 `app.use("/api/*", auth.middleware)`（todo 12），sseRoutes
 * 挂到 /api 之下即自动处于密码保护内，未授权请求 401，无需本文件处理；
 * 单测/harness 直接对 sseRoutes.request() 打，天然绕过外层中间件。
 *
 * 连接关闭感知：Bun.serve 下客户端断开会 cancel 响应流，后续 writeSSE/write
 * 抛错——flush 与心跳对写失败做 catch 统一清理（退订 + 停心跳）；onAbort 为
 * hono 内部 abort 路径的兼容挂点。断开后最长一个心跳周期内释放资源。
 */

import { Hono } from "hono"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"
import { EventBus, type BridgeEvent } from "../engine/events"

export const sseRoutes = new Hono()

interface SseOptions {
  /** 心跳间隔毫秒（默认 15s）。 */
  heartbeatMs?: number
}

interface SseRuntime {
  bus: EventBus
  heartbeatMs: number
}

/** EventBus 装配口：集成收口时在进程启动期调用一次（构造参数注入实例）。 */
export function setEventBus(bus: EventBus, options?: SseOptions): void {
  runtime = { bus, heartbeatMs: options?.heartbeatMs ?? 15000 }
}

let runtime: SseRuntime | null = null

/** 每个 SSE 连接独立的待发队列与游标位：慢消费者不影响其他连接，
 * 队列内顺序 = 游标顺序（publish 同步扇出入队；初始 gap/replay 帧先入队，
 * 之后实时帧追加，单 flush 循环按序写出，避免 await 期间事件插队乱序）。 */
interface Connection {
  queue: OutboundFrame[]
  lastSentId: number
  flushing: boolean
  closed: boolean
}

type OutboundFrame =
  | { kind: "gap"; from: number; to: number; id: number }
  | { kind: "event"; event: BridgeEvent }

/** wire 事件的会话字段（routing handle，见 engine/events.ts 头注释）。 */
function wireSessionId(e: BridgeEvent): string | undefined {
  const sessionId = (e.event as { sessionId?: unknown }).sessionId
  return typeof sessionId === "string" ? sessionId : undefined
}

/** wire 事件 type 作为 SSE event 行（客户端按类型路由或收 gap 标记）。 */
function wireType(e: BridgeEvent): string {
  const type = (e.event as { type?: unknown }).type
  return typeof type === "string" && type.length > 0 ? type : "engine_event"
}

async function writeBridgeEvent(stream: SSEStreamingApi, e: BridgeEvent): Promise<void> {
  await stream.writeSSE({
    event: wireType(e),
    data: JSON.stringify({ projectPath: e.projectPath, event: e.event }),
    id: String(e.id),
  })
}

sseRoutes.get("/events", (c) => {
  if (!runtime) {
    return c.json({ error: "event bus not configured: call setEventBus() first" }, 500)
  }
  const { bus, heartbeatMs } = runtime

  // Last-Event-ID：原生 EventSource 重连自动携带；非法值按 0 处理
  //（0 = 从头/从缓冲最旧开始，越界时自然走 gap 路径）
  const raw = c.req.header("Last-Event-ID")
  const parsed = raw === undefined ? 0 : Number.parseInt(raw, 10)
  const afterId = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  const sessionFilter = c.req.query("session")
  const matchesFilter = (e: BridgeEvent): boolean =>
    sessionFilter === undefined || wireSessionId(e) === sessionFilter

  return streamSSE(c, async (stream) => {
    const conn: Connection = { queue: [], lastSentId: afterId, flushing: false, closed: false }
    let cleaned = false
    let unsubscribe: (() => void) | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    // hono streamSSE 语义：cb 返回即关闭响应流。长驻 SSE 必须把 cb 挂在
    // "连接关闭" 的 promise 上，由 cleanup（写失败 / abort）解除挂起。
    let closeResolve: (() => void) | null = null

    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      conn.closed = true
      unsubscribe?.()
      unsubscribe = null
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      closeResolve?.()
      closeResolve = null
    }
    stream.onAbort(cleanup)

    const flush = async (): Promise<void> => {
      if (conn.flushing || conn.closed) return
      conn.flushing = true
      try {
        while (conn.queue.length > 0 && !conn.closed) {
          const frame = conn.queue.shift()
          if (!frame) break
          if (frame.kind === "gap") {
            await stream.writeSSE({
              event: "gap",
              data: JSON.stringify({ from: frame.from, to: frame.to }),
              id: String(frame.id),
            })
          } else {
            await writeBridgeEvent(stream, frame.event)
          }
          conn.lastSentId = frame.kind === "gap" ? frame.id : frame.event.id
        }
      } catch {
        cleanup()
      } finally {
        conn.flushing = false
      }
    }

    // 续传基点：replay 快照与 subscribe 必须在同一同步块内完成（无 await），
    // 否则两个动作之间的 publish 会丢或乱序。replay 快照事件与 subscribe 之后
    // 的实时事件 id 空间不重叠（前者 id 更小），合并不重不丢。
    const replay = bus.replay(afterId)
    unsubscribe = bus.subscribe((e) => {
      if (!matchesFilter(e)) return
      conn.queue.push({ kind: "event", event: e })
      void flush()
    })

    try {
      if (replay.gap) {
        // gap 事件的 id 取续发基点：有续发内容时为其最后一条（同步块内
        // subscribe 尚未收到新事件，即缓冲末条）；无续发内容时为当前游标，
        // 客户端收到后以该基点继续增量听流。
        const gapBaseId = replay.events.length > 0 ? replay.events[replay.events.length - 1].id : bus.latestId
        conn.queue.push({ kind: "gap", from: replay.gapFrom, to: replay.gapTo, id: gapBaseId })
      }
      for (const e of replay.events) {
        if (!matchesFilter(e)) continue
        conn.queue.push({ kind: "event", event: e })
      }
      await flush()

      // 心跳注释行保活（不产生 SSE 事件，客户端不可见）；写失败即断开，清理
      heartbeat = setInterval(() => {
        if (conn.closed) return
        stream.write(": ping\n\n").catch(cleanup)
      }, heartbeatMs)
      heartbeat.unref?.()

      // cb 挂起保持长驻流；cleanup（客户端断开写失败 / abort）时解除，
      // cb 返回后 hono run() 的 finally 才 close 响应。
      await new Promise<void>((resolve) => {
        closeResolve = resolve
      })
    } catch {
      cleanup()
    }
  })
})
