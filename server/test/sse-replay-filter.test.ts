/**
 * SSE 重放过滤单测（W1 缺陷 #4）：断线重连的续发序列里，陈旧的
 * extension_ui_request 权限请求帧会被三条件过滤丢弃——旧进程的挂起请求永不被
 * 应答，重放它们导致前端输入区永久锁死。
 *
 * 九个分支（计划 todo 2 pin 死，一个场景一个 it）：
 *   (a) 请求后有同会话收尾帧 → 丢弃（含跨会话不误杀的对照）；
 *   (b) 请求后有同项目墓碑 → 丢弃（含跨项目墓碑不误杀的对照）；
 *   (c) 请求 + 无收尾/墓碑 + 引擎运行中 → 重放（在途请求）；
 *   (d) 收尾帧在请求之前 → 请求重放（方向性：先发生的事不杀后发的请求）；
 *   (e) 墓碑方向双向 pin：请求 id < 墓碑 id → 丢弃；请求 id > 墓碑 id → 重放
 *       （重启后的新在途请求，误杀即 #4 镜像锁死）；
 *   (f) 身份归一化：请求带 routing handle，其后合成 agent_settled 带 durable id
 *       （≠handle）→ 归一化后命中 → 丢弃（watchdog 主场景）；
 *   (g) 引擎不在运行 → 该项目权限帧恒丢弃（竞态窗口兜底），非请求帧不受影响；
 *   (h) session_closed 同样算收尾；
 *   (i) restart 链路：干净停止（state_changed to=stopped 墓碑）+ crashSettle
 *       合成收尾 + 重启完成后重放：重启前的权限帧必被丢弃（重启后 handle→durable
 *       映射已被 invalidate 清空，归一化不可用，靠墓碑兜杀）。
 *
 * 全部内存 mock：环形缓冲种子用 bus.publish 直接构造，零真实引擎、零端口。
 */

import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { EventBus, ENGINE_PERMISSIONS_INVALIDATED, publishPermissionsInvalidated } from "../src/engine/events"
import { sseRoutes, setEventBus } from "../src/api/sse"

const PROJ = "/tmp/opencode/w1-replay-filter/proj-a"
const PROJ_B = "/tmp/opencode/w1-replay-filter/proj-b"

// ---- SSE 流读取辅助（重放帧计数确定时按 expect 读，全滤场景按空闲读）----

/** docs08-r5 任务 5：重放窗口信封标记（replay_begin/replay_done）在读取辅助层剥离——
 * 本文件断言焦点是重放过滤语义（哪些请求帧幸存），标记属连接级包夹元数据，
 * 专项断言在 sse-replay-markers.test.ts。 */
const REPLAY_MARKER_EVENTS: ReadonlySet<string> = new Set(["replay_begin", "replay_done"])

interface ParsedFrame {
  comment?: boolean
  event?: string
  id?: string
  data?: string
}

function parseBlock(block: string): ParsedFrame {
  if (block.startsWith(":")) return { comment: true }
  const out: ParsedFrame = {}
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) out.event = line.slice(7)
    else if (line.startsWith("id: ")) out.id = line.slice(4)
    else if (line.startsWith("data: ")) out.data = line.slice(6)
  }
  return out
}

/** 读重放帧：读到 expect 条为止；未给 expect 时读到「连续一个空闲窗无新帧」。
 * 读完 cancel 流（服务端写失败即自行清理）。 */
