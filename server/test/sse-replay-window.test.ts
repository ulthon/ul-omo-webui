// docs08-2026-10-23/24 批次任务 8：SSE 新连接回放窗口收敛专项测试。
// 契约（任务 3 设计文档定稿）：无 Last-Event-ID 的新连接不再 replay(0) 全量
// 环形缓冲，只回放最近 REPLAY_TAIL_WINDOW=200 帧（message_update 流式中间帧
// 跳过、每会话留末帧快照）；越窗截断发 gap 帧（复用现语义，客户端缺帧走
// 对账补齐）；带 Last-Event-ID 的连接行为完全不变；replay_begin/done 标记与
// Last-Event-ID 单调性不变；filterStaleUiRequests 墓碑过滤不动。
// 联合验收（与任务 9 客户端增量补齐的接缝）：客户端未收到的帧恰为连续区间
// [1, windowStart-1]，与 REST 尾窗 / ?before= 后向翻页边界帧对齐（确定性接缝）。
import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { EventBus } from "../src/engine/events"
import { sseRoutes, setEventBus, REPLAY_TAIL_WINDOW } from "../src/api/sse"

const PROJ = "/tmp/opencode/docs08-batch-t8/proj-a"
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

type Wire = { type: string; sessionId: string } & Record<string, unknown>

function entryAppended(sessionId: string, entryId: number): Wire {
  return { type: "entry_appended", sessionId, entry: { id: entryId, type: "message" } }
}

/** 构造确定性事件流：mustEmit 条必放帧（entry_appended 为主）与 stream 条
 * message_update 流式中间帧交替。返回发布后的桥 id 区间信息由调用方用 bus 读取。 */
function publishMixed(
  bus: EventBus,
  sessionId: string,
  mustEmit: number,
  stream: number,
): void {
  for (let i = 1; i <= mustEmit; i++) {
    if (stream > 0 && i % 5 === 0) {
      // 每条第 5 个必放帧前插入 2 条流式中间帧（确定性交织）
      bus.publish(PROJ, { type: "message_update", sessionId, seq: i * 10 + 1 } as never)
      bus.publish(PROJ, { type: "message_update", sessionId, seq: i * 10 + 2 } as never)
      stream -= 2 > stream ? stream : 2
    }
    const wire: Wire =
      i % 4 === 0
        ? { type: "error", sessionId, message: `e${i}` }
        : i % 4 === 2
          ? { type: "agent_end", sessionId }
          : entryAppended(sessionId, i)
    bus.publish(PROJ, wire as never)
  }
}

