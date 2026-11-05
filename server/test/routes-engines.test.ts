// 引擎进程管理路由 + 行构造器 + 设置变更钩子（2026-11-04；2026-11-05 T5 行会话化改写）：
// GET /api/engines 每会话引擎一行（含无引擎已知项目 inactive 行，列表不做已知项目门）；
// POST /api/engines/stop：sessionPath 定向停单会话引擎 / project 项目级停全部
// （未知会话 404 unknown_session、未知项目 404 unknown_project、相对路径 400）；
// buildEngineAdminRows：同项目双会话双行、inactive 行不误报 ready；
// PUT /api/settings 写入后 onSettingsChanged 以键名回调（引擎空闲档即时生效的接线点）。
import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { buildEngineAdminRows, createEngineAdminRoutes, type EngineAdminRow } from "../src/api/routes-engines"
import type { EngineState } from "../src/engine/process-manager"
import { createMetaRoutes } from "../src/api/routes-meta"
import type { MetaDb } from "../src/db/meta"

function fakeMeta(kv: Map<string, string> = new Map()): MetaDb {
  return {
    setKv: (k: string, v: string) => void kv.set(k, v),
    getKv: (k: string) => kv.get(k) ?? null,
    listKv: () => Object.fromEntries(kv),
    listProjectMeta: () => [],
  } as unknown as MetaDb
}

/** 状态化 fake：行源=可变引擎数组（模拟 manager：stop 后行仍在、state→stopped、
 * pid 清空、运行回合清零），stopEngine/stopProject 分账记录定向停与项目级停。 */
interface FakeEngine {
  projectPath: string
  sessionPath: string
  state: EngineState
  pid: number | undefined
  consecutiveRestarts: number
  runningSessions: string[]
  lastActivityAt: number
}

const PROJ_A = "/data/projects/alpha"
const S1 = `${PROJ_A}/s1.jsonl`
const S2 = `${PROJ_A}/s2.jsonl`

function fakeHarness() {
  const engines: FakeEngine[] = [
    { projectPath: PROJ_A, sessionPath: S1, state: "ready", pid: 111, consecutiveRestarts: 0, runningSessions: ["s1"], lastActivityAt: 1000 },
    { projectPath: PROJ_A, sessionPath: S2, state: "ready", pid: 222, consecutiveRestarts: 0, runningSessions: ["s2"], lastActivityAt: 2000 },
  ]
  const sessionStops: string[] = []
  const projectStops: string[] = []
  const stopOne = (sessionPath: string) => {
    const e = engines.find((x) => x.sessionPath === sessionPath)
    if (!e) return
    e.state = "stopped"
    e.pid = undefined
    e.runningSessions = []
  }
  const knownProjects = [PROJ_A, "/data/projects/beta"]
  const rows = (): EngineAdminRow[] =>
    buildEngineAdminRows(
      engines.map((e) => ({ ...e, runningSessions: [...e.runningSessions] })),
      knownProjects.map((projectPath) => ({ projectPath })),
    )
  const app = createEngineAdminRoutes({
    listEngines: rows,
    stopEngine: async (sessionPath) => {
      sessionStops.push(sessionPath)
      stopOne(sessionPath)
    },
    stopProject: async (projectPath) => {
      projectStops.push(projectPath)
      for (const e of engines.filter((x) => x.projectPath === projectPath)) stopOne(e.sessionPath)
    },
    isKnownProject: (projectPath) => knownProjects.includes(projectPath),
  })
  return { app, engines, sessionStops, projectStops, rows }
}

const post = (app: Hono, body: Record<string, unknown>) =>
  app.request("/api/engines/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("buildEngineAdminRows 行构造器", () => {
  test("同项目双会话产生双行（每会话引擎一行）", () => {
    const rows = buildEngineAdminRows(
      [
        { projectPath: PROJ_A, sessionPath: S1, state: "ready" as const, pid: 111, consecutiveRestarts: 0, runningSessions: ["s1"], lastActivityAt: 1000 },
        { projectPath: PROJ_A, sessionPath: S2, state: "ready" as const, pid: 222, consecutiveRestarts: 2, runningSessions: ["s2", "s3"], lastActivityAt: 2000 },
      ],
      [],
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.sessionPath)).toEqual([S1, S2])
    expect(rows[0]).toMatchObject({ projectPath: PROJ_A, state: "ready", pid: 111, restarts: 0, runningSessions: 1, lastActivityAt: 1000 })
    expect(rows[1]).toMatchObject({ projectPath: PROJ_A, state: "ready", pid: 222, restarts: 2, runningSessions: 2, lastActivityAt: 2000 })
  })

  test("无引擎已知项目保留 inactive 行（sessionPath=null，不误报 ready）", () => {
    const rows = buildEngineAdminRows(
      [{ projectPath: PROJ_A, sessionPath: S1, state: "ready" as const, pid: 111, consecutiveRestarts: 0, runningSessions: ["s1"], lastActivityAt: 1000 }],
      [{ projectPath: PROJ_A }, { projectPath: "/data/projects/beta" }],
    )
    expect(rows).toHaveLength(2)
    const inactive = rows.find((r) => r.projectPath === "/data/projects/beta")
    expect(inactive).toMatchObject({
      sessionPath: null,
      state: "inactive",
      restarts: 0,
      runningSessions: 0,
      lastActivityAt: null,
    })
    expect(inactive?.pid).toBeUndefined()
    expect(inactive?.state).not.toBe("ready")
  })
})

