/**
 * 引擎回收历史只读面单测（engine-ux-visibility 任务 6）：
 * GET /api/engines/reclaims + ReclaimRing。
 *
 * 覆盖：
 * - ReclaimRing：FIFO 追加、list 最新在前浅拷贝、容量有界掐头、at 注入
 * - 路由：环内容逐字段透出（{at, sessionPath, reason}）；空环 → 200 + 空表
 *   （缺席是合法观测态，与 metrics 同语义）
 * - 纯读：一次请求恰好一次环读取（无隐藏采样/无副作用）
 *
 * 对抗面：misleading_success_output——断言具体记录值与顺序，不以「200 无异常」
 * 当作通过。
 */

import { describe, expect, test } from "vitest"
import {
  RECLAIM_RING_CAPACITY,
  ReclaimRing,
  createEngineReclaimsRoutes,
  type EngineReclaimRecord,
} from "../src/api/routes-engine-reclaims"

function rec(sessionPath: string, reason: EngineReclaimRecord["reason"], at: number): EngineReclaimRecord {
  return { at, sessionPath, reason }
}

describe("ReclaimRing 有界内存环", () => {
  test("list 最新在前、浅拷贝（外部修改不污染环）", () => {
    const ring = new ReclaimRing()
    ring.push({ sessionPath: "/a/s1.jsonl", reason: "idle_timeout" }, 1_000)
    ring.push({ sessionPath: "/a/s2.jsonl", reason: "activity_window" }, 2_000)
    expect(ring.list()).toEqual([
      rec("/a/s2.jsonl", "activity_window", 2_000),
      rec("/a/s1.jsonl", "idle_timeout", 1_000),
    ])
    ring.list().pop()
    expect(ring.list()).toHaveLength(2)
  })

  test("容量有界：超容量掐头，仅保留最近 N 次", () => {
    const ring = new ReclaimRing(3)
    for (let i = 0; i < 6; i++) ring.push({ sessionPath: `/a/s${i}.jsonl`, reason: "idle_timeout" }, i)
    expect(ring.list().map((r) => r.sessionPath)).toEqual(["/a/s5.jsonl", "/a/s4.jsonl", "/a/s3.jsonl"])
  })

  test("缺省容量 = RECLAIM_RING_CAPACITY", () => {
    expect(new ReclaimRing().capacity).toBe(RECLAIM_RING_CAPACITY)
  })

  test("at 缺省取 Date.now()", () => {
    const ring = new ReclaimRing()
    const before = Date.now()
    ring.push({ sessionPath: "/a/s1.jsonl", reason: "idle_timeout" })
    const after = Date.now()
    const [head] = ring.list()
    expect(head!.at).toBeGreaterThanOrEqual(before)
    expect(head!.at).toBeLessThanOrEqual(after)
  })
})

describe("GET /api/engines/reclaims 路由", () => {
  function makeApp(ring: ReclaimRing) {
    let reads = 0
    const app = createEngineReclaimsRoutes({
      listReclaims: () => {
        reads++
        return ring.list()
      },
    })
    return { app, reads: () => reads }
  }

  test("环内容逐字段透出（最新在前），字段恰为 {at, sessionPath, reason}", async () => {
    const ring = new ReclaimRing()
    ring.push({ sessionPath: "/a/s1.jsonl", reason: "idle_timeout" }, 1_000)
    ring.push({ sessionPath: "/b/s2.jsonl", reason: "activity_window" }, 2_000)
    const { app } = makeApp(ring)
    const res = await app.request("/api/engines/reclaims")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { reclaims: EngineReclaimRecord[] }
    expect(body.reclaims).toEqual([
      rec("/b/s2.jsonl", "activity_window", 2_000),
      rec("/a/s1.jsonl", "idle_timeout", 1_000),
    ])
  })

  test("空环 → 200 + 空表（不是 404/500）", async () => {
    const { app } = makeApp(new ReclaimRing())
    const res = await app.request("/api/engines/reclaims")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reclaims: [] })
  })

  test("纯读：一次请求恰好一次环读取", async () => {
    const ring = new ReclaimRing()
    ring.push({ sessionPath: "/a/s1.jsonl", reason: "idle_timeout" }, 1_000)
    const { app, reads } = makeApp(ring)
    await app.request("/api/engines/reclaims")
    expect(reads()).toBe(1)
  })
})
