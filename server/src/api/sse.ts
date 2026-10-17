/**
 * GET /api/events —— 每客户端单条多路复用 SSE 流（计划 todo 10）。
 *
 * 硬约束（docs/02「通信」+ 计划 191 行）：HTTP/1.1 下浏览器对同源 SSE 限 6
 * 连接，**禁止按会话开多条流**——全部项目、全部会话的事件在一条流上多路复用，
 * 客户端用 `?session=<sessionId>` 可只收单个会话（服务端过滤）。
 *
 * SSE 契约（W3 todo 14 前端按此解析）：
 *   - event 行 = 引擎 wire 事件 type（如 message_update / agent_end / gap）；
 *   - data 行 = JSON `{projectPath, event, durableSessionId?}`，event 为 wire 原样
 *     对象（sessionId 是 routing handle，见 engine/events.ts 注释）；
 *     `durableSessionId` 为可选加法字段（todo 9 后续修复）：能映射到磁盘 header id
 *     时由 durableLookup 注入，映射不明时缺席——前端 messages store 以 durable id
 *     为键，路由流式更新时优先取该字段，缺席回退 wire sessionId；
 *   - id 行 = 事件桥全局游标（自增，不侵入 wire 事件体）；
 *   - 断点续传：客户端（原生 EventSource）重连自动带 Last-Event-ID 头，服务端
 *     从游标之后续发，不丢不重；
 *   - 游标越界（早于服务端环形缓冲起点，或服务端重启后客户端游标超前）：
 *     先发一条 `event: gap`（data `{from, to}`，id = 当前续发基点）再从最旧
 *     可用事件续发——客户端收到 gap 必须对活动会话做全量重取（todo 14）；
 *   - 重放过滤（W1 #4）：断线重连的续发序列里，陈旧的 extension_ui_request
 *     权限请求帧被丢弃（三条件：其后无同项目收尾帧 / 无同项目
 *     engine_permissions_invalidated 墓碑 / 项目引擎进程运行中；会话身份经
 *     durableLookup 归一后比对）——旧进程的挂起请求永不会被应答，重放会让
 *     前端输入区永久锁死。实时扇出路径不受影响；
 *   - `?session=` 过滤：wire sessionId（routing handle）或 durableSessionId
 *     任一匹配即放行（durable 匹配是加法兼容：REST 侧只发 durable id）；
 *     心跳 hb 帧无会话身份，无条件放行（被滤掉会让该连接的客户端看门狗失活）；
 *   - 心跳（D18 修复）：每 heartbeatMs（默认 15s，生产装配 8s——Bun 空闲超时实测
 *     ~12s，心跳周期必须小于它）向事件桥发布一条具名 `event: hb` 帧，替代原注释行
 *     `: ping`——EventSource 对注释行不派发事件，客户端停摆看门狗
 *     （web/src/lib/events.ts 滚动续期制）依赖 hb 帧续期。hb 占用 id 流水：与普通
 *     帧同走环形缓冲、重放（透传，重放过滤只针对 extension_ui_request）、
 *     Last-Event-ID 序列与 gap 语义；客户端分发层对无 sessionId 帧游标记账后短路。
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
import { EventBus, ENGINE_PERMISSIONS_INVALIDATED, type BridgeEvent } from "../engine/events"
import { DEBUG_SSE } from "../config"

/** D18 诊断日志（UL_OMO_WEBUI_DEBUG_SSE 开关，默认关）：连接/帧/durableLookup 观测，
 * 关闭时零输出、生产行为零改动。 */
function dlog(line: string): void {
  if (DEBUG_SSE) console.log(`[sse-debug] ${line}`)
}

export const sseRoutes = new Hono()

/** 心跳 wire 事件 type（D18 修复）：具名 `event: hb` 帧替代注释行 `: ping`。
 * EventSource 只对客户端监听列表内的类型派发事件，看门狗续期依赖 hb 可派发。 */
export const SSE_HEARTBEAT_TYPE = "hb"

/** 发布一条全局心跳事件：占用 id 流水（重放透传、Last-Event-ID 序列参与、客户端
 * 游标跟随推进——三处语义核对见计划任务 2）。projectPath 空串 = 全局帧，无
 * sessionId，客户端分发层游标记账后短路返回，不进任何 store。 */
function publishHeartbeat(bus: EventBus): BridgeEvent {
  return bus.publish("", { type: SSE_HEARTBEAT_TYPE, t: Date.now() } as never)
}

