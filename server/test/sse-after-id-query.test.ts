// webui-refetch-storm 任务 4（GAP-6）服务端半场：?afterId= 查询参数解析与非首连分类。
// 契约（与 web/src/lib/events.ts 引导重连配套）：
//   - ?afterId= 对 afterId 推导与 Last-Event-ID header 等价（优先级 header > query）；
//   - 携 query 游标的连接恒为非首连（isFreshConnect=false）：不做新连接回放尾窗截断
//     ——否则尾窗把带游标重连伪装成首连、长缺被截窗掩盖，重载仍走大缺口全量对账，
//     前端游标持久化收益归零（敌对用例 (b) 专门钉死）；
//   - 空 query 值（?afterId=）视为缺席：无游标首连的原有尾窗行为不变；
//   - 非法 query 值按 0 处理且仍非首连（与 header 非法值语义一致）；
//   - Last-Event-ID header 语义完全不变（回归锚）。
import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { EventBus } from "../src/engine/events"
import { sseRoutes, setEventBus, REPLAY_TAIL_WINDOW } from "../src/api/sse"

const PROJ = "/tmp/opencode/webui-refetch-storm-t4/proj-a"
const N = REPLAY_TAIL_WINDOW

async function readSseBlocks(
  stream: ReadableStream<Uint8Array>,
  count: number,
  timeoutMs = 5000,
): Promise<string[]> {
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

interface SseBlock {
  event?: string
  id?: string
  data?: string
}

function parseBlock(block: string): SseBlock {
  const out: SseBlock = {}
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) out.event = line.slice(7)
    else if (line.startsWith("id: ")) out.id = line.slice(4)
    else if (line.startsWith("data: ")) out.data = line.slice(6)
  }
  return out
}

function makeApp(capacity = 1000) {
  const bus = new EventBus({ capacity })
  setEventBus(bus, { heartbeatMs: 60000, isEngineRunning: () => true })
  const app = new Hono()
  app.route("/api", sseRoutes)
  return { bus, app }
}

function entryAppended(sessionId: string, entryId: number) {
  return {
    type: "entry_appended",
    sessionId,
    entry: { id: entryId, type: "message" },
  } as never
}

