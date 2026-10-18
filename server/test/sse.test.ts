/**
 * SSE 事件桥单测（计划 todo 10）：EventBus 游标/环形缓冲/gap 语义、
 * attachEventBus 装配（mock 进程管理器全流程）、SSE 端点端到端
 * （重连续发不丢不重、游标越界 gap、?session= 过滤、心跳注释行）。
 * 全部走 app.request() 内存流，零真实引擎、零端口。
 */

import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { EventBus, attachEventBus } from "../src/engine/events"
import { SSE_HEARTBEAT_TYPE, sseRoutes, setEventBus } from "../src/api/sse"
import { EngineProcessManager } from "../src/engine/process-manager"
import { FakeRpcClient, MemProbe } from "./mocks"

const PROJ = "/tmp/opencode/w2-sse-test/proj-a"

// ---- SSE 流读取辅助 ----

async function readSseBlocks(
  stream: ReadableStream<Uint8Array>,
  count: number,
  timeoutMs = 2000,
): Promise<string[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  const blocks: string[] = []
  const deadline = Date.now() + timeoutMs
  while (blocks.length < count) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`readSseBlocks 超时：${blocks.length}/${count} 块，残留=${JSON.stringify(pending)}`)
    }
    let timerId: ReturnType<typeof setTimeout> | undefined
    const timer = new Promise<"timeout">((resolve) => {
      timerId = setTimeout(() => resolve("timeout"), remaining)
    })
    const result = await Promise.race([reader.read(), timer])
    clearTimeout(timerId)
    if (result === "timeout") {
      throw new Error(`readSseBlocks 超时：${blocks.length}/${count} 块，残留=${JSON.stringify(pending)}`)
    }
    const { value, done } = result
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = pending.indexOf("\n\n")) !== -1) {
      blocks.push(pending.slice(0, idx))
      pending = pending.slice(idx + 2)
    }
  }
  reader.releaseLock()
  return blocks
}

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

/** 每用例独立 bus + 挂载好的 app（默认心跳 60s，不影响测试时长）。 */
function makeApp(opts: { capacity?: number; heartbeatMs?: number } = {}) {
  const bus = new EventBus({ capacity: opts.capacity })
  setEventBus(bus, { heartbeatMs: opts.heartbeatMs })
  const app = new Hono()
  app.route("/api", sseRoutes)
  return { bus, app }
}

function wireEvent(sessionId: string, seq: number) {
  return { type: "message_update", sessionId, seq } as never
}

// ---- EventBus ----

describe("EventBus", () => {
  test("publish 游标自增且同步扇出", () => {
    const bus = new EventBus()
    const seen: number[] = []
    bus.subscribe((e) => seen.push(e.id))
    bus.publish(PROJ, wireEvent("s1", 1))
    bus.publish(PROJ, wireEvent("s1", 2))
    bus.publish(PROJ, wireEvent("s2", 3))
    expect(seen).toEqual([1, 2, 3])
    expect(bus.latestId).toBe(3)
  })

  test("退订后不再收到事件", () => {
    const bus = new EventBus()
    const seen: number[] = []
    const unsubscribe = bus.subscribe((e) => seen.push(e.id))
    bus.publish(PROJ, wireEvent("s1", 1))
    unsubscribe()
    bus.publish(PROJ, wireEvent("s1", 2))
    expect(seen).toEqual([1])
  })

  test("订阅者抛异常不阻断扇出", () => {
    const bus = new EventBus()
    const seen: number[] = []
    bus.subscribe(() => {
      throw new Error("bad subscriber")
    })
    bus.subscribe((e) => seen.push(e.id))
    bus.publish(PROJ, wireEvent("s1", 1))
    expect(seen).toEqual([1])
  })

  test("环形缓冲淘汰最旧事件（capacity=3）", () => {
    const bus = new EventBus({ capacity: 3 })
    for (let i = 1; i <= 5; i++) bus.publish(PROJ, wireEvent("s1", i))
    expect(bus.size).toBe(3)
    // 缓冲内只剩 id 3,4,5
    expect(bus.replay(2).events.map((e) => e.id)).toEqual([3, 4, 5])
    // 边界内正常续发无 gap
    const r4 = bus.replay(4)
    expect(r4.gap).toBe(false)
    expect(r4.events.map((e) => e.id)).toEqual([5])
  })

  test("replay 游标越界（早于缓冲起点）标记 gap 并从最旧可用续发", () => {
    const bus = new EventBus({ capacity: 3 })
    for (let i = 1; i <= 5; i++) bus.publish(PROJ, wireEvent("s1", i))
    const r = bus.replay(1)
    expect(r.gap).toBe(true)
    expect(r.gapFrom).toBe(2)
    expect(r.gapTo).toBe(2)
    expect(r.events.map((e) => e.id)).toEqual([3, 4, 5])
  })

  test("replay 客户端游标超前（服务端重启归零场景）标记 gap 且无续发", () => {
    const bus = new EventBus()
    bus.publish(PROJ, wireEvent("s1", 1))
    bus.publish(PROJ, wireEvent("s1", 2))
    const r = bus.replay(99)
    expect(r.gap).toBe(true)
    expect(r.gapFrom).toBe(100)
    expect(r.gapTo).toBe(2)
    expect(r.events).toEqual([])
  })

  test("replay 空缓冲：客户端从 0 起步无 gap，持旧 id 则 gap", () => {
    const bus = new EventBus()
    const fresh = bus.replay(0)
    expect(fresh.gap).toBe(false)
    expect(fresh.events).toEqual([])
    const stale = bus.replay(5)
    expect(stale.gap).toBe(true)
    expect(stale.gapFrom).toBe(6)
    expect(stale.gapTo).toBe(0)
  })
})