interface SseOptions {
  /** 心跳间隔毫秒（默认 15s；生产装配 8s，见头注释）。 */
  heartbeatMs?: number
  /** wire sessionId（routing handle）→ durable id 查询（组合根注入 engine-runtime 的映射）。
   * 返回 undefined 表示映射不明，data 帧不注入 durableSessionId（如实透传）。 */
  durableLookup?: (projectPath: string, handle: string) => string | undefined
  /** 项目引擎进程是否运行中（组合根注入 process-manager 状态，state === "ready"）。
   * 重放过滤条件 (c) 用：不在运行的引擎的挂起权限请求永无法被应答。
   * 缺省视为恒运行（不过滤，保守不误杀）。 */
  isEngineRunning?: (projectPath: string) => boolean
}

interface SseRuntime {
  bus: EventBus
  heartbeatMs: number
  durableLookup: SseOptions["durableLookup"]
  isEngineRunning: SseOptions["isEngineRunning"]
}

/** EventBus 装配口：集成收口时在进程启动期调用一次（构造参数注入实例）。
 * 同时启动全局心跳节拍：publish 进桥后经订阅扇出到全部连接（连接级 interval 退役
 * ——扇出即每连接字节流，Bun 空闲保活职责不变）。重复调用先清旧节拍器。 */
export function setEventBus(bus: EventBus, options?: SseOptions): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  runtime = {
    bus,
    heartbeatMs: options?.heartbeatMs ?? 15000,
    durableLookup: options?.durableLookup,
    isEngineRunning: options?.isEngineRunning,
  }
  heartbeatTimer = setInterval(() => {
    publishHeartbeat(bus)
  }, runtime.heartbeatMs)
  ;(heartbeatTimer as unknown as { unref?: () => void }).unref?.()
}

let runtime: SseRuntime | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

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

/** data 帧载荷：映射可得时注入 durableSessionId（可选加法字段），否则保持原两字段。
 * 诊断开着时输出帧级 durable 命中/miss 观测（miss = 信封不注入 durableSessionId，
 * 前端回退 wire sessionId 建 store 键——键错配嫌疑的直接信号）。 */
function dataPayload(e: BridgeEvent, durableLookup: SseRuntime["durableLookup"]): string {
  const handle = wireSessionId(e)
  const durable = handle !== undefined ? durableLookup?.(e.projectPath, handle) : undefined
  if (DEBUG_SSE) {
    const type = wireType(e)
    if (handle === undefined) {
      dlog(`frame id=${e.id} type=${type} wire=- durable=-`)
    } else if (durable === undefined) {
      dlog(`frame id=${e.id} type=${type} wire=${handle} durable=MISS project=${e.projectPath}`)
    } else {
      dlog(`frame id=${e.id} type=${type} wire=${handle} durable=${durable}`)
    }
  }
  if (durable === undefined) {
    return JSON.stringify({ projectPath: e.projectPath, event: e.event })
  }
  return JSON.stringify({ projectPath: e.projectPath, event: e.event, durableSessionId: durable })
}

/** wire 事件 type 作为 SSE event 行（客户端按类型路由或收 gap 标记）。 */
function wireType(e: BridgeEvent): string {
  const type = (e.event as { type?: unknown }).type
  return typeof type === "string" && type.length > 0 ? type : "engine_event"
}

// ---- 重放过滤（W1 #4：陈旧权限请求复活导致输入区锁死）----

/** 收尾型 wire 事件：回合/会话结束语义（agent_settled 含 watchdog/crashSettle 合成帧）。 */
function isSettleFrame(e: BridgeEvent): boolean {
  const type = (e.event as { type?: unknown }).type
  return type === "agent_end" || type === "agent_settled" || type === "session_closed"
}

function isUiRequestFrame(e: BridgeEvent): boolean {
  return (e.event as { type?: unknown }).type === "extension_ui_request"
}

/** question 型 UI 请求帧（q1 提问卡片；method 区分于四型对话框）。 */
function isQuestionFrame(e: BridgeEvent): boolean {
  const ev = e.event as { type?: unknown; method?: unknown }
  return ev.type === "extension_ui_request" && ev.method === "question"
}

/** 会话身份归一化键（原样比对回退口径用；\n 不出现在路径与 id 里，作分隔安全）。 */
function rawKey(projectPath: string, sessionId: string): string {
  return `${projectPath}\n${sessionId}`
}

