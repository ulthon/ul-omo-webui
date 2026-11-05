// 命令面契约（multi-session-parallel T3 / D11 退役定版）：项目级「当前会话」单槽
// 不存在后，2026-11-04 的「未起即 ensure 拉起 + 垫最新会话路由」失去载体，命令面
// 回归 EngineGateway 契约原文——遍历项目内全部就绪会话引擎取首个绑定会话已 open
// 的命令；不 ensure 不 spawn；无就绪引擎/全部无活跃会话/引擎异常一律降级 null
//（端点 available=false），不 5xx。装配沿 runtime-compact.test.ts 模式。
import { describe, expect, test } from "vitest"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineProcessManager } from "../src/engine/process-manager"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"

const PROJECT = "/data/projects/senpi-webui"
const REAL_SESSION_DIR = "/root/.omo/agent/sessions/--data-projects-senpi-webui--"

class FakeEngineRpc {
  commandsCalls = 0
  openedPaths: string[] = []
  commandsError: Error | null = null

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
    this.openedPaths.push(path)
    return { sessionId: `rpc-${this.openedPaths.length}`, state: { sessionId: `rpc-${this.openedPaths.length}`, sessionFile: path } }
  }
  async closeSession(): Promise<void> {}
  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return []
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
  async getEntries(): Promise<{ entries: unknown[]; leafId: string | null }> {
    return { entries: [], leafId: null }
  }
  async getState(): Promise<Record<string, unknown>> {
    return {}
  }
  async getCommands(): Promise<Array<Record<string, unknown>>> {
    this.commandsCalls += 1
    if (this.commandsError) throw this.commandsError
    return [
      { name: "init", description: "初始化", source: "extension" },
      { name: "skill:browser", description: "浏览器", source: "skill" },
      { name: "daily", description: "日报", source: "prompt" },
    ]
  }
}

function makeRegistry(
  rpcOrRpcs: FakeEngineRpc | Map<string, FakeEngineRpc>,
  agentDir: string,
): { registry: EngineRuntimeRegistry; ensureRunningCalls: () => number } {
  const rpcs = rpcOrRpcs instanceof Map ? rpcOrRpcs : null
  const single = rpcs === null ? rpcOrRpcs : null
  let ensureRunningCalls = 0
  const fakeManager = {
    ensureRunning: async () => {
      ensureRunningCalls += 1
    },
    getClient: (sessionPath: string) => (rpcs !== null ? rpcs.get(sessionPath) : single),
    getStatus: () => ({ state: "ready", pendingPermissions: [] }),
    onEvent: (_listener: (event: unknown) => void) => () => {},
    stop: async () => {},
    stopAll: async () => {},
  } as unknown as EngineProcessManager
  const registry = new EngineRuntimeRegistry(fakeManager, {
    listProjects: () => [PROJECT],
    agentDir,
    // 收尾监视轮询远长于测试生命期：用例结算不依赖真实时序
    settlePollMs: 3_600_000,
  })
  return { registry, ensureRunningCalls: () => ensureRunningCalls }
}

/** 从真实会话库拷两个文件到临时库（cwd 过滤需真实 cwd），新者 mtime 晚 */
function seedSessions(agentDir: string): { older: string; newer: string } {
  const dir = join(agentDir, "sessions", "--data-projects-senpi-webui--")
  mkdirSync(dir, { recursive: true })
  const reals = readdirSync(REAL_SESSION_DIR).filter((f) => f.endsWith(".jsonl")).sort()
  if (reals.length < 2) throw new Error("真实会话库样本不足")
  const older = join(dir, reals[0]!)
  const newer = join(dir, reals[1]!)
  copyFileSync(join(REAL_SESSION_DIR, reals[0]!), older)
  copyFileSync(join(REAL_SESSION_DIR, reals[1]!), newer)
  const t = Date.now() / 1000
  utimesSync(older, t - 100, t - 100)
  utimesSync(newer, t, t)
  return { older, newer }
}

