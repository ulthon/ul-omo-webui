/**
 * 模型切换可观测（docs08-r6 任务 8 ①②）运行时层单测：
 * - ① switchModel 显式取 client：引擎未挂（wrappedClient null，ensure 前的天然初态）
 *   必抛 ApiError(503, "engine_not_ready")——原可选链写法会静默跳过，模型切换无声
 *   失效而 prompt 照发旧模型。断言走生产 switchModel（ProjectRuntime 私有方法经
 *   runtimeFor 构造的真实实例直调，非测试专用分支），forkSession 同款范式。
 * - ② prompt 携带 model：setModel 成功回模型行（SDK 契约 {provider,id}）→ 回执
 *   appliedModel = "provider/model" 归一；经 registry 公共面全链（switchTo → setModel
 *   → adapter.prompt → 回执合并），FakeEngineRpc 记录 setModel 调用参数。
 */
import { describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineProcessManager } from "../src/engine/process-manager"
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
    getClient: (_project: string) => rpc,
    getStatus: () => ({ state: "ready" }),
    onEvent: (_listener: (event: unknown) => void) => () => {},
    stop: async () => {},
    stopAll: async () => {},
  } as unknown as EngineProcessManager
}

describe("模型切换可观测（docs08-r6 任务 8）", () => {
  test("① switchModel 引擎未挂：503 engine_not_ready（显式拒绝，非静默跳过）", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-model-503-"))
    try {
      const agentDir = join(root, "agent")
      mkdirSync(join(root, "proj"), { recursive: true })

      const registry = new EngineRuntimeRegistry(fakeManagerWith(new FakeEngineRpc()), {
        listProjects: () => [PROJECT],
        agentDir,
      })
      // 生产 runtimeFor 构造真实 ProjectRuntime（未 ensure 的天然初态：wrappedClient null），
      // 直调生产 switchModel——503 必须来自该方法本体，而非测试专用分支
      const rt = (
        registry as unknown as {
          runtimeFor: (project: string) => { switchModel(model: string): Promise<{ provider: string; id: string }> };
        }
      ).runtimeFor(PROJECT)

      await expect(rt.switchModel("zai-coding-cn/glm-4.7")).rejects.toMatchObject({
        status: 503,
        code: "engine_not_ready",
      })
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
