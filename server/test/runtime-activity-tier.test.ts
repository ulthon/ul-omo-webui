/**
 * 任务 7（C4-B）prompt 回执钩子回归：ProjectRuntime.prompt 成功回执必调
 * manager.markUserActivity（引擎转正常档，脱离 5 分钟探活窗）；失败回执不翻档。
 * 覆盖三种成功形态（普通回合 started / 斜杠命令 handled / 排队 queued）与失败形态。
 * 装配沿 runtime-active-reopen.test.ts 模式（自足 fixture，不依赖真实会话库）。
 */
import { describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { EngineProcessManager } from "../src/engine/process-manager"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"
import { encodeCwdToSessionDirName } from "../src/adapter/senpi-adapter"

const PROJECT = "/tmp/opencode/rt-activity-proj"
const DURABLE_ID = "01c44444-0000-7000-8000-00000000000a"
/** store 行可解析的合法会话文件体（header.timestamp + 带时间戳条目；同
 *  runtime-active-reopen 先例，缺一则 sessionsList 映射抛 Invalid time value） */
const SESSION_FILE_BODY =
  JSON.stringify({ type: "session", version: 3, id: DURABLE_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: PROJECT }) +
  "\n" +
  JSON.stringify({ type: "message", id: "e1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } }) +
  "\n"

/** fake 引擎 RPC：prompt 可编程成功/失败与 disposition；openSession 规范应答 */
class FakeActivityRpc {
  promptCalls = 0
  promptShouldFail = false
  disposition = "started"

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async setClientInfo(): Promise<void> {}
  async send(): Promise<{ success: boolean }> {
    return { success: true }
  }
  async openSession(options: { sessionPath?: string }): Promise<{
    sessionId: string
    state: { sessionId: string; sessionFile?: string }
  }> {
    const path = options.sessionPath ?? ""
    return { sessionId: "rpc-1", state: { sessionId: DURABLE_ID, sessionFile: path } }
  }
  async closeSession(): Promise<void> {}
  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return []
  }
  async prompt(): Promise<string> {
    this.promptCalls += 1
    if (this.promptShouldFail) throw new Error("engine boom")
    return this.disposition
  }
  async abort(): Promise<void> {}
  onEvent(): () => void {
    return () => {}
  }
  async sendExtensionUIResponse(): Promise<void> {}
  async getAvailableModels(): Promise<unknown[]> {
    return []
  }
  async getEntries(): Promise<{ entries: unknown[]; leafId: string | null }> {
    return { entries: [], leafId: null }
  }
  async getState(): Promise<Record<string, unknown>> {
    return {}
  }
}

function makeRegistry(rpc: FakeActivityRpc, agentDir: string): {
  registry: EngineRuntimeRegistry
  /** markUserActivity 钩子实录（断言源） */
  marks: string[]
  sessionPath: string
} {
  const sessionPath = join(agentDir, "sessions", encodeCwdToSessionDirName(PROJECT), `${DURABLE_ID}.jsonl`)
  const marks: string[] = []
  const fakeManager = {
    ensureRunning: async () => {},
    getClient: (_key: string) => rpc,
    getStatus: () => ({ state: "ready" }),
    onEvent: (_listener: (event: unknown) => void) => () => {},
    stop: async () => {},
    stopAll: async () => {},
    reportSessionActive: (_sessionPath: string, _sessionId: string): void => {},
    // 任务 7 钩子：真管理器的探活窗翻档口，此处实录调用供断言
    markUserActivity: (sessionPath: string): void => {
      marks.push(sessionPath)
    },
  } as unknown as EngineProcessManager
  const registry = new EngineRuntimeRegistry(fakeManager, {
    listProjects: () => [PROJECT],
    agentDir,
    // 收尾监视轮询远长于测试生命期：用例结算不依赖真实时序
    settlePollMs: 3_600_000,
  })
  return { registry, marks, sessionPath }
}

function setup(rpc = new FakeActivityRpc()): {
  root: string
  agentDir: string
  sessionPath: string
  rpc: FakeActivityRpc
  registry: EngineRuntimeRegistry
  marks: string[]
} {
  const root = mkdtempSync(join(tmpdir(), "rt-activity-test-"))
  const agentDir = join(root, "agent")
  const sessionPath = join(agentDir, "sessions", encodeCwdToSessionDirName(PROJECT), `${DURABLE_ID}.jsonl`)
  mkdirSync(dirname(sessionPath), { recursive: true })
  writeFileSync(sessionPath, SESSION_FILE_BODY)
  const { registry, marks } = makeRegistry(rpc, agentDir)
  return { root, agentDir, sessionPath, rpc, registry, marks }
}

describe("prompt 回执钩子（任务 7：markUserActivity 翻正常档）", () => {
  test("普通回合回执（started）：markUserActivity 恰一次、携引擎键 sessionPath", async () => {
    const ctx = setup()
    try {
      const receipt = await ctx.registry.prompt(DURABLE_ID, { text: "hi" })
      expect(receipt.disposition).toBe("started")
      expect(ctx.marks).toEqual([ctx.sessionPath])
    } finally {
      rmSync(ctx.root, { recursive: true, force: true })
    }
  })

  test("斜杠命令回执（handled，无回合）：同样翻档（发过消息即算）", async () => {
    const rpc = new FakeActivityRpc()
    rpc.disposition = "handled"
    const ctx = setup(rpc)
    try {
      const receipt = await ctx.registry.prompt(DURABLE_ID, { text: "/help" })
      expect(receipt.disposition).toBe("handled")
      expect(ctx.marks).toEqual([ctx.sessionPath])
    } finally {
      rmSync(ctx.root, { recursive: true, force: true })
    }
  })

  test("排队回执（streamingBehavior，回合中入队）：同样翻档", async () => {
    const ctx = setup()
    try {
      const receipt = await ctx.registry.prompt(DURABLE_ID, { text: "排队追问", streamingBehavior: "steer" })
      expect(receipt.disposition).toBe("started")
      expect(ctx.marks).toEqual([ctx.sessionPath])
    } finally {
      rmSync(ctx.root, { recursive: true, force: true })
    }
  })

  test("prompt 失败：不翻档（marks 空）且错误原样上抛", async () => {
    const rpc = new FakeActivityRpc()
    rpc.promptShouldFail = true
    const ctx = setup(rpc)
    try {
      await expect(ctx.registry.prompt(DURABLE_ID, { text: "boom" })).rejects.toThrow("engine boom")
      expect(ctx.marks).toEqual([])
    } finally {
      rmSync(ctx.root, { recursive: true, force: true })
    }
  })
})
