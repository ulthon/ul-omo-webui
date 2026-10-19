/**
 * docs08-r5 任务 8：手动压缩运行时链路（EngineRuntimeRegistry → ProjectRuntime →
 * SenpiAdapter → 协议面 compact）。覆盖：
 * 1. happy：压缩回执（tokensBefore/estimatedTokensAfter）+ 同锁内压缩后 usage 快照；
 * 2. 流式守卫：回合中 compact 409 already_processing（引擎 manual compact 会先中止
 *    当前回合，webui 语义下拒绝而非隐式中断）；
 * 3. 引擎失败形态映射："Already compacted" → 409 already_compacted；
 *    "Nothing to compact (session too small)" → 409 nothing_to_compact（spike 实证错误面）。
 * 路由层参数校验由 routes 层测试覆盖；本文件走真实 ProjectRuntime。
 */
import { describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineProcessManager } from "../src/engine/process-manager"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"
import { ApiError } from "../src/api/http"

const PROJECT = "/tmp/opencode/rt-compact-proj"
const SESSIONS_DIR_NAME = `--${PROJECT.replace(/^\//, "").replaceAll("/", "-")}--`
const SESSION_ID = "01c11141-49e9-7fb0-a845-952b49731e54"

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

/** fake 引擎 RPC 面：compact 记录调用并可编程应答；其余为 adapter 握手/活跃行最小面 */
class FakeEngineRpc {
  promptCalls = 0
  compactCalls = 0
  statsReadsAfterCompact = 0
  compactError: Error | null = null
  private routing = 1

  constructor(private readonly sessionPath: string) {}

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
    return { sessionId: handle, state: { sessionId: handle, sessionFile: options.sessionPath ?? this.sessionPath } }
  }

  async closeSession(): Promise<void> {}

  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return [
      { sessionId: "rpc-1", durableSessionId: SESSION_ID, sessionPath: this.sessionPath, cwd: PROJECT, status: "open" },
    ]
  }

  async prompt(): Promise<string> {
    this.promptCalls += 1
    return "started"
  }

  async compact(): Promise<unknown> {
    this.compactCalls += 1
    if (this.compactError) throw this.compactError
    return { summary: "压缩摘要", firstKeptEntryId: "entry-9", tokensBefore: 32881, estimatedTokensAfter: 9120 }
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
    // 压缩后水位下降可由调用方对比（此处固定形态，字段面按 mapUsageStats 容错）
    if (this.compactCalls > 0) this.statsReadsAfterCompact += 1
    return {
      sessionId: SESSION_ID,
      userMessages: 3,
      assistantMessages: 3,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 6,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0.01,
      contextUsage: { tokens: 9120, contextWindow: 1000000, percent: 0.912 },
    }
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
  } as unknown as EngineProcessManager
  return new EngineRuntimeRegistry(fakeManager, {
    listProjects: () => [PROJECT],
    agentDir,
  })
}

describe("手动压缩运行时链路（docs08-r5 任务 8）", () => {
  test("happy：压缩回执 + 同锁内压缩后 usage 快照", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-compact-test-"))
    try {
      const agentDir = join(root, "agent")
      mkdirSync(join(root, "proj"), { recursive: true })
      const rpc = new FakeEngineRpc(sessionFile(agentDir, SESSION_ID))
      const registry = makeRegistry(rpc, agentDir)

      const { result, usage } = await registry.compact(SESSION_ID)
      expect(rpc.compactCalls).toBe(1)
      expect(result).toEqual({ summary: "压缩摘要", firstKeptEntryId: "entry-9", tokensBefore: 32881, estimatedTokensAfter: 9120 })
      expect(usage.contextUsage?.tokens).toBe(9120)
      expect(rpc.statsReadsAfterCompact).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("回合中 compact 409 already_processing（引擎会先中止回合，webui 拒绝而非隐式中断）", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-compact-test-"))
    try {
      const agentDir = join(root, "agent")
      mkdirSync(join(root, "proj"), { recursive: true })
      const rpc = new FakeEngineRpc(sessionFile(agentDir, SESSION_ID))
      const registry = makeRegistry(rpc, agentDir)

      const receipt = await registry.prompt(SESSION_ID, { text: "流式回合" })
      expect(receipt.disposition).toBe("started")

      const err = await registry.compact(SESSION_ID).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(409)
      expect((err as ApiError).code).toBe("already_processing")
      expect(rpc.compactCalls).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("引擎失败形态映射：Already compacted / Nothing to compact → 409 业务码", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-compact-test-"))
    try {
      const agentDir = join(root, "agent")
      mkdirSync(join(root, "proj"), { recursive: true })
      const rpc = new FakeEngineRpc(sessionFile(agentDir, SESSION_ID))
      const registry = makeRegistry(rpc, agentDir)

      rpc.compactError = new Error("Already compacted")
      const e1 = await registry.compact(SESSION_ID).catch((e: unknown) => e)
      expect((e1 as ApiError).status).toBe(409)
      expect((e1 as ApiError).code).toBe("already_compacted")

      rpc.compactError = new Error("Nothing to compact (session too small)")
      const e2 = await registry.compact(SESSION_ID).catch((e: unknown) => e)
      expect((e2 as ApiError).status).toBe(409)
      expect((e2 as ApiError).code).toBe("nothing_to_compact")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