describe("GET /api/engines", () => {
  test("全量快照透传（含 sessionPath 与 inactive 行）", async () => {
    const { app } = fakeHarness()
    const res = await app.request("/api/engines")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { engines: EngineAdminRow[] }
    // 双会话双行 + beta 无引擎 inactive 行
    expect(body.engines).toHaveLength(3)
    expect(body.engines.find((r) => r.sessionPath === S1)).toMatchObject({ projectPath: PROJ_A, state: "ready", runningSessions: 1 })
    expect(body.engines.find((r) => r.projectPath === "/data/projects/beta")).toMatchObject({ sessionPath: null, state: "inactive" })
  })

  test("列表不做已知项目门（isKnownProject=false 也不影响透出）", async () => {
    const app = createEngineAdminRoutes({
      listEngines: () => [
        { projectPath: PROJ_A, sessionPath: S1, state: "ready", pid: 111, restarts: 0, runningSessions: 1, lastActivityAt: 1000 },
      ],
      stopEngine: async () => {},
      stopProject: async () => {},
      isKnownProject: () => false,
    })
    const res = await app.request("/api/engines")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { engines: EngineAdminRow[] }
    expect(body.engines).toHaveLength(1)
  })
})

describe("POST /api/engines/stop（T5 会话化）", () => {
  test("定向停 A 只停 A：A 行转 stopped，B 行仍在且 ready 未被动，项目级停未被走", async () => {
    const { app, sessionStops, projectStops } = fakeHarness()
    const res = await post(app, { sessionPath: S1 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    // 定向分账：只走了 sessionPath 停，未走项目级停
    expect(sessionStops).toEqual([S1])
    expect(projectStops).toEqual([])
    // B 引擎未被动：行仍在、state 仍 ready、pid/运行回合不变（非仅 A 消失）
    const list = await app.request("/api/engines")
    const body = (await list.json()) as { engines: EngineAdminRow[] }
    const rowA = body.engines.find((r) => r.sessionPath === S1)
    const rowB = body.engines.find((r) => r.sessionPath === S2)
    expect(rowA).toMatchObject({ state: "stopped", runningSessions: 0 })
    expect(rowA?.pid).toBeUndefined()
    expect(rowB).toMatchObject({ projectPath: PROJ_A, state: "ready", pid: 222, runningSessions: 1, lastActivityAt: 2000 })
  })

  test("项目级停全停：该项目全部会话引擎转 stopped，定向停未被走", async () => {
    const { app, sessionStops, projectStops } = fakeHarness()
    const res = await post(app, { project: PROJ_A })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(projectStops).toEqual([PROJ_A])
    expect(sessionStops).toEqual([])
    const list = await app.request("/api/engines")
    const body = (await list.json()) as { engines: EngineAdminRow[] }
    const engineRows = body.engines.filter((r) => r.sessionPath !== null)
    expect(engineRows).toHaveLength(2)
    expect(engineRows.every((r) => r.state === "stopped")).toBe(true)
  })

  test("未注册会话：404 unknown_session", async () => {
    const { app, sessionStops } = fakeHarness()
    const res = await post(app, { sessionPath: "/data/projects/alpha/unknown.jsonl" })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unknown_session")
    expect(sessionStops).toEqual([])
  })

  test("相对 sessionPath：400", async () => {
    const { app, sessionStops } = fakeHarness()
    const res = await post(app, { sessionPath: "relative/s.jsonl" })
    expect(res.status).toBe(400)
    expect(sessionStops).toEqual([])
  })

  test("未注册项目：404 unknown_project（项目级停校验保留）", async () => {
    const { app, projectStops } = fakeHarness()
    const res = await post(app, { project: "/data/projects/nope" })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unknown_project")
    expect(projectStops).toEqual([])
  })

  test("相对 project：400", async () => {
    const { app } = fakeHarness()
    const res = await post(app, { project: "relative/path" })
    expect(res.status).toBe(400)
  })

  test("sessionPath 与 project 均缺：400 invalid_request", async () => {
    const { app } = fakeHarness()
    const res = await post(app, {})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request")
  })
})

describe("PUT /api/settings → onSettingsChanged 钩子（引擎空闲档即时生效接线点）", () => {
  test("落库后以被写键回调", async () => {
    const kv = new Map<string, string>()
    const called: string[][] = []
    const app = new Hono()
    app.route("/", createMetaRoutes({
      meta: fakeMeta(kv),
      engines: {} as never,
      onSettingsChanged: (keys: string[]) => called.push(keys),
    } as never))
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "engine.idleTimeoutMinutes": "never" }),
    })
    expect(res.status).toBe(200)
    expect(kv.get("engine.idleTimeoutMinutes")).toBe("never")
    expect(called).toEqual([["engine.idleTimeoutMinutes"]])
  })
})
