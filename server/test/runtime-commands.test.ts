// 命令面与发送同等待遇（2026-11-04 用户定版）：引擎未起即 ensure 拉起；无活跃会话
// （missing_session_id 硬约束）时静默开本项目最新会话垫路由后返回全量；无会话可垫
// 或任一步失败按旧口径降级 null（端点不 5xx）。装配沿 runtime-compact.test.ts 模式。
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

/** 从真实会话库拷两个文件到临时库（cwd 过滤需真实 cwd），新者 mtime 晚（垫路由应选它） */
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

describe("命令面同等待遇（2026-11-04）", () => {
  test("无活跃会话：静默开最新会话垫路由并返回全量三段", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-cmds-test-"))
    try {
      const agentDir = join(root, "agent")
      const { older, newer } = seedSessions(agentDir)
      const rpc = new FakeEngineRpc()
      const registry = makeRegistry(rpc, agentDir)

      const rows = await registry.commandsList(PROJECT)
      expect(rows).not.toBeNull()
      expect(rows!.map((r) => r.name).sort(), "rows=" + JSON.stringify(rows)).toEqual(["daily", "init", "skill:browser"])
      // 哪个会话被垫开由 SDK 行的 modified（会话内容时间）决定，不强制两选一，只断言恰好开了一个且来自种子
      expect(rpc.openedPaths.length, "paths=" + JSON.stringify(rpc.openedPaths)).toBe(1)
      expect([older, newer], "paths=" + JSON.stringify(rpc.openedPaths)).toContain(rpc.openedPaths[0])
      expect(rpc.commandsCalls).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("已有活跃会话：不额外开垫，直接取命令", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-cmds-test-"))
    try {
      const agentDir = join(root, "agent")
      seedSessions(agentDir)
      const rpc = new FakeEngineRpc()
      const registry = makeRegistry(rpc, agentDir)

      // 先走一次 prompt 打开活跃会话（发送链路语义）：取 SDK 排序后的最新行 id
      const list = await registry.sessionsList(PROJECT)
      await registry.prompt(list[0]!.id, { text: "hi" }).catch(() => {})
      rpc.openedPaths.length = 0
      const rows = await registry.commandsList(PROJECT)
      expect(rows).not.toBeNull()
      expect(rpc.openedPaths).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("项目无会话可垫：降级 null 不抛错", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-cmds-test-"))
    try {
      const agentDir = join(root, "agent")
      mkdirSync(agentDir, { recursive: true })
      const rpc = new FakeEngineRpc()
      const registry = makeRegistry(rpc, agentDir)

      expect(await registry.commandsList(PROJECT)).toBeNull()
      expect(rpc.commandsCalls).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("get_commands 引擎异常：降级 null（端点不 5xx）", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-cmds-test-"))
    try {
      const agentDir = join(root, "agent")
      seedSessions(agentDir)
      const rpc = new FakeEngineRpc()
      rpc.commandsError = new Error("engine boom")
      const registry = makeRegistry(rpc, agentDir)

      expect(await registry.commandsList(PROJECT)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
