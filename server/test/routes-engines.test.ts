// 引擎进程管理路由 + 设置变更钩子（2026-11-04）：
// GET /api/engines 全量快照；POST /api/engines/stop 手动停（未知项目 404 / 相对路径 400）；
// PUT /api/settings 写入后 onSettingsChanged 以键名回调（引擎空闲档即时生效的接线点）。
import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { createEngineAdminRoutes, type EngineAdminRow } from "../src/api/routes-engines"
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

const ROWS: EngineAdminRow[] = [
  { projectPath: "/data/projects/alpha", state: "ready", pid: 123, restarts: 0, runningSessions: 1, lastActivityAt: 1793800000000 },
  { projectPath: "/data/projects/beta", state: "stopped", restarts: 1, runningSessions: 0, lastActivityAt: null },
]

describe("GET /api/engines", () => {
  test("返回全量快照", async () => {
    const app = createEngineAdminRoutes({ listEngines: () => ROWS, stopEngine: async () => {}, isKnownProject: () => true })
    const res = await app.request("/api/engines")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.engines).toHaveLength(2)
    expect(body.engines[0]).toMatchObject({ projectPath: "/data/projects/alpha", state: "ready", runningSessions: 1 })
  })
})

describe("POST /api/engines/stop", () => {
  function makeApp(stopped: string[]) {
    return createEngineAdminRoutes({
      listEngines: () => ROWS,
      stopEngine: async (p) => void stopped.push(p),
      isKnownProject: (p) => ROWS.some((r) => r.projectPath === p),
    })
  }

  test("已注册项目：停止并返回 ok", async () => {
    const stopped: string[] = []
    const res = await makeApp(stopped).request("/api/engines/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "/data/projects/alpha" }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(stopped).toEqual(["/data/projects/alpha"])
  })

  test("未注册项目：404 unknown_project", async () => {
    const res = await makeApp([]).request("/api/engines/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "/data/projects/nope" }),
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unknown_project")
  })

  test("相对路径：400 invalid_project", async () => {
    const res = await makeApp([]).request("/api/engines/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "relative/path" }),
    })
    expect(res.status).toBe(400)
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