describe("命令面契约（T3 退役定版）", () => {
  test("无绑定引擎：降级 null 且不触发 spawn（不 ensure）", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-cmds-test-"))
    try {
      const agentDir = join(root, "agent")
      mkdirSync(agentDir, { recursive: true })
      const rpc = new FakeEngineRpc()
      const { registry, ensureRunningCalls } = makeRegistry(rpc, agentDir)

      expect(await registry.commandsList(PROJECT)).toBeNull()
      expect(rpc.commandsCalls).toBe(0)
      expect(ensureRunningCalls()).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("无就绪引擎（项目有会话但从未驱动）：降级 null 不 spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-cmds-test-"))
    try {
      const agentDir = join(root, "agent")
      seedSessions(agentDir)
      const rpc = new FakeEngineRpc()
      const { registry, ensureRunningCalls } = makeRegistry(rpc, agentDir)

      expect(await registry.commandsList(PROJECT)).toBeNull()
      expect(rpc.commandsCalls).toBe(0)
      expect(ensureRunningCalls()).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("有就绪引擎且绑定会话已 open：直接取命令，不额外开仓", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-cmds-test-"))
    try {
      const agentDir = join(root, "agent")
      const { older, newer } = seedSessions(agentDir)
      const rpc = new FakeEngineRpc()
      const { registry, ensureRunningCalls } = makeRegistry(rpc, agentDir)

      // 先走一次 prompt 建绑定引擎（发送链路语义）：取 SDK 排序后的最新行 id
      const list = await registry.sessionsList(PROJECT)
      const receipt = await registry.prompt(list[0]!.id, { text: "hi" })
      expect(receipt.disposition).toBe("started")
      // ensure 的绑定 open 恰好一次，且来自种子会话
      expect(rpc.openedPaths.length, "paths=" + JSON.stringify(rpc.openedPaths)).toBe(1)
      expect([older, newer], "paths=" + JSON.stringify(rpc.openedPaths)).toContain(rpc.openedPaths[0])

      rpc.openedPaths.length = 0
      const rows = await registry.commandsList(PROJECT)
      expect(rows).not.toBeNull()
      expect(rows!.map((r) => r.name).sort(), "rows=" + JSON.stringify(rows)).toEqual(["daily", "init", "skill:browser"])
      // 命令面不再垫路由：零新 open、零 ensure
      expect(rpc.openedPaths).toEqual([])
      expect(rpc.commandsCalls).toBe(1)
      expect(ensureRunningCalls()).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("多就绪引擎：单引擎命令异常继续尝试其余引擎，全失败降级 null", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-cmds-test-"))
    try {
      const agentDir = join(root, "agent")
      const paths = seedSessions(agentDir)
      const rpcs = new Map<string, FakeEngineRpc>()
      rpcs.set(paths.older, new FakeEngineRpc())
      rpcs.set(paths.newer, new FakeEngineRpc())
      const { registry } = makeRegistry(rpcs, agentDir)

      // 两个会话各自建绑定引擎（跨会话并行驱动的 T3 形态）
      const list = await registry.sessionsList(PROJECT)
      for (const row of list) {
        await registry.prompt(row.id, { text: "hi" })
      }
      // 首个被遍历的引擎命令失败：降级链应跳过它取另一个（不确定 Map 序，两引擎各断一半）
      rpcs.get(paths.older)!.commandsError = new Error("engine boom")
      const rows = await registry.commandsList(PROJECT)
      expect(rows).not.toBeNull()
      expect(rows!.map((r) => r.name).sort()).toEqual(["daily", "init", "skill:browser"])
      expect(rpcs.get(paths.older)!.commandsCalls).toBe(1)
      expect(rpcs.get(paths.newer)!.commandsCalls).toBe(1)

      // 全失败降级 null
      rpcs.get(paths.newer)!.commandsError = new Error("engine boom again")
      expect(await registry.commandsList(PROJECT)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