async function readFrames(
  body: ReadableStream<Uint8Array>,
  opts: { expect?: number; idleMs?: number } = {},
): Promise<ParsedFrame[]> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const idleMs = opts.idleMs ?? 250
  let pending = ""
  const blocks: string[] = []
  /** 收到的全部块数（含被剥离的标记）：进度守卫口径——首块可能只有被剥离的标记，
   * 若按语义块计进展会被误判为无新数据提前退出。 */
  let receivedTotal = 0
  const readChunk = async (): Promise<boolean> => {
    const timer = new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), idleMs))
    const result = await Promise.race([reader.read(), timer])
    if (result === "idle" || result.done) return false
    pending += decoder.decode(result.value, { stream: true })
    let idx: number
    while ((idx = pending.indexOf("\n\n")) !== -1) {
      const block = pending.slice(0, idx)
      pending = pending.slice(idx + 2)
      receivedTotal++
      if (REPLAY_MARKER_EVENTS.has(parseBlock(block).event ?? "")) continue
      blocks.push(block)
    }
    return true
  }
  try {
    let guard = 0
    while (guard++ < 60) {
      const before = receivedTotal
      await readChunk()
      if (opts.expect !== undefined && blocks.length >= opts.expect) break
      if (receivedTotal === before) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return blocks.map(parseBlock)
}

// ---- 场景装配 ----

interface HarnessOptions {
  /** routing handle → durable id 映射（watchdog 归一化口径；缺省空 = lookup 全 miss） */
  durableMap?: Record<string, string>
  /** 已是 durable 形态的 id（runtime knownDurable 直认自身） */
  knownDurable?: string[]
  /** 项目引擎是否运行中（可传函数做动态切换，分支 i 重启完成用） */
  running?: boolean | (() => boolean)
}

/** 每场景独立 bus + 挂载好的 app（心跳 60s 不干扰计时；setEventBus 为模块单例，
 * bun 同文件用例串行执行，逐场景重设即隔离）。 */
function makeHarness(opts: HarnessOptions = {}) {
  const bus = new EventBus({ capacity: 1000 })
  const known = new Set(opts.knownDurable ?? [])
  const map = opts.durableMap ?? {}
  const running = opts.running ?? true
  setEventBus(bus, {
    heartbeatMs: 60000,
    durableLookup: (_projectPath, id) => {
      if (known.has(id)) return id
      return map[id]
    },
    isEngineRunning: typeof running === "function" ? running : () => running,
  })
  const app = new Hono()
  app.route("/api", sseRoutes)
  return { bus, app }
}

/** 按序发布种子帧（id 随游标自增，升序天然成立）。 */
function pub(bus: EventBus, event: Record<string, unknown>, project: string = PROJ): void {
  bus.publish(project, event as never)
}

/** 权限请求帧（四型对话框之一；sessionId 为 routing handle） */
function permRequest(sessionId: string, requestId = "ui-req-1"): Record<string, unknown> {
  return { type: "extension_ui_request", sessionId, method: "confirm", id: requestId, title: "允许执行？" }
}

function agentEnd(sessionId: string): Record<string, unknown> {
  return { type: "agent_end", sessionId }
}

/** watchdog / crashSettle 合成收尾帧（sessionId 为 durable id，见 engine-runtime.ts） */
function syntheticSettled(sessionId: string, reason = "settle_watchdog"): Record<string, unknown> {
  return { type: "agent_settled", synthetic: true, sessionId, reason }
}

function sessionClosed(sessionId: string): Record<string, unknown> {
  return { type: "session_closed", sessionId }
}

function messageUpdate(sessionId: string, seq: number): Record<string, unknown> {
  return { type: "message_update", sessionId, seq }
}

async function replayFrom(bus: EventBus, app: Hono, afterId: string, expectedCount?: number): Promise<ParsedFrame[]> {
  const res = await app.request("/api/events", { headers: { "Last-Event-ID": afterId } })
  expect(res.status).toBe(200)
  return readFrames(res.body!, { expect: expectedCount })
}

// ---- 九分支 ----

describe("SSE 重放过滤（W1 #4 陈旧权限请求）", () => {
  test("(a) 请求后有同会话收尾帧 → 丢弃；跨会话收尾不误杀", async () => {
    const { bus, app } = makeHarness({ durableMap: { "handle-s1": "durable-s1", "handle-s2": "durable-s2" } })
    pub(bus, permRequest("handle-s1", "req-1")) // id 1
    pub(bus, permRequest("handle-s2", "req-2")) // id 2
    pub(bus, agentEnd("handle-s1")) // id 3：落定 s1，与 s2 无关
    // 过滤只针对请求帧：agent_end 本身照常重放
    const frames = await replayFrom(bus, app, "0", 2)
    // s1 的请求被其后的收尾杀掉；s2 的请求与 agent_end 重放
    expect(frames.map((f) => f.id)).toEqual(["2", "3"])
    expect(frames[0].event).toBe("extension_ui_request")
    expect(JSON.parse(frames[0].data!).event.id).toBe("req-2")
  })

  test("(b) 请求后有同项目墓碑 → 丢弃；跨项目墓碑不误杀", async () => {
    const { bus, app } = makeHarness({ running: true })
    pub(bus, permRequest("handle-s1")) // id 1（项目 A）
    pub(bus, permRequest("handle-s1"), PROJ_B) // id 2（项目 B）
    pub(bus, { type: ENGINE_PERMISSIONS_INVALIDATED, projectPath: PROJ }) // id 3：只墓碑项目 A
    // 墓碑帧本身照常透出（前端默认忽略未知类型）
    const frames = await replayFrom(bus, app, "0", 2)
    expect(frames.map((f) => f.id)).toEqual(["2", "3"])
    expect(JSON.parse(frames[0].data!).projectPath).toBe(PROJ_B)
  })

  test("(c) 请求 + 无收尾/墓碑 + 引擎运行中 → 重放（在途请求）", async () => {
    const { bus, app } = makeHarness({ running: true })
    pub(bus, messageUpdate("handle-s1", 1)) // id 1：普通帧照常重放
    pub(bus, permRequest("handle-s1")) // id 2
    const frames = await replayFrom(bus, app, "0", 2)
    expect(frames.map((f) => f.id)).toEqual(["1", "2"])
    // 请求帧载荷原样透传（过滤只做取舍，不改写）
    const data = JSON.parse(frames[1].data!)
    expect(data.projectPath).toBe(PROJ)
    expect(data.event).toEqual(permRequest("handle-s1"))
  })

  test("(d) 收尾帧在请求之前 → 请求重放（方向性：先发生的不杀后发的）", async () => {
    const { bus, app } = makeHarness({ durableMap: { "handle-s1": "durable-s1" }, running: true })
    pub(bus, agentEnd("handle-s1")) // id 1：上一回合收尾
    pub(bus, permRequest("handle-s1", "req-new")) // id 2：新回合的权限请求，在途
    const frames = await replayFrom(bus, app, "0", 2)
    expect(frames.map((f) => f.id)).toEqual(["1", "2"])
    expect(frames[1].event).toBe("extension_ui_request")
    expect(JSON.parse(frames[1].data!).event.id).toBe("req-new")
  })

  test("(e) 墓碑方向双向 pin：请求早于墓碑丢弃，请求晚于墓碑重放", async () => {
    // e1：请求 id < 墓碑 id —— 重启前发出的请求已死，丢弃（墓碑帧本身照常透出）
    {
      const { bus, app } = makeHarness({ running: true })
      pub(bus, permRequest("handle-old", "req-old")) // id 1
      publishPermissionsInvalidated(bus, PROJ) // id 2
      const frames = await replayFrom(bus, app, "0", 1)
      expect(frames).toHaveLength(1)
      expect(frames[0].id).toBe("2")
      expect(frames[0].event).toBe(ENGINE_PERMISSIONS_INVALIDATED)
    }
    // e2：请求 id > 墓碑 id —— 重启后的新在途请求，误杀即 #4 镜像锁死
    {
      const { bus, app } = makeHarness({ running: true })
      publishPermissionsInvalidated(bus, PROJ) // id 1（旧进程停止时发布）
      pub(bus, permRequest("handle-new", "req-new")) // id 2（新进程在途）
      const frames = await replayFrom(bus, app, "0", 2)
      expect(frames.map((f) => f.id)).toEqual(["1", "2"])
      expect(frames[1].event).toBe("extension_ui_request")
      expect(JSON.parse(frames[1].data!).event.id).toBe("req-new")
    }
  })

  test("(f) 身份归一化：handle 请求 + durable 合成收尾 → 归一后命中丢弃（watchdog 主场景）", async () => {
    // wire 帧的 sessionId 是 routing handle，合成 agent_settled 的 sessionId 是
    // durable id：原样比对永远错配，必须经 durableLookup 归一到 durable 空间。
    // knownDurable = durable 形态直认自身（engine-runtime durableSessionIdFor 语义）
    const { bus, app } = makeHarness({
      durableMap: { "handle-s1": "durable-s1" },
      knownDurable: ["durable-s1"],
      running: true,
    })
    pub(bus, permRequest("handle-s1", "req-1")) // id 1：routing handle
    pub(bus, syntheticSettled("durable-s1")) // id 2：durable id（≠handle）
    const frames = await replayFrom(bus, app, "0", 1)
    // 请求被杀，合成收尾帧本身照常重放
    expect(frames).toHaveLength(1)
    expect(frames[0].event).toBe("agent_settled")
    expect(frames[0].id).toBe("2")
  })

  test("(g) 引擎不在运行 → 该项目权限帧恒丢弃；非请求帧不受影响", async () => {
    const { bus, app } = makeHarness({ running: false })
    pub(bus, messageUpdate("handle-s1", 1)) // id 1
    pub(bus, permRequest("handle-s1")) // id 2：引擎停着，无人能应答
    const frames = await replayFrom(bus, app, "0", 1)
    expect(frames.map((f) => f.id)).toEqual(["1"])
    expect(frames[0].event).toBe("message_update")
  })

  test("(h) session_closed 同样算收尾", async () => {
    const { bus, app } = makeHarness({ durableMap: { "handle-s1": "durable-s1" }, running: true })
    pub(bus, permRequest("handle-s1")) // id 1
    pub(bus, sessionClosed("handle-s1")) // id 2
    const frames = await replayFrom(bus, app, "0", 1)
    expect(frames).toHaveLength(1)
    expect(frames[0].id).toBe("2")
    expect(frames[0].event).toBe("session_closed")
  })

  test("(i) restart 链路：干净停止墓碑 + crashSettle 合成收尾后，重启前请求必被丢弃", async () => {
    // 重启后 handle→durable 映射已被 invalidate 清空（lookup 全 miss），合成收尾
    // 的 durable id 与请求 handle 原样比对不命中——此时靠 state_changed(to=stopped)
    // 墓碑兜杀，验证 (b) 对归一化不可用场景的兜底闭环
    let running = true
    const { bus, app } = makeHarness({ running: () => running })
    pub(bus, permRequest("handle-s1", "req-pre")) // id 1：重启前的挂起请求
    // —— 重启序列（对应 index.ts 墓碑订阅 + restartProject 的 crashSettle）——
    running = false
    publishPermissionsInvalidated(bus, PROJ) // id 2：state_changed(to=stopped) 墓碑
    pub(bus, syntheticSettled("durable-s1", "engine_crash")) // id 3：crashSettle 合成收尾
    running = true // ensureRunning 完成，新进程 ready
    const frames = await replayFrom(bus, app, "0", 2)
    // 重启前的权限帧必不在；墓碑与合成收尾帧照常透出
    expect(frames.map((f) => f.event)).toEqual([ENGINE_PERMISSIONS_INVALIDATED, "agent_settled"])
    // 墓碑 wire 形态稳定：data.event = { type, projectPath }，信封 projectPath 同值
    const tombstone = JSON.parse(frames[0].data!)
    expect(tombstone.projectPath).toBe(PROJ)
    expect(tombstone.event).toEqual({ type: ENGINE_PERMISSIONS_INVALIDATED, projectPath: PROJ })
  })
})

// ---- q1 提问卡片：question 帧语义（waitForAnswer=false 跨回合存活）----

/** question 型请求帧（waitForAnswer 语义与四型对话框不同） */
function questionFrame(sessionId: string, id: string, waitForAnswer: boolean): Record<string, unknown> {
  return {
    type: "extension_ui_request",
    sessionId,
    method: "question",
    id,
    waitForAnswer,
    questions: [{ id: "q1", header: "Deploy", question: "环境?", options: [{ label: "staging" }], multiSelect: false }],
    timeout: 1800000,
    deadlineAtMs: Date.now() + 1800000,
  }
}

function questionResolved(id: string, outcome = "answered"): Record<string, unknown> {
  return { type: "question_resolved", sessionId: "handle-s1", id, outcome }
}

describe("SSE 重放过滤（q1 question 帧）", () => {
  test("(q-a) waitForAnswer=true + 其后收尾帧 → 丢弃（阻塞型与四型同规则）", async () => {
    const { bus, app } = makeHarness({ running: true })
    pub(bus, questionFrame("handle-s1", "q-1", true)) // id 1
    pub(bus, agentEnd("handle-s1")) // id 2：回合落定（阻塞型问题必已落定）
    const frames = await replayFrom(bus, app, "0", 1)
    expect(frames.map((f) => f.id)).toEqual(["2"])
    expect(frames[0].event).toBe("agent_end")
  })

  test("(q-b) waitForAnswer=false + 其后收尾帧 → 重放（跨回合存活，settle 不杀）", async () => {
    const { bus, app } = makeHarness({ running: true })
    pub(bus, questionFrame("handle-s1", "q-2", false)) // id 1
    pub(bus, agentEnd("handle-s1")) // id 2：回合落定但问题仍开着
    const frames = await replayFrom(bus, app, "0", 2)
    expect(frames.map((f) => f.event)).toEqual(["extension_ui_request", "agent_end"])
    expect(JSON.parse(frames[0].data!).event.id).toBe("q-2")
    expect(JSON.parse(frames[0].data!).event.waitForAnswer).toBe(false)
  })

  test("(q-c) waitForAnswer=false + 其后 question_resolved → 丢弃（真墓碑）", async () => {
    const { bus, app } = makeHarness({ running: true })
    pub(bus, questionFrame("handle-s1", "q-3", false)) // id 1
    pub(bus, questionResolved("q-3", "timed_out")) // id 2：引擎侧超时落定
    const frames = await replayFrom(bus, app, "0", 1)
    expect(frames.map((f) => f.event)).toEqual(["question_resolved"])
    expect(JSON.parse(frames[0].data!).event.id).toBe("q-3")
  })

  test("(q-d) question_resolved 墓碑不误杀其他在途问题（按 id 定向）", async () => {
    const { bus, app } = makeHarness({ running: true })
    pub(bus, questionFrame("handle-s1", "q-4", false)) // id 1
    pub(bus, questionFrame("handle-s1", "q-5", true)) // id 2
    pub(bus, questionResolved("q-4", "cancelled")) // id 3：只落定 q-4
    const frames = await replayFrom(bus, app, "0", 2)
    expect(frames.map((f) => f.event)).toEqual(["extension_ui_request", "question_resolved"])
    expect(JSON.parse(frames[0].data!).event.id).toBe("q-5")
  })

  test("(q-e) 引擎不在运行 → question 帧恒丢弃（含 waitForAnswer=false）", async () => {
    const { bus, app } = makeHarness({ running: false })
    pub(bus, questionFrame("handle-s1", "q-6", false)) // id 1
    pub(bus, messageUpdate("handle-s1", 1)) // id 2：普通帧不受影响
    const frames = await replayFrom(bus, app, "0", 1)
    expect(frames.map((f) => f.id)).toEqual(["2"])
  })

  test("(q-f) question_updated 照常透传（截止刷新，无过滤语义）", async () => {
    const { bus, app } = makeHarness({ running: true })
    pub(bus, questionFrame("handle-s1", "q-7", false)) // id 1
    pub(bus, { type: "question_updated", sessionId: "handle-s1", id: "q-7", deadlineAtMs: 2, remainingMs: 1 }) // id 2
    const frames = await replayFrom(bus, app, "0", 2)
    expect(frames.map((f) => f.event)).toEqual(["extension_ui_request", "question_updated"])
  })

  test("(q-g) waitForAnswer=false + 墓碑（引擎重启）→ 丢弃（提问随进程死亡）", async () => {
    const { bus, app } = makeHarness({ running: true })
    pub(bus, questionFrame("handle-s1", "q-8", false)) // id 1
    pub(bus, { type: ENGINE_PERMISSIONS_INVALIDATED, projectPath: PROJ }) // id 2
    const frames = await replayFrom(bus, app, "0", 1)
    expect(frames.map((f) => f.event)).toEqual([ENGINE_PERMISSIONS_INVALIDATED])
  })
})
