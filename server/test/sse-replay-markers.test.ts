// docs08-r5 任务 5：SSE 重放窗口标记专项单测。重放序列非空时首尾各发一条桥级帧
// replay_begin / replay_done（data 为纯元数据非信封，id 取重放帧首/末条流水），
// 客户端据其界定"单次恢复窗口"，窗口内抑制已落库段的无 id message_start 重播重建。
// 契约要点：空重放不发标记；实时帧恒在 done 之后（连接路径队列顺序保证）；标记为
// 连接级帧不过 ?session= 过滤（同 gap 口径）；Last-Event-ID 单调性与 gap 语义不变。
import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { EventBus } from "../src/engine/events"
import { sseRoutes, setEventBus } from "../src/api/sse"

const PROJ = "/tmp/opencode/docs08-r5-task5/proj-a"

async function readSseBlocks(stream: ReadableStream<Uint8Array>, count: number, timeoutMs = 2000): Promise<string[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  const blocks: string[] = []
  const deadline = Date.now() + timeoutMs
  while (blocks.length < count) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`readSseBlocks 超时：${blocks.length}/${count} 块`)
    let timerId: ReturnType<typeof setTimeout> | undefined
    const timer = new Promise<"timeout">((resolve) => {
      timerId = setTimeout(() => resolve("timeout"), remaining)
    })
    const result = await Promise.race([reader.read(), timer])
    clearTimeout(timerId)
    if (result === "timeout") throw new Error(`readSseBlocks 超时：${blocks.length}/${count} 块`)
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

function parseBlock(block: string): { event?: string; id?: string; data?: string } {
  const out: { event?: string; id?: string; data?: string } = {}
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) out.event = line.slice(7)
    else if (line.startsWith("id: ")) out.id = line.slice(4)
    else if (line.startsWith("data: ")) out.data = line.slice(6)
  }
  return out
}

function makeApp(opts: { engineRunning?: boolean } = {}) {
  const bus = new EventBus({ capacity: 100 })
  setEventBus(bus, {
    heartbeatMs: 60000,
    // 缺省视为运行（生产默认）：重放过滤的陈旧判定 (c) 需要“不在运行”才杀帧
    isEngineRunning: () => opts.engineRunning ?? true,
  })
  const app = new Hono()
  app.route("/api", sseRoutes)
  return { bus, app }
}

function wireEvent(sessionId: string, seq: number) {
  return { type: "message_update", sessionId, seq } as never
}

