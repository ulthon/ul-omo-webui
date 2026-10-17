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

/** fake 引擎 RPC 面：prompt 记录 (message, options)，其余为 adapter 握手/活跃行最小面 */
class FakeEngineRpc {
  promptCalls: Array<{ message: string; options?: { thinkingLevel?: string; images?: unknown } }> = []
  private routing = 1
  private readonly lowPath: string
  private readonly maxPath: string

  constructor(lowPath: string, maxPath: string) {
    this.lowPath = lowPath
    this.maxPath = maxPath
  }

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
    return { sessionId: handle, state: { sessionId: handle, sessionFile: options.sessionPath } }
  }

  async closeSession(): Promise<void> {}

  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return [
      { sessionId: "rpc-low", durableSessionId: LOW_ID, sessionPath: this.lowPath, cwd: PROJECT, status: "open" },
      { sessionId: "rpc-max", durableSessionId: MAX_ID, sessionPath: this.maxPath, cwd: PROJECT, status: "open" },
    ]
  }

  async prompt(message: string, options?: { thinkingLevel?: string; images?: unknown }): Promise<string> {
    this.promptCalls.push({ message, options })
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
}

describe("thinkingLevel 运行时透传（W2 todo 7）", () => {
  test("registry.prompt 的 thinkingLevel 到达 mock 引擎 RPC 的 prompt options；缺省为 undefined", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-thinking-test-"))
    try {
      const agentDir = join(root, "agent")
      mkdirSync(join(root, "proj"), { recursive: true })
      const lowPath = sessionFile(agentDir, LOW_ID)
      const maxPath = sessionFile(agentDir, MAX_ID)

      const rpc = new FakeEngineRpc(lowPath, maxPath)
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

      // low 档：RPC options 收到 thinkingLevel="low"
      const lowReceipt = await registry.prompt(LOW_ID, { text: "低档", thinkingLevel: "low" })
      expect(lowReceipt.disposition).toBe("started")
      expect(rpc.promptCalls[0]).toEqual({ message: "低档", options: { thinkingLevel: "low" } })

      // max 档（另一会话，避开单驱动 409）：options 逐回合生效
      await registry.prompt(MAX_ID, { text: "高档", thinkingLevel: "max" })
      expect(rpc.promptCalls[1]).toEqual({ message: "高档", options: { thinkingLevel: "max" } })

      // 缺省：options 不带 thinkingLevel（引擎用会话缺省档）
      await registry.prompt(LOW_ID, { text: "缺省" })
      expect(rpc.promptCalls[2].options).toEqual({})
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