/**
 * 重放路径专用过滤：丢弃陈旧的 extension_ui_request 请求帧。请求帧保留当且
 * 仅当以下全过（任一不过即陈旧——旧进程的挂起请求永不会被应答，重放它们会让
 * 前端输入区永久锁死）：
 *   (a) 其后（id 更大）缓冲内没有同项目收尾帧落定其会话（agent_end /
 *       agent_settled 含 synthetic / session_closed）——question 型例外：
 *       waitForAnswer=false 的提问跨回合存活（回合落定后问题仍开着等答案），
 *       settle 不杀它，只有 question_resolved 墓碑才杀；
 *   (b) 其后没有同项目的权限失效墓碑（engine_permissions_invalidated，
 *       崩溃 / 空闲回收 / 显式停止时由组合根发布；引擎重启后提问随之死亡，
 *       ask-user 注册表跨进程不恢复）；
 *   (c) 重放时刻该项目引擎进程在运行（不在运行的引擎应答不了任何请求）；
 *   (d) question 型：其后没有 question_resolved 落定同 id（引擎侧超时/取消/
 *       异端应答的广播帧，id 为全局 uuid 无需会话限定）。
 *
 * 会话身份归一化（Scope 决策 1）：请求帧 sessionId 是 routing handle，合成收尾
 * 帧 sessionId 是 durable id，原样比对在 watchdog 场景永远错配。两侧各自经
 * durableLookup 归一到 durable 空间后比对；任一侧映射不明（lookup 返回
 * undefined）时该对回退原样比对——宁可漏杀（陈旧帧还有 (b)(c) 兜底）不可误杀
 * 在途请求。归一化聚合口径与逐对比对等价：handle === sid 时两侧 lookup 输入
 * 相同、结果必然一致，不会出现「仅原样比对命中而 durable 比对不命中」的帧。
 *
 * 只作用于重放序列（入参 events 升序）：实时扇出路径零改动。断线期间发布的
 * 事件在重连瞬间同样处于缓冲内、经过本过滤；在线客户端的实时帧不存在重放
 * 陈旧帧问题（在线即意味着没断线）。
 */
function filterStaleUiRequests(
  events: BridgeEvent[],
  durableLookup: SseRuntime["durableLookup"],
  engineRunning: (projectPath: string) => boolean,
): BridgeEvent[] {
  // 从尾向前扫：到达请求帧时集合恰为其后缀帧（id 更大）的墓碑项目与收尾会话，
  // 方向性天然成立（收尾/墓碑先于请求 = 已发生的事，不杀请求，见分支 d/e）
  const tombstonedProjects = new Set<string>()
  /** 归一化后的收尾会话 durable id 集合（项目内比对；lookup 命中的帧才入集）。 */
  const settledDurables = new Set<string>()
  /** 原样比对回退口径的收尾会话集合（每帧必入，含 lookup 未命中的）。 */
  const settledRaw = new Set<string>()
  /** question_resolved 落定的请求 id 集合（uuid 全局唯一，无需会话限定）。 */
  const resolvedQuestions = new Set<string>()
  const kept: BridgeEvent[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    const type = (e.event as { type?: unknown }).type
    if (type === ENGINE_PERMISSIONS_INVALIDATED) {
      tombstonedProjects.add(e.projectPath)
      kept.push(e)
      continue
    }
    if (type === "question_resolved") {
      const qid = (e.event as { id?: unknown }).id
      if (typeof qid === "string") resolvedQuestions.add(qid)
      kept.push(e)
      continue
    }
    if (isSettleFrame(e)) {
      const sid = wireSessionId(e)
      if (sid !== undefined) {
        const durable = durableLookup?.(e.projectPath, sid)
        if (durable !== undefined) settledDurables.add(rawKey(e.projectPath, durable))
        settledRaw.add(rawKey(e.projectPath, sid))
      }
      kept.push(e)
      continue
    }
    if (isUiRequestFrame(e)) {
      const handle = wireSessionId(e)
      const reqDurable = handle !== undefined ? durableLookup?.(e.projectPath, handle) : undefined
      const settled =
        handle !== undefined &&
        ((reqDurable !== undefined && settledDurables.has(rawKey(e.projectPath, reqDurable))) ||
          settledRaw.has(rawKey(e.projectPath, handle)))
      if (isQuestionFrame(e)) {
        // waitForAnswer=false 跨回合存活：settle 不杀；只有墓碑/停机/已落定才陈旧
        const waitForAnswer = (e.event as { waitForAnswer?: unknown }).waitForAnswer
        const qid = (e.event as { id?: unknown }).id
        const resolved = typeof qid === "string" && resolvedQuestions.has(qid)
        const stale =
          !engineRunning(e.projectPath) ||
          tombstonedProjects.has(e.projectPath) ||
          resolved ||
          (waitForAnswer !== false && settled)
        if (!stale) kept.push(e)
        continue
      }
      const stale = !engineRunning(e.projectPath) || tombstonedProjects.has(e.projectPath) || settled
      if (!stale) kept.push(e)
      continue
    }
    kept.push(e)
  }
  kept.reverse()
  return kept
}

