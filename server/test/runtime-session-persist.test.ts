/**
 * docs08-2026-10-23-24-batch 任务 6：会话落盘消静默 + durable 误判修复（t1 根因靶点）。
 * 覆盖（真实 ProjectRuntime 链路，fake 引擎 RPC 面）：
 * 1. createSession：引擎 list_sessions 认领 durableSessionId 但会话文件不存在
 *    → durable=false + 进别名表，resolveSession 报结构化 409 session_not_persisted
 *    （而非笼统 404 session_not_found——t1 事发现场形态）；
 * 2. 落盘补齐自愈：认领后文件补写 → resolveSession 恢复正常解析；
 * 3. prompt 回执落盘复核：认领仍无文件 → prompt 回传结构化错误（消静默，
 *    404 不再是下游第一症状）；
 * 4. 对照：文件存在（真实落盘）→ durable=true，无认领报错。
 */
import { describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { EngineProcessManager } from "../src/engine/process-manager"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"
import { ApiError } from "../src/api/http"

const PROJECT = "/tmp/opencode/rt-persist-proj"
const DURABLE_ID = "01c22222-0000-7000-8000-000000000006"

/** fake 引擎 RPC：open 按路径 echo（新契约 attach 幂等，运行时预生成路径运行期才
 * 可知，list_sessions 行回最近 open 的路径）；claimDurable 可编程切换是否携带
 * durableSessionId（模拟 t1 形态：认领成功但从不写盘）；persistOnOpen 模拟真实
 * 引擎 open 即写会话头（落盘对照用）。 */
class FakeEngineRpc {
  /** 当前 list_sessions 行是否携带 durableSessionId */
  claimDurable = false
  /** open_session 是否落盘（真实引擎 open 即写盘；false = t1 认领不写盘形态） */
  persistOnOpen = false
  promptCalls = 0
  private routing = 1
  /** 最近一次 open 的目标路径 */
  private lastOpenPath = ""

  constructor(readonly sessionPath: string) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async setClientInfo(): Promise<void> {}
  send(): Promise<{ success: boolean }> {
    return Promise.resolve({ success: true })
  }

  async openSession(options: { sessionPath?: string }): Promise<{
    sessionId: string
    state: { sessionId: string; sessionFile?: string }
  }> {
    const handle = `rpc-${this.routing++}`
    const path = options.sessionPath ?? this.sessionPath
    this.lastOpenPath = path
    if (this.persistOnOpen) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: DURABLE_ID, cwd: PROJECT })}\n`)
    }
    return { sessionId: handle, state: { sessionId: DURABLE_ID, sessionFile: path } }
  }

  async closeSession(): Promise<void> {}

  async listSessions(): Promise<Array<Record<string, unknown>>> {
    const row: Record<string, unknown> = {
      sessionId: "rpc-1",
      sessionPath: this.lastOpenPath || this.sessionPath,
      cwd: PROJECT,
      status: "open",
    }
    if (this.claimDurable) row.durableSessionId = DURABLE_ID
    return [row]
  }

  async prompt(): Promise<string> {
    this.promptCalls += 1
    return "started"
  }

  async abort(): Promise<void> {}
  onEvent(): () => void {
    return () => {}
  }
  async sendExtensionUIResponse(): Promise<void> {}
  async getAvailableModels(): Promise<unknown[]> {
    return []
  }
  async getAvailableThinkingLevels(): Promise<string[]> {
    return ["low", "high", "max"]
  }
  async getSessionStats(): Promise<Record<string, unknown>> {
    return {}
  }
  async getMedia(): Promise<unknown> {
    return { type: "image", data: "", mimeType: "image/png" }
  }
  async getEntries(): Promise<{ entries: unknown[]; leafId: string | null }> {
    return { entries: [], leafId: null }
  }
  async getState(): Promise<Record<string, unknown>> {
    return {}
  }
}

function makeRegistry(rpc: FakeEngineRpc, agentDir: string): EngineRuntimeRegistry {
  const fakeManager = {
    ensureRunning: async () => {},
    getClient: (_project: string) => rpc,
    getStatus: () => ({ state: "ready" }),
    onEvent: (_listener: (event: unknown) => void) => () => {},
    stop: async () => {},
    stopAll: async () => {},
    reportSessionActive: (_sessionPath: string, _sessionId: string): void => {},
    markUserActivity: (_sessionPath: string): void => {},
  } as unknown as EngineProcessManager
  return new EngineRuntimeRegistry(fakeManager, {
    listProjects: () => [PROJECT],
    agentDir,
  })
}

function setup(): { root: string; agentDir: string; sessionPath: string; rpc: FakeEngineRpc; registry: EngineRuntimeRegistry } {
  const root = mkdtempSync(join(tmpdir(), "rt-persist-test-"))
  const agentDir = join(root, "agent")
  const sessionsDir = join(agentDir, "sessions", `--${PROJECT.replace(/^\//, "").replaceAll("/", "-")}--`)
  mkdirSync(sessionsDir, { recursive: true })
  const sessionPath = join(sessionsDir, `2026-10-25T00-00-00-000Z_${DURABLE_ID}.jsonl`)
  const rpc = new FakeEngineRpc(sessionPath)
  return { root, agentDir, sessionPath, rpc, registry: makeRegistry(rpc, agentDir) }
}

describe("durable 落盘判定与消静默（docs08 任务 6，t1 根因）", () => {
  test("认领 durable 但文件未落盘 → durable=false 进别名，resolveSession 报结构化 session_not_persisted", async () => {
    const h = setup()
    try {
      h.rpc.claimDurable = true // 引擎口头认领，但磁盘无 JSONL（t1 复现形态）
      const created = await h.registry.createSession(PROJECT, {})
      expect(created.durable).toBe(false) // 不再误判 durable
      expect(created.id).toBe(DURABLE_ID) // 别名表已进入该 id

      const err = await h.registry.sessionPath(DURABLE_ID).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(409)
      expect((err as ApiError).code).toBe("session_not_persisted") // 可与 404 区分
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("认领后文件补写 → resolveSession 自愈恢复正常解析（懒落盘不误伤）", async () => {
    const h = setup()
    try {
      h.rpc.claimDurable = true
      const created = await h.registry.createSession(PROJECT, {})
      // 引擎此后补写了文件（认领的预生成路径由 createSession 回带）
      writeFileSync(created.sessionPath, `${JSON.stringify({ type: "session", version: 3, id: DURABLE_ID, cwd: PROJECT })}\n`)
      const row = await h.registry.resolveSessionRow(DURABLE_ID)
      expect(row?.id).toBe(DURABLE_ID)
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("prompt 回执落盘复核：认领仍无文件 → 回传结构化错误（404 不再是第一症状）", async () => {
    const h = setup()
    try {
      // 建会话时引擎未认领（纯别名路径）；prompt 后认领但文件依旧不存在
      const created = await h.registry.createSession(PROJECT, {})
      expect(created.durable).toBe(false)
      h.rpc.claimDurable = true
      const err = await h.registry.prompt(created.id, { text: "hello" }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(h.rpc.promptCalls).toBe(1) // 回合确已发出
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(409)
      expect((err as ApiError).code).toBe("session_not_persisted")
      expect((err as ApiError).message).toContain("未落盘")
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("对照：真实落盘（文件存在）→ durable=true，resolveSession 正常", async () => {
    const h = setup()
    try {
      h.rpc.claimDurable = true
      h.rpc.persistOnOpen = true // 引擎 open 即落盘 → durable 存在性复核通过
      const created = await h.registry.createSession(PROJECT, {})
      expect(created.durable).toBe(true)
      const row = await h.registry.resolveSessionRow(created.id)
      expect(row?.id).toBe(DURABLE_ID)
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })
})
