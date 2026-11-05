/**
 * 模型切换可观测（docs08-r6 任务 8 ①②）运行时层单测：
 * - ① 引擎未挂：503 engine_not_ready 前置到 ensure「有界等待就绪」绑定环（T3 新
 *   语义：switchModel 只在 ensure 成功后可达，绑定环走满硬截止显式拒绝）——带
 *   model 的 prompt 整体被拒、setModel 零调用，模型切换不得无声失效。fake timers
 *   异步推进绑定环走完 deadline，零真实等待。
 * - ② prompt 携带 model：setModel 成功回模型行（SDK 契约 {provider,id}）→ 回执
 *   appliedModel = "provider/model" 归一；经 registry 公共面全链（switchTo → setModel
 *   → adapter.prompt → 回执合并），FakeEngineRpc 记录 setModel 调用参数。
 */
import { describe, expect, test, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineProcessManager } from "../src/engine/process-manager"
import { ApiError } from "../src/api/http"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"

const PROJECT = "/tmp/opencode/rt-model-switch-proj"
const SESSIONS_DIR_NAME = `--${PROJECT.replace(/^\//, "").replaceAll("/", "-")}--`

const MAIN_ID = "01a11151-49f9-7fb0-a845-952b49731e54"

/** header v3 形态照 server/test/fixtures/protocol/fork-header.json 实录 */
function sessionFile(agentDir: string, id: string): string {
  const dir = join(agentDir, "sessions", SESSIONS_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `2026-10-06T12-48-59-587Z_${id}.jsonl`)
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-06T12:48:59.587Z", cwd: PROJECT })}\n`, "utf8")
  return path
}

/**
 * fake 引擎 RPC 面（runtime-fork.test.ts 同款 + setModel 回模型行）：
 * setModel 记录调用并回 {provider,id}（SDK setModel 契约形态）。
 */
class FakeEngineRpc {
  setModelCalls: Array<{ provider: string; modelId: string }> = []

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
    return { sessionId: "rpc-1", state: { sessionId: "rpc-1", sessionFile: options.sessionPath } }
  }

  async closeSession(): Promise<void> {}

  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return []
  }

  async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
    this.setModelCalls.push({ provider, modelId })
    return { provider, id: modelId }
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

function fakeManagerWith(rpc: FakeEngineRpc | null): EngineProcessManager {
  return {
    ensureRunning: async () => {},
    // 真实管理器无引擎时 getClient 回 undefined（ensure 绑定环按 undefined 判定）
    getClient: (_project: string) => rpc ?? undefined,
    getStatus: () => ({ state: "ready" }),
    onEvent: (_listener: (event: unknown) => void) => () => {},
    stop: async () => {},
    stopAll: async () => {},
  } as unknown as EngineProcessManager
}

describe("模型切换可观测（docs08-r6 任务 8）", () => {
  test("① 引擎未挂：ensure 绑定环 503 engine_not_ready（显式拒绝，setModel 零调用）", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-model-503-"))
    try {
      const agentDir = join(root, "agent")
      mkdirSync(join(root, "proj"), { recursive: true })
      sessionFile(agentDir, MAIN_ID)

      // 真实定时器预热：先带引擎完成一次绑定（会话解析/活跃行 fs 全部落在 fake
      // 窗口外——Bun 下 fake timers 与异步 fs 派发互斥，探针实证）
      let activeClient: FakeEngineRpc | undefined = new FakeEngineRpc()
      const rpc = activeClient
      const fakeManager = {
        ensureRunning: async () => {},
        getClient: () => activeClient,
        getStatus: () => ({ state: "ready" }),
        onEvent: (_listener: (event: unknown) => void) => () => {},
        stop: async () => {},
        stopAll: async () => {},
      } as unknown as EngineProcessManager
      const registry = new EngineRuntimeRegistry(fakeManager, {
        listProjects: () => [PROJECT],
        agentDir,
      })
      await registry.prompt(MAIN_ID, { text: "warm" })

      // 引擎消失（getClient 缺位，不注入崩溃事件）：再次 prompt 先经既有绑定态
      // 的活跃行解析（零 fs），ensure 检出 client 更换弃置旧绑定态后进入
      // 「有界等待就绪」绑定环——T3 新语义下 503 在此处产生，switchModel 只在
      // ensure 成功后可达。fake timers 只 fake setTimeout/Date（绑定环全部依赖），
      // 小步推进保证 deadline 必被穿越，零真实等待。
      activeClient = undefined
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] })
      let settled = false
      const pending = registry
        .prompt(MAIN_ID, { text: "hi", model: "zai-coding-cn/glm-4.7" })
        .then(
          () => null,
          (e: unknown) => {
            settled = true
            return e
          },
        )
      for (let i = 0; i < 100 && !settled; i++) await vi.advanceTimersByTimeAsync(250)
      const err = await pending
      vi.useRealTimers()
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(503)
      expect((err as ApiError).code).toBe("engine_not_ready")
      expect(rpc.setModelCalls).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("② prompt 携带 model：setModel 回模型行 → 回执 appliedModel 归一 \"provider/model\"", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-model-applied-"))
    try {
      const agentDir = join(root, "agent")
      mkdirSync(join(root, "proj"), { recursive: true })
      sessionFile(agentDir, MAIN_ID)

      const rpc = new FakeEngineRpc()
      const registry = new EngineRuntimeRegistry(fakeManagerWith(rpc), {
        listProjects: () => [PROJECT],
        agentDir,
      })

      const receipt = await registry.prompt(MAIN_ID, { text: "hi", model: "zai-coding-cn/glm-4.7" })
      expect(rpc.setModelCalls).toEqual([{ provider: "zai-coding-cn", modelId: "glm-4.7" }])
      expect(receipt.disposition).toBe("started")
      expect(receipt.appliedModel).toBe("zai-coding-cn/glm-4.7")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("② prompt 未携带 model：不调 setModel、回执无 appliedModel 字段", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-model-nomodel-"))
    try {
      const agentDir = join(root, "agent")
      mkdirSync(join(root, "proj"), { recursive: true })
      sessionFile(agentDir, MAIN_ID)

      const rpc = new FakeEngineRpc()
      const registry = new EngineRuntimeRegistry(fakeManagerWith(rpc), {
        listProjects: () => [PROJECT],
        agentDir,
      })

      const receipt = await registry.prompt(MAIN_ID, { text: "hi" })
      expect(rpc.setModelCalls).toEqual([])
      expect(receipt.disposition).toBe("started")
      expect("appliedModel" in receipt).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