describe("SSE ?afterId= 查询参数（任务 4）", () => {
  test("(a) 中位续传：?afterId=20 于 250 帧历史 → 从 21 起全量回放，无尾窗截断、无 gap", async () => {
    const { bus, app } = makeApp()
    for (let i = 1; i <= 250; i++) bus.publish(PROJ, entryAppended("s1", i))

    const res = await app.request("/api/events?afterId=20")
    // begin + 230 帧 + done（无 gap）
    const blocks = await readSseBlocks(res.body!, 232)
    await res.body!.cancel()
    const frames = blocks.map(parseBlock)
    expect(frames.some((f) => f.event === "gap")).toBe(false)
    expect(frames[0].event).toBe("replay_begin")
    expect(frames[frames.length - 1].event).toBe("replay_done")
    const replayed = frames.slice(1, -1)
    expect(replayed.length).toBe(230)
    // 续传基点：首帧 id = afterId + 1，末帧 = 缓冲末条
    expect(replayed[0].id).toBe("21")
    expect(replayed[replayed.length - 1].id).toBe(String(bus.latestId))
    // id 严格递增
    const ids = replayed.map((f) => Number(f.id))
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1])
  })

  test("(b) 敌对：?afterId=0（>200 帧断线、环缓冲完整）→ 纯回放全量、零 gap 帧——钉死 query 游标非首连", async () => {
    const { bus, app } = makeApp()
    for (let i = 1; i <= 250; i++) bus.publish(PROJ, entryAppended("s1", i))
    const total = bus.latestId
    expect(total).toBeGreaterThan(N) // 缺口 250 帧 > 尾窗 200

    const res = await app.request("/api/events?afterId=0")
    const blocks = await readSseBlocks(res.body!, total + 2)
    await res.body!.cancel()
    const frames = blocks.map(parseBlock)
    // 若 query 游标被误判为首连：尾窗截断 → 只回放 N 帧且首块为 gap。两者都不允许出现
    expect(frames.some((f) => f.event === "gap")).toBe(false)
    expect(frames[0].event).toBe("replay_begin")
    const replayed = frames.slice(1, -1)
    expect(replayed.length).toBe(total)
    expect(replayed[0].id).toBe("1")
  })

  test("(c) header 优先于 query：Last-Event-ID: 50 + ?afterId=100 → 从 51 起回放", async () => {
    const { bus, app } = makeApp()
    for (let i = 1; i <= 250; i++) bus.publish(PROJ, entryAppended("s1", i))
    const total = bus.latestId

    const res = await app.request("/api/events?afterId=100", { headers: { "Last-Event-ID": "50" } })
    const blocks = await readSseBlocks(res.body!, total - 50 + 2)
    await res.body!.cancel()
    const frames = blocks.map(parseBlock)
    expect(frames.some((f) => f.event === "gap")).toBe(false)
    const replayed = frames.slice(1, -1)
    expect(replayed.length).toBe(total - 50)
    expect(replayed[0].id).toBe("51")
  })

  test("(d) 空 query 值视为缺席：?afterId= → 无游标首连尾窗行为（gap + ≤N 帧）", async () => {
    const { bus, app } = makeApp()
    for (let i = 1; i <= 250; i++) bus.publish(PROJ, entryAppended("s1", i))

    const res = await app.request("/api/events?afterId=")
    const blocks = await readSseBlocks(res.body!, N + 3)
    await res.body!.cancel()
    const frames = blocks.map(parseBlock)
    const gap = frames[0]
    expect(gap.event).toBe("gap")
    const gapData = JSON.parse(gap.data!)
    expect(gapData.from).toBe(1)
    const replayed = frames.slice(2, -1)
    expect(replayed.length).toBeLessThanOrEqual(N)
    expect(replayed[0].id).toBe(String(gapData.to + 1))
  })

  test("(e) 非法 query 值：?afterId=abc → 按 0 且非首连（全量回放、无 gap，与 header 非法值语义一致）", async () => {
    const { bus, app } = makeApp()
    for (let i = 1; i <= 250; i++) bus.publish(PROJ, entryAppended("s1", i))
    const total = bus.latestId

    const res = await app.request("/api/events?afterId=abc")
    const blocks = await readSseBlocks(res.body!, total + 2)
    await res.body!.cancel()
    const frames = blocks.map(parseBlock)
    expect(frames.some((f) => f.event === "gap")).toBe(false)
    expect(frames.slice(1, -1).length).toBe(total)
    expect(frames[1].id).toBe("1")
  })

  test("(f) 回归锚：无 header 无 query → 首连尾窗行为不变（gap + ≤N 帧）", async () => {
    const { bus, app } = makeApp()
    for (let i = 1; i <= 250; i++) bus.publish(PROJ, entryAppended("s1", i))

    const res = await app.request("/api/events")
    const blocks = await readSseBlocks(res.body!, N + 3)
    await res.body!.cancel()
    const frames = blocks.map(parseBlock)
    expect(frames[0].event).toBe("gap")
    const replayed = frames.slice(2, -1)
    expect(replayed.length).toBeLessThanOrEqual(N)
    expect(replayed.length).toBe(N)
    expect(frames[frames.length - 1].event).toBe("replay_done")
  })

  test("(g) 回归锚：Last-Event-ID header 行为完全不变（带头中位续传不走尾窗）", async () => {
    const { bus, app } = makeApp()
    for (let i = 1; i <= 250; i++) bus.publish(PROJ, entryAppended("s1", i))
    const total = bus.latestId

    const res = await app.request("/api/events", { headers: { "Last-Event-ID": "100" } })
    const blocks = await readSseBlocks(res.body!, total - 100 + 2)
    await res.body!.cancel()
    const frames = blocks.map(parseBlock)
    expect(frames.some((f) => f.event === "gap")).toBe(false)
    const replayed = frames.slice(1, -1)
    expect(replayed.length).toBe(total - 100)
    expect(replayed[0].id).toBe("101")
  })
})