describe("SSE 重放窗口标记（docs08-r5 任务 5）", () => {
  test("重放序列被 begin/done 包夹：data 元数据正确、id 取重放帧首/末条流水", async () => {
    const { bus, app } = makeApp()
    for (let i = 1; i <= 3; i++) bus.publish(PROJ, wireEvent("s1", i))
    const res = await app.request("/api/events", { headers: { "Last-Event-ID": "0" } })
    const blocks = await readSseBlocks(res.body!, 5)
    const begin = parseBlock(blocks[0])
    expect(begin.event).toBe("replay_begin")
    expect(begin.id).toBe("1")
    expect(JSON.parse(begin.data!)).toEqual({ after: 0, buffered: 3 })
    expect(blocks.slice(1, 4).map((b) => parseBlock(b).id)).toEqual(["1", "2", "3"])
    const done = parseBlock(blocks[4])
    expect(done.event).toBe("replay_done")
    expect(done.id).toBe("3")
    expect(JSON.parse(done.data!)).toEqual({ count: 3 })
    await res.body!.cancel()
  })

  test("实时帧在 done 之后：订阅后发布的帧不进窗口", async () => {
    const { bus, app } = makeApp()
    bus.publish(PROJ, wireEvent("s1", 1))
    const res = await app.request("/api/events", { headers: { "Last-Event-ID": "0" } })
    // 先读完整重放窗口 [begin][1][done]
    const replay = await readSseBlocks(res.body!, 3)
    expect(parseBlock(replay[0]).event).toBe("replay_begin")
    expect(parseBlock(replay[2]).event).toBe("replay_done")
    // 之后发布的是实时帧，不得再出现标记
    bus.publish(PROJ, wireEvent("s1", 2))
    const live = await readSseBlocks(res.body!, 1)
    expect(parseBlock(live[0]).id).toBe("2")
    expect(parseBlock(live[0]).event).toBe("message_update")
    await res.body!.cancel()
  })

  test("空重放（续传位最新）不发标记", async () => {
    const { bus, app } = makeApp()
    bus.publish(PROJ, wireEvent("s1", 1))
    const res = await app.request("/api/events", { headers: { "Last-Event-ID": "1" } })
    bus.publish(PROJ, wireEvent("s1", 2))
    const blocks = await readSseBlocks(res.body!, 1)
    expect(parseBlock(blocks[0]).event).toBe("message_update")
    expect(parseBlock(blocks[0]).id).toBe("2")
    await res.body!.cancel()
  })

  test("标记不过 ?session= 过滤（连接级帧，同 gap 口径）", async () => {
    const { bus, app } = makeApp()
    bus.publish(PROJ, wireEvent("s1", 1))
    bus.publish(PROJ, wireEvent("s2", 2))
    const res = await app.request("/api/events?session=s1")
    // 会话过滤后重放序列只剩帧 1，仍被标记包夹（标记不参与会话过滤）
    const blocks = await readSseBlocks(res.body!, 3)
    expect(parseBlock(blocks[0]).event).toBe("replay_begin")
    expect(parseBlock(blocks[0]).id).toBe("1")
    expect(parseBlock(blocks[1]).id).toBe("1")
    expect(parseBlock(blocks[2]).event).toBe("replay_done")
    await res.body!.cancel()
  })

  test("续传基点在缓冲内（无 gap）：标记 id 取重放帧首/末条，游标全程单调无回退", async () => {
    const { bus, app } = makeApp()
    for (let i = 1; i <= 5; i++) bus.publish(PROJ, wireEvent("s1", i))
    const res = await app.request("/api/events", { headers: { "Last-Event-ID": "1" } })
    const blocks = await readSseBlocks(res.body!, 6)
    expect(parseBlock(blocks[0]).event).toBe("replay_begin")
    expect(parseBlock(blocks[0]).id).toBe("2")
    expect(blocks.slice(1, 5).map((b) => parseBlock(b).id)).toEqual(["2", "3", "4", "5"])
    expect(parseBlock(blocks[5]).event).toBe("replay_done")
    expect(parseBlock(blocks[5]).id).toBe("5")
    // 客户端游标序列 [2,2,3,4,5,5] 全程单调：续传窗口内标记不触发回退重取
    const ids = blocks.map((b) => parseBlock(b).id)
    expect(ids).toEqual(["2", "2", "3", "4", "5", "5"])
    await res.body!.cancel()
  })

  test("gap 与标记共存：序列 [gap][replay_begin][重放帧...][replay_done]（越界场景见 sse.test.ts）", async () => {
    // 容量 3 环形缓冲发 5 条：持 id=1（已淘汰）重连 → gap 后从最旧可用 3 续发
    const bus = new EventBus({ capacity: 3 })
    setEventBus(bus, { heartbeatMs: 60000, isEngineRunning: () => true })
    const app = new Hono()
    app.route("/api", sseRoutes)
    for (let i = 1; i <= 5; i++) bus.publish(PROJ, wireEvent("s1", i))
    const res = await app.request("/api/events", { headers: { "Last-Event-ID": "1" } })
    const blocks = await readSseBlocks(res.body!, 6)
    expect(parseBlock(blocks[0]).event).toBe("gap")
    expect(JSON.parse(parseBlock(blocks[0]).data!)).toEqual({ from: 2, to: 2 })
    expect(parseBlock(blocks[0]).id).toBe("5")
    expect(parseBlock(blocks[1]).event).toBe("replay_begin")
    expect(parseBlock(blocks[1]).id).toBe("3")
    expect(blocks.slice(2, 5).map((b) => parseBlock(b).id)).toEqual(["3", "4", "5"])
    expect(parseBlock(blocks[5]).event).toBe("replay_done")
    // 客户端游标序列 [5(gap),3(begin),3,4,5(帧),5(done)]：仅 gap→begin 一跳回退，
    // 与既有"gap 基点→首个重放帧"行为一致，标记不新增回退点
    const ids = blocks.map((b) => parseBlock(b).id)
    expect(ids).toEqual(["5", "3", "3", "4", "5", "5"])
    await res.body!.cancel()
  })

  test("重放过滤全滤（kept=0）不发包夹标记", async () => {
    // 引擎未运行：唯一缓冲帧是陈旧权限请求（过滤条件 (c) 必杀），重放序列过滤后为空，
    // 不发 begin/done（窗口只包夹实际重放的帧）
    const { bus, app } = makeApp({ engineRunning: false })
    bus.publish(PROJ, { type: "extension_ui_request", sessionId: "s1", method: "confirm", id: "u1", title: "t" } as never)
    const res = await app.request("/api/events", { headers: { "Last-Event-ID": "0" } })
    bus.publish(PROJ, wireEvent("s1", 2))
    const blocks = await readSseBlocks(res.body!, 1)
    expect(parseBlock(blocks[0]).event).toBe("message_update")
    expect(parseBlock(blocks[0]).id).toBe("2")
    await res.body!.cancel()
  })
})
