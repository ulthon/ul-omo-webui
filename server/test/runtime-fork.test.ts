/**
 * 运行时 fork→删除回归测试（手机端走查实锤 bug）：
 * fork 会话行的"删除"确认后，实际删除的是 fork 的源会话（"演示主会话"）。
 * 根因在 ProjectRuntime.forkSession：client.fork() 后引擎侧活跃已切到新会话，
 * 但 adapter.active 仍指 fork 前的旧会话（只有 openSession 会更新它），而
 * activeId 已写为 fork id——resolveSession 的活跃快捷路径（activeId 命中即信任
 * adapter.active）便把后续按 fork id 的 messages/prompt/delete 全部解析到旧会话文件。
 * 本测试经 EngineRuntimeRegistry 公共面驱动：fork 后按 fork id 删除，
 * 断言源会话文件仍在、fork 文件被删。
 */
import { describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineProcessManager } from "../src/engine/process-manager"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"

const PROJECT = "/tmp/opencode/rt-fork-proj"
const SESSIONS_DIR_NAME = `--${PROJECT.replace(/^\//, "").replaceAll("/", "-")}--`

const MAIN_ID = "01a11141-49e9-7fb0-a845-952b49731e54"
const FORK_ID = "01a11142-98c3-71e3-a372-059ada7db4b0"

/** header v3 形态照 server/test/fixtures/protocol/fork-header.json 实录 */
function sessionFile(agentDir: string, id: string, parentSession?: string): string {
  const dir = join(agentDir, "sessions", SESSIONS_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `2026-10-06T12-48-59-587Z_${id}.jsonl`)
  const header: Record<string, unknown> = {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-10-06T12:48:59.587Z",
    cwd: PROJECT,
  }
  if (parentSession) header.parentSession = parentSession
  writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8")
  return path
}

/**
 * fake 引擎 RPC 面：引擎自身维护活跃会话（fork 即切换，open_session 显式切换），
 * list_sessions 常态返回两行 open（多会话实证形态，learnings W1 todo 6）。
 */
class FakeEngineRpc {
  calls: Array<{ method: string; args?: unknown }> = []
  private routing = 1
  private engineActivePath: string | null = null
  private readonly mainPath: string
  private readonly forkPath: string

  constructor(mainPath: string, forkPath: string) {
    this.mainPath = mainPath
    this.forkPath = forkPath
  }

  async start(): Promise<void> {
    this.calls.push({ method: "start" })
  }

  async stop(): Promise<void> {
    this.calls.push({ method: "stop" })
  }

  async setClientInfo(): Promise<void> {
    this.calls.push({ method: "set_client_info" })
  }

  send(): Promise<{ success: boolean }> {
    this.calls.push({ method: "send" })
    return Promise.resolve({ success: true })
  }

  async openSession(options: { sessionPath?: string }): Promise<{
    sessionId: string
    state: { sessionId: string; sessionFile?: string }
  }> {
    this.calls.push({ method: "open_session", args: options })
    this.engineActivePath = options.sessionPath ?? null
    const handle = `rpc-${this.routing++}`
    return { sessionId: handle, state: { sessionId: handle, sessionFile: options.sessionPath } }
  }

  async closeSession(): Promise<void> {
    this.calls.push({ method: "close_session" })
    this.engineActivePath = null
  }

  async listSessions(): Promise<Array<Record<string, unknown>>> {
    this.calls.push({ method: "list_sessions" })
    return [
      { sessionId: "rpc-main", durableSessionId: MAIN_ID, sessionPath: this.mainPath, cwd: PROJECT, status: "open" },
      { sessionId: "rpc-fork", durableSessionId: FORK_ID, sessionPath: this.forkPath, cwd: PROJECT, status: "open" },
    ]
  }

  async fork(): Promise<{ text: string; cancelled: boolean }> {
    this.calls.push({ method: "fork" })
    // 引擎 fork 即切换活跃会话到新会话文件（docs/verification/05 P1-1 实录）
    this.engineActivePath = this.forkPath
    return { text: "原文消息", cancelled: false }
  }

  /** ProjectRuntime.forkSession 经 cast 直调（wrappedClient 是管理器原样 client） */
  getState(): Promise<{ sessionId: string; sessionFile: string }> {
    this.calls.push({ method: "get_state" })
    return Promise.resolve({ sessionId: `rpc-${this.routing++}`, sessionFile: this.engineActivePath ?? "" })
  }

  async getEntries(): Promise<{ entries: unknown[]; leafId: string | null }> {
    return { entries: [], leafId: null }
  }

  async prompt(): Promise<string> {
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
    return []
  }

  async getSessionStats(): Promise<Record<string, unknown>> {
    return {}
  }

  async getMedia(): Promise<unknown> {
    return { type: "image", data: "", mimeType: "image/png" }
  }
}

describe("运行时 fork→按 fork id 删除（走查实锤：删 fork 实删了源会话）", () => {
  test("fork 后 deleteSession(forkId) 删 fork 文件，源会话文件必须仍在", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-fork-test-"))
    try {
      const agentDir = join(root, "agent")
      mkdirSync(join(root, "proj"), { recursive: true })
      const mainPath = sessionFile(agentDir, MAIN_ID)
      const forkPath = sessionFile(agentDir, FORK_ID, mainPath)

      const rpc = new FakeEngineRpc(mainPath, forkPath)
      const fakeManager = {
        ensureRunning: async () => {},
        getClient: (_project: string) => rpc,
        getStatus: () => ({ state: "ready" }),
        onEvent: (_listener: (event: unknown) => void) => () => {},
        stop: async () => {},
        stopAll: async () => {},
      } as unknown as EngineProcessManager

      const registry = new EngineRuntimeRegistry(fakeManager, {
        listProjects: () => [PROJECT],
        agentDir,
      })

      // 从源会话 fork（重试语义）——引擎侧活跃已切到 fork
      const forked = await registry.forkSession(MAIN_ID, "entry-1", "before")
      expect(forked.id).toBe(FORK_ID)
      expect(forked.sessionPath).toBe(forkPath)

      // 用户在会话列表删 fork 行：DELETE /api/sessions/<forkId>
      await registry.deleteSession(FORK_ID)

      expect(existsSync(forkPath)).toBe(false)
      expect(existsSync(mainPath)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