// ---- attachEventBus 装配 ----

describe("attachEventBus", () => {
  test("进程管理器 engine_event 透传进事件桥（mock 全流程）", async () => {
    const probe = new MemProbe()
    const bus = new EventBus()
    const fakes: FakeRpcClient[] = []
    const manager = new EngineProcessManager({
      registryPath: `/tmp/opencode/w2-sse-test/registry-${Math.random().toString(36).slice(2)}.json`,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 10,
      probe,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        fakes.push(fake)
        probe.add(fake.pid, { cwd: PROJ, argv: ["node", "/fake/cli.js"] })
        return fake
      },
    })
    const detach = attachEventBus(manager, bus)
    await manager.ensureRunning(PROJ)
    fakes[0].emit({ type: "message_update", sessionId: "s1", seq: 1 } as never)
    fakes[0].emit({ type: "agent_end", sessionId: "s1" } as never)
    const replayed = bus.replay(0)
    expect(replayed.events.length).toBe(2)
    expect(replayed.events[0].projectPath).toBe(PROJ)
    expect((replayed.events[0].event as { type: string }).type).toBe("message_update")
    expect((replayed.events[1].event as { type: string }).type).toBe("agent_end")
    detach()
    fakes[0].emit({ type: "message_update", sessionId: "s1", seq: 2 } as never)
    expect(bus.latestId).toBe(2)
    await manager.stop(PROJ)
  })
})

// ---- SSE 端点端到端 ----