async function writeBridgeEvent(
  stream: SSEStreamingApi,
  e: BridgeEvent,
  durableLookup: SseRuntime["durableLookup"],
): Promise<void> {
  await stream.writeSSE({
    event: wireType(e),
    data: dataPayload(e, durableLookup),
    id: String(e.id),
  })
}

sseRoutes.get("/events", (c) => {
  if (!runtime) {
    return c.json({ error: "event bus not configured: call setEventBus() first" }, 500)
  }
  const { bus, heartbeatMs, durableLookup, isEngineRunning } = runtime

  // Last-Event-ID：原生 EventSource 重连自动携带；非法值按 0 处理
  //（0 = 从头/从缓冲最旧开始，越界时自然走 gap 路径）
  const raw = c.req.header("Last-Event-ID")
  const parsed = raw === undefined ? 0 : Number.parseInt(raw, 10)
  const afterId = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  const sessionFilter = c.req.query("session")
  const matchesFilter = (e: BridgeEvent): boolean => {
    // 心跳帧无会话身份，无条件放行：被 ?session= 滤掉会让该连接的看门狗失活
    if ((e.event as { type?: unknown }).type === SSE_HEARTBEAT_TYPE) return true
    if (sessionFilter === undefined) return true
    if (wireSessionId(e) === sessionFilter) return true
    // durable id 匹配（加法兼容）：REST 侧只发 durable id，前端用它过滤
    const handle = wireSessionId(e)
    return handle !== undefined && durableLookup?.(e.projectPath, handle) === sessionFilter
  }

  return streamSSE(c, async (stream) => {
    const conn: Connection = { queue: [], lastSentId: afterId, flushing: false, closed: false }
    let cleaned = false
    let unsubscribe: (() => void) | null = null
    // hono streamSSE 语义：cb 返回即关闭响应流。长驻 SSE 必须把 cb 挂在
    // "连接关闭" 的 promise 上，由 cleanup（写失败 / abort）解除挂起。
    let closeResolve: (() => void) | null = null
    dlog(`open afterId=${afterId} filter=${sessionFilter ?? "-"} heartbeatMs=${heartbeatMs}`)

    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      conn.closed = true
      unsubscribe?.()
      unsubscribe = null
      closeResolve?.()
      closeResolve = null
    }
    stream.onAbort(() => {
      dlog(`close reason=client-abort lastSentId=${conn.lastSentId} queue=${conn.queue.length}`)
      cleanup()
    })

    const flush = async (): Promise<void> => {
      if (conn.flushing || conn.closed) return
      // 慢消费者观测（嫌疑 a 旁证：队列停摆/积压会让帧滞留服务端，客户端侧表现为不实时）
      if (conn.queue.length > 100) dlog(`backlog queue=${conn.queue.length} lastSentId=${conn.lastSentId}`)
      conn.flushing = true
      try {
        while (conn.queue.length > 0 && !conn.closed) {
          const frame = conn.queue.shift()
          if (!frame) break
          if (frame.kind === "gap") {
            dlog(`gap frame from=${frame.from} to=${frame.to} id=${frame.id}`)
            await stream.writeSSE({
              event: "gap",
              data: JSON.stringify({ from: frame.from, to: frame.to }),
              id: String(frame.id),
            })
          } else {
            await writeBridgeEvent(stream, frame.event, durableLookup)
          }
          conn.lastSentId = frame.kind === "gap" ? frame.id : frame.event.id
        }
      } catch {
        dlog(`close reason=write-error lastSentId=${conn.lastSentId} queue=${conn.queue.length}`)
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
      // W1 #4：重放序列先滤掉陈旧权限请求帧（三条件 + 会话身份归一化，
      // 见 filterStaleUiRequests）；实时扇出路径不经过此过滤。
      const replayEvents = filterStaleUiRequests(
        replay.events,
        durableLookup,
        isEngineRunning ?? (() => true),
      )
      dlog(
        `replay after=${afterId} buffered=${replay.events.length} kept=${replayEvents.length} gap=${
          replay.gap ? `${replay.gapFrom}->${replay.gapTo}` : "no"
        }`,
      )
      for (const e of replayEvents) {
        if (!matchesFilter(e)) continue
        conn.queue.push({ kind: "event", event: e })
      }
      await flush()

      // 心跳由全局节拍器向事件桥 publish（setEventBus 内），经订阅扇出到本连接：
      // hb 是普通 id 序列帧，写失败同样走 flush 的 catch 统一清理

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