describe("SSE 新连接回放窗口收敛（任务 8）", () => {
  test(`(a) 无 Last-Event-ID 新连接：>N 帧历史只回放最近 ≤${N} 帧必放帧，无 message_update 中间帧，标记与 gap 齐全`, async () => {
    const { bus, app } = makeApp()
    // 250 条必放帧 + 交织 message_update 中间帧（远超 N）
    publishMixed(bus, "s1", 250, 100)
    expect(bus.latestId).toBeGreaterThan(N + 20)

    const res = await app.request("/api/events")
    // 预期块数：gap + begin + ≤N 帧 + done。精确数：尾窗扫描必放帧取满 N=200
    //（末条 message_update 快照占用 1 席，则必放帧 199），总帧 = 200。
    const blocks = await readSseBlocks(res.body!, N + 3)
    await res.body!.cancel()

    const frames = blocks.map(parseBlock)
    // 首块 gap：缺口 = [1, windowStart-1]
    const gap = frames[0]
    expect(gap.event).toBe("gap")
    const gapData = JSON.parse(gap.data!)
    expect(gapData.from).toBe(1)
    expect(gapData.to).toBeGreaterThan(0)

    // 标记包夹
    const begin = frames[1]
    expect(begin.event).toBe("replay_begin")
    const done = frames[frames.length - 1]
    expect(done.event).toBe("replay_done")

    const replayed = frames.slice(2, -1)
    // 帧数 ≤ N（这里恰好 = N：必放帧充足，message_update 快照占 1 席）
    expect(replayed.length).toBeLessThanOrEqual(N)
    expect(replayed.length).toBe(N)
    // 无 message_update 中间帧：每会话至多 1 条（末帧快照）
    const updates = replayed.filter((f) => f.event === "message_update")
    expect(updates.length).toBeLessThanOrEqual(1)
    // 必放帧型在场
    const types = new Set(replayed.map((f) => f.event))
    expect(types.has("entry_appended")).toBe(true)
    expect(types.has("error")).toBe(true)
    // id 严格递增（Last-Event-ID 单调性）
    const ids = replayed.map((f) => Number(f.id))
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1])
    // 窗口边界与 gap 区间无缝衔接：首帧 id = gap.to + 1
    expect(ids[0]).toBe(gapData.to + 1)
    // done 标记 id = 末帧 id，count = 回放帧数
    expect(done.id).toBe(String(ids[ids.length - 1]))
    expect(JSON.parse(done.data!).count).toBe(replayed.length)
  })

  test("(b) 带 Last-Event-ID 的连接行为完全不变（回归）：全量续发、含 message_update 中间帧、窗口收敛不生效", async () => {
    const { bus, app } = makeApp()
    publishMixed(bus, "s1", 250, 100)
    const total = bus.latestId

    // 显式 Last-Event-ID: 0 —— 同为"从头"，但带头的连接不做窗口化
    const res0 = await app.request("/api/events", { headers: { "Last-Event-ID": "0" } })
    const blocks0 = await readSseBlocks(res0.body!, total + 2)
    await res0.body!.cancel()
    const frames0 = blocks0.map(parseBlock)
    expect(frames0[0].event).toBe("replay_begin")
    expect(frames0[frames0.length - 1].event).toBe("replay_done")
    const replayed0 = frames0.slice(1, -1)
    expect(replayed0.length).toBe(total)
    // message_update 中间帧原样全量重放（250 帧历史含交织流式帧）
    expect(replayed0.some((f) => f.event === "message_update")).toBe(true)
    // 无 gap（缓冲无淘汰、游标 0 在覆盖内）
    expect(frames0.some((f) => f.event === "gap")).toBe(false)

    // 中位续传：Last-Event-ID = 游标中点，之后全部事件（含中间帧）
    const mid = Math.floor(total / 2)
    const res1 = await app.request("/api/events", { headers: { "Last-Event-ID": String(mid) } })
    const blocks1 = await readSseBlocks(res1.body!, total - mid + 2)
    await res1.body!.cancel()
    const replayed1 = blocks1.map(parseBlock).slice(1, -1)
    expect(replayed1.length).toBe(total - mid)
    expect(replayed1.some((f) => f.event === "message_update")).toBe(true)
  })

  test("(c) 联合接缝（与任务 9）：未收到的帧恰为连续前缀区间，边界帧 id 与 REST 尾窗补齐边界对齐", async () => {
    const { bus, app } = makeApp()
    // 250 条 entry_appended（entry id 与发布顺序一致，模拟落库 entry 身份）
    // + 尾部少量 message_update（活跃流式回合）
    for (let i = 1; i <= 250; i++) {
      bus.publish(PROJ, entryAppended("s1", i) as never)
    }
    bus.publish(PROJ, { type: "message_update", sessionId: "s1", seq: 1 } as never)
    bus.publish(PROJ, { type: "message_update", sessionId: "s1", seq: 2 } as never)
    bus.publish(PROJ, { type: "message_update", sessionId: "s1", seq: 3 } as never)

    const res = await app.request("/api/events")
    const blocks = await readSseBlocks(res.body!, N + 3)
    await res.body!.cancel()
    const frames = blocks.map(parseBlock)
    expect(frames[0].event).toBe("gap")
    const gapData = JSON.parse(frames[0].data!)

    // 客户端实际收到的 entry（经 entry_appended 携真实 entry id）
    const receivedEntryIds = frames
      .filter((f) => f.event === "entry_appended")
      .map((f) => (JSON.parse(f.data!).event as { entry: { id: number } }).entry.id)
      .sort((a, b) => a - b)
    expect(receivedEntryIds.length).toBeGreaterThan(0)
    const boundaryEntryId = receivedEntryIds[0]

    // 接缝断言 1：未收到的 entry 恰为连续前缀 [1, boundaryEntryId - 1]——
    // 任务 9 的增量补齐（GET messages 尾窗 + ?before=<boundary> 后翻）有确定性边界
    expect(receivedEntryIds).toEqual(
      Array.from({ length: 250 - boundaryEntryId + 1 }, (_, k) => boundaryEntryId + k),
    )
    // 接缝断言 2：桥游标接缝同样连续——首个回放帧 id = gap.to + 1，
    // 客户端游标（末帧 id）到缓冲末尾无洞（订阅后续发无缝）
    const replayedIds = frames.slice(2, -1).map((f) => Number(f.id))
    expect(replayedIds[0]).toBe(gapData.to + 1)
    // 接缝断言 3：entry 身份序与桥游标序一致（同一发布序），REST 边界帧
    //（boundaryEntryId）即窗口首帧承载的 entry——两条补齐路径边界重合
    const firstEntryFrame = frames.slice(2, -1).find((f) => f.event === "entry_appended")
    expect(
      (JSON.parse(firstEntryFrame!.data!).event as { entry: { id: number } }).entry.id,
    ).toBe(boundaryEntryId)
  })

  test("(d) 边界：恰好 N 帧必放历史不截断（无 gap）；N+1 帧必放历史截断为 N 帧并发 gap", async () => {
    // 恰好 N：必放帧数 = N，不触发截断
    {
      const { bus, app } = makeApp()
      for (let i = 1; i <= N; i++) bus.publish(PROJ, entryAppended("s1", i) as never)
      const res = await app.request("/api/events")
      const blocks = await readSseBlocks(res.body!, N + 2)
      await res.body!.cancel()
      const frames = blocks.map(parseBlock)
      expect(frames.some((f) => f.event === "gap")).toBe(false)
      expect(frames[0].event).toBe("replay_begin")
      expect(frames[frames.length - 1].event).toBe("replay_done")
      expect(frames.slice(1, -1).length).toBe(N)
    }
    // N+1：截断为 N 帧，gap = [1, 1]（首帧 id = 2）
    {
      const { bus, app } = makeApp()
      for (let i = 1; i <= N + 1; i++) bus.publish(PROJ, entryAppended("s1", i) as never)
      const res = await app.request("/api/events")
      const blocks = await readSseBlocks(res.body!, N + 3)
      await res.body!.cancel()
      const frames = blocks.map(parseBlock)
      const gap = frames[0]
      expect(gap.event).toBe("gap")
      expect(JSON.parse(gap.data!)).toEqual({ from: 1, to: 1 })
      const replayed = frames.slice(2, -1)
      expect(replayed.length).toBe(N)
      expect(replayed[0].id).toBe("2")
      expect(frames[frames.length - 1].event).toBe("replay_done")
    }
  })

  test("(对抗 stale_state) 会话早于环形缓冲：退化为既有语义（gap + 从最旧可用续发），窗口化不额外改变", async () => {
    // 小容量环缓（50）发布 120 帧 → 最旧 70 帧被淘汰；无头新连接：
    // replay.gap = [1, 70]，缓冲内 50 帧全部回放（50 < N，无二次截断）
    const { bus, app } = makeApp(50)
    for (let i = 1; i <= 120; i++) bus.publish(PROJ, entryAppended("s1", i) as never)
    const res = await app.request("/api/events")
    const blocks = await readSseBlocks(res.body!, 53)
    await res.body!.cancel()
    const frames = blocks.map(parseBlock)
    expect(frames[0].event).toBe("gap")
    expect(JSON.parse(frames[0].data!)).toEqual({ from: 1, to: 70 })
    const replayed = frames.slice(2, -1)
    expect(replayed.length).toBe(50)
    expect(replayed[0].id).toBe("71")
    expect(frames[frames.length - 1].event).toBe("replay_done")
  })

  test("(对抗 malformed-input) Last-Event-ID 非法值：负数按 0 走带头全量路径；超前沿用 gap 且无续发", async () => {
    const { bus, app } = makeApp()
    publishMixed(bus, "s1", 30, 10)
    const total = bus.latestId

    // 负数：parseInt=-5 不满足 >=0 → 按 0；带头连接不走窗口化，全量重放
    const resNeg = await app.request("/api/events", { headers: { "Last-Event-ID": "-5" } })
    const blocksNeg = await readSseBlocks(resNeg.body!, total + 2)
    await resNeg.body!.cancel()
    const framesNeg = blocksNeg.map(parseBlock)
    expect(framesNeg[0].event).toBe("replay_begin")
    expect(framesNeg.slice(1, -1).length).toBe(total)
    expect(framesNeg.some((f) => f.event === "gap")).toBe(false)

    // 超前（服务重启游标归零场景）：gap 且无续发，基点 = 当前游标
    const resFuture = await app.request("/api/events", { headers: { "Last-Event-ID": "999999" } })
    const blocksFuture = await readSseBlocks(resFuture.body!, 1)
    await resFuture.body!.cancel()
    const gapFrame = parseBlock(blocksFuture[0])
    expect(gapFrame.event).toBe("gap")
    expect(gapFrame.id).toBe(String(total))
    expect(JSON.parse(gapFrame.data!)).toEqual({ from: 1000000, to: total })
  })
})
