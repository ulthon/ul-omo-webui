/**
 * W2 todo 7：thinkingLevel 逐层透传证明（运行时层）。
 * 路由层（parse + 400）由 routes.test.ts 覆盖；本文件经 EngineRuntimeRegistry 公共面
 * 驱动真实 ProjectRuntime → SenpiAdapter → RPC options 链路，断言 mock 引擎 RPC 的
 * prompt 调用实际收到 per-prompt thinkingLevel（缺省时为 undefined，不猜档位）。
 * 两个会话各发一条：单驱动 409 只拦同会话并发回合，跨会话不触发。
 */
import { describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineProcessManager } from "../src/engine/process-manager"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"

const PROJECT = "/tmp/opencode/rt-thinking-proj"
const SESSIONS_DIR_NAME = `--${PROJECT.replace(/^\//, "").replaceAll("/", "-")}--`

const LOW_ID = "01b11141-49e9-7fb0-a845-952b49731e54"
const MAX_ID = "01b11142-98c3-71e3-a372-059ada7db4b0"

/** header v3 形态照 runtime-fork.test.ts 同款实录 */
function sessionFile(agentDir: string, id: string): string {
  const dir = join(agentDir, "sessions", SESSIONS_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `2026-10-12T00-00-00-000Z_${id}.jsonl`)
  writeFileSync(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-10-12T00:00:00.000Z",
      cwd: PROJECT,
    })}\n`,
    "utf8",
  )
  return path
}

/** fake 引擎 RPC 面（T3 路径键控：每会话一实例）：prompt 记录 (message, options)，
 * 其余为 adapter 握手/活跃行最小面；事件监听可注入收尾回声（结算用，禁真睡）。 */
class FakeEngineRpc {
  promptCalls: Array<{ message: string; options?: { thinkingLevel?: string; images?: unknown } }> = []
  readonly handles: string[] = []
  private readonly listeners: Array<(event: unknown) => void> = []

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
    const handle = `rpc-${this.handles.length + 1}`
    this.handles.push(handle)
    return { sessionId: handle, state: { sessionId: handle, sessionFile: options.sessionPath } }
  }

  async closeSession(): Promise<void> {}

  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return []
  }

  async prompt(message: string, options?: { thinkingLevel?: string; images?: unknown }): Promise<string> {
    this.promptCalls.push({ message, options })
    return "started"
  }

  async abort(): Promise<void> {}
  onEvent(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const i = this.listeners.indexOf(listener)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }
  /** 测试注入引擎回声帧（wire handle 归属结算） */
  emit(event: unknown): void {
    for (const fn of [...this.listeners]) fn(event)
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

describe("thinkingLevel 运行时透传（W2 todo 7）", () => {
  test("registry.prompt 的 thinkingLevel 到达 mock 引擎 RPC 的 prompt options；缺省为 undefined", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-thinking-test-"))
    try {
      const agentDir = join(root, "agent")
      mkdirSync(join(root, "proj"), { recursive: true })
      const lowPath = sessionFile(agentDir, LOW_ID)
      const maxPath = sessionFile(agentDir, MAX_ID)

      const lowRpc = new FakeEngineRpc()
      const maxRpc = new FakeEngineRpc()
      const rpcs = new Map([
        [lowPath, lowRpc],
        [maxPath, maxRpc],
      ])
      const fakeManager = {
        ensureRunning: async () => {},
        getClient: (sessionPath: string) => rpcs.get(sessionPath),
        getStatus: () => ({ state: "ready" }),
        onEvent: (_listener: (event: unknown) => void) => () => {},
        stop: async () => {},
        stopAll: async () => {},
        reportSessionActive: (_sessionPath: string, _sessionId: string): void => {},
      } as unknown as EngineProcessManager

      const registry = new EngineRuntimeRegistry(fakeManager, {
        listProjects: () => [PROJECT],
        agentDir,
      })

      // low 档：RPC options 收到 thinkingLevel="low"
      const lowReceipt = await registry.prompt(LOW_ID, { text: "低档", thinkingLevel: "low" })
      expect(lowReceipt.disposition).toBe("started")
      expect(lowRpc.promptCalls[0]).toEqual({ message: "低档", options: { thinkingLevel: "low" } })

      // max 档（另一会话）：options 逐回合生效
      await registry.prompt(MAX_ID, { text: "高档", thinkingLevel: "max" })
      expect(maxRpc.promptCalls[0]).toEqual({ message: "高档", options: { thinkingLevel: "max" } })

      // 首回合收尾（引擎回声按 wire handle 归属结算，禁真睡）：清 LOW 的在途回合行，
      // 缺省档才能对同会话再发（T3 单驱动按 sessionPath 键判定）
      lowRpc.emit({ type: "agent_end", sessionId: lowRpc.handles[0] })

      // 缺省：options 不带 thinkingLevel（引擎用会话缺省档）
      await registry.prompt(LOW_ID, { text: "缺省" })
      expect(lowRpc.promptCalls[1].options).toEqual({})
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