describe("GET /api/events", () => {
  test("连接后实时收流：id 行为游标，data 为 {projectPath, event} 包装", async () => {
    const { bus, app } = makeApp()
    const res = await app.request("/api/events")
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/event-stream")
    bus.publish(PROJ, wireEvent("s1", 1))
    bus.publish(PROJ, wireEvent("s2", 2))
    const blocks = await readSseBlocks(res.body!, 2)
    const f1 = parseBlock(blocks[0])
    const f2 = parseBlock(blocks[1])
    expect(f1.event).toBe("message_update")
    expect(f1.id).toBe("1")
    const d1 = JSON.parse(f1.data!)
    expect(d1.projectPath).toBe(PROJ)
    expect(d1.event).toEqual({ type: "message_update", sessionId: "s1", seq: 1 })
    expect(f2.id).toBe("2")
  })

  test("断开重连带 Last-Event-ID：续发断点之后全部事件、无重复", async () => {
    const { bus, app } = makeApp()
    // 第一条连接收 2 条后断开（cancel 模拟客户端断开）
    const res1 = await app.request("/api/events")
    bus.publish(PROJ, wireEvent("s1", 1))
    bus.publish(PROJ, wireEvent("s1", 2))
    const blocks1 = await readSseBlocks(res1.body!, 2)
    expect(blocks1.map((b) => parseBlock(b).id)).toEqual(["1", "2"])
    await res1.body!.cancel()

    // 断开期间又发 2 条（客户端错过 id 3,4）
    bus.publish(PROJ, wireEvent("s1", 3))
    bus.publish(PROJ, wireEvent("s1", 4))

    // 重连带 Last-Event-ID: 2 → 只补 3,4，无 1,2 重复；重放序列被窗口标记包夹
    // （docs08-r5 任务 5：replay_begin/done 桥级帧，id 取重放帧首/末条流水）
    const res2 = await app.request("/api/events", { headers: { "Last-Event-ID": "2" } })
    const blocks2 = await readSseBlocks(res2.body!, 4)
    const fBegin = parseBlock(blocks2[0])
    expect(fBegin.event).toBe("replay_begin")
    expect(fBegin.id).toBe("3")
    expect(JSON.parse(fBegin.data!)).toEqual({ after: 2, buffered: 2 })
    const frames = blocks2.slice(1, 3).map(parseBlock)
    expect(frames.map((f) => f.id)).toEqual(["3", "4"])
    expect(frames.some((f) => f.event === "gap")).toBe(false)
    const fDone = parseBlock(blocks2[3])
    expect(fDone.event).toBe("replay_done")
    expect(fDone.id).toBe("4")
    expect(JSON.parse(fDone.data!)).toEqual({ count: 2 })
  })

  test("游标越界重连：先收 gap 标记再从最旧可用续发", async () => {
    const { bus, app } = makeApp({ capacity: 3 })
    for (let i = 1; i <= 5; i++) bus.publish(PROJ, wireEvent("s1", i))
    // 客户端持 id=1（已被淘汰）重连
    const res = await app.request("/api/events", { headers: { "Last-Event-ID": "1" } })
    // docs08-r5 任务 5：序列为 [gap][replay_begin][3][4][5][replay_done]
    const blocks = await readSseBlocks(res.body!, 6)
    const gap = parseBlock(blocks[0])
    expect(gap.event).toBe("gap")
    expect(JSON.parse(gap.data!)).toEqual({ from: 2, to: 2 })
    expect(gap.id).toBe("5")
    // gap 之后从最旧可用（id 3）续发，首尾被窗口标记包夹
    expect(parseBlock(blocks[1]).event).toBe("replay_begin")
    expect(parseBlock(blocks[1]).id).toBe("3")
    expect(blocks.slice(2, 5).map((b) => parseBlock(b).id)).toEqual(["3", "4", "5"])
    expect(blocks.slice(2, 5).every((b) => parseBlock(b).event === "message_update")).toBe(true)
    expect(parseBlock(blocks[5]).event).toBe("replay_done")
    expect(parseBlock(blocks[5]).id).toBe("5")
  })

  test("无续发内容的 gap（客户端游标超前）：只发 gap 帧以当前游标为基点", async () => {
    const { bus, app } = makeApp()
    bus.publish(PROJ, wireEvent("s1", 1))
    bus.publish(PROJ, wireEvent("s1", 2))
    const res = await app.request("/api/events", { headers: { "Last-Event-ID": "99" } })
    const blocks = await readSseBlocks(res.body!, 1)
    const gap = parseBlock(blocks[0])
    expect(gap.event).toBe("gap")
    expect(JSON.parse(gap.data!)).toEqual({ from: 100, to: 2 })
    expect(gap.id).toBe("2")
  })

  test("?session= 过滤：实时流与 replay 均只发该会话事件", async () => {
    const { bus, app } = makeApp()
    // replay 路径素材：先发混合事件再连接
    bus.publish(PROJ, wireEvent("s1", 1))
    bus.publish(PROJ, wireEvent("s2", 2))
    bus.publish(PROJ, wireEvent("s1", 3))
    const res = await app.request("/api/events?session=s1")
    // replay：1,3（s2 的 2 被滤掉），被窗口标记包夹（标记为连接级帧，不过 ?session= 过滤，
    // 同 gap 口径——窗口界定不依赖会话身份）
    const replayBlocks = await readSseBlocks(res.body!, 4)
    expect(parseBlock(replayBlocks[0]).event).toBe("replay_begin")
    expect(replayBlocks.slice(1, 3).map((b) => parseBlock(b).id)).toEqual(["1", "3"])
    expect(parseBlock(replayBlocks[3]).event).toBe("replay_done")
    // 实时路径：s2 事件不透出
    bus.publish(PROJ, wireEvent("s2", 4))
    bus.publish(PROJ, wireEvent("s1", 5))
    const liveBlock = await readSseBlocks(res.body!, 1)
    expect(parseBlock(liveBlock[0]).id).toBe("5")
  })

  test("心跳：无事件期间按间隔发 event: hb 具名帧（占用 id 流水）", async () => {
    const { bus, app } = makeApp({ heartbeatMs: 50 })
    const res = await app.request("/api/events")
    // 先来一条真实事件占 id=1，随后到达的应为心跳帧 id=2
    bus.publish(PROJ, wireEvent("s1", 1))
    const blocks = await readSseBlocks(res.body!, 2)
    const f1 = parseBlock(blocks[0])
    expect(f1.event).toBe("message_update")
    expect(f1.id).toBe("1")
    const hb = parseBlock(blocks[1])
    expect(hb.event).toBe(SSE_HEARTBEAT_TYPE)
    expect(hb.id).toBe("2")
    const payload = JSON.parse(hb.data!)
    expect(payload.projectPath).toBe("")
    expect(payload.event.type).toBe(SSE_HEARTBEAT_TYPE)
    expect(typeof payload.event.t).toBe("number")
    await res.body!.cancel()
  })

  test("重放把 hb 当普通帧参与 id 序列：Last-Event-ID 续发透传、gap 不因 hb 误报", async () => {
    const { bus, app } = makeApp() // 默认心跳 60s，测试窗口内无自发心跳，手动发布等价帧
    bus.publish(PROJ, wireEvent("s1", 1))
    const res1 = await app.request("/api/events")
    const b1 = await readSseBlocks(res1.body!, 1)
    expect(parseBlock(b1[0]).id).toBe("1")
    await res1.body!.cancel()

    // 断开期间：真实事件(id2) → 心跳(id3) → 真实事件(id4)
    bus.publish(PROJ, wireEvent("s1", 2))
    bus.publish("", { type: SSE_HEARTBEAT_TYPE, t: 0 } as never)
    bus.publish(PROJ, wireEvent("s1", 4))

    // 持 id=2 重连：续发 3(hb), 4，无 gap、hb 正常透传（重放过滤只针对权限请求帧）；
    // 序列被窗口标记包夹（docs08-r5 任务 5）
    const res2 = await app.request("/api/events", { headers: { "Last-Event-ID": "2" } })
    const blocks = await readSseBlocks(res2.body!, 4)
    expect(parseBlock(blocks[0]).event).toBe("replay_begin")
    const f1 = parseBlock(blocks[1])
    expect(f1.event).toBe(SSE_HEARTBEAT_TYPE)
    expect(f1.id).toBe("3")
    expect(parseBlock(blocks[2]).id).toBe("4")
    expect(parseBlock(blocks[3]).event).toBe("replay_done")
    expect(blocks.slice(1, 3).every((b) => parseBlock(b).event !== "gap")).toBe(true)
    await res2.body!.cancel()
  })

  test("?session= 过滤下心跳帧仍到达（看门狗续期依赖 hb，不许被滤掉）", async () => {
    const { app } = makeApp({ heartbeatMs: 50 })
    const res = await app.request(`/api/events?session=${encodeURIComponent("s-none")}`)
    const blocks = await readSseBlocks(res.body!, 1)
    expect(parseBlock(blocks[0]).event).toBe(SSE_HEARTBEAT_TYPE)
    await res.body!.cancel()
  })

  test("非法 Last-Event-ID 按 0 处理（越界走 gap 路径）", async () => {
    const { bus, app } = makeApp({ capacity: 3 })
    for (let i = 1; i <= 5; i++) bus.publish(PROJ, wireEvent("s1", i))
    const res = await app.request("/api/events", { headers: { "Last-Event-ID": "not-a-number" } })
    const blocks = await readSseBlocks(res.body!, 6)
    expect(parseBlock(blocks[0]).event).toBe("gap")
    // 持 0 重连：缺口 [1,2]，从最旧可用 3 续发，窗口标记包夹
    expect(JSON.parse(parseBlock(blocks[0]).data!)).toEqual({ from: 1, to: 2 })
    expect(parseBlock(blocks[1]).event).toBe("replay_begin")
    expect(parseBlock(blocks[1]).id).toBe("3")
    expect(blocks.slice(2, 5).map((b) => parseBlock(b).id)).toEqual(["3", "4", "5"])
    expect(parseBlock(blocks[5]).event).toBe("replay_done")
    expect(parseBlock(blocks[5]).id).toBe("5")
  })
})
