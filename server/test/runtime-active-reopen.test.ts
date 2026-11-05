/**
 * 2026-11-06 02:52-02:53 事故回归（multi-session-parallel fix-active-gate）：
 * 1. runTraced no_active_session 兜底重开（修1）：开局竞态落败的 adapter（active=null）
 *    占住 engines 表后，requireActive() 在 adapter rpcOp 之外抛出旁路兜底——网关 op 经
 *    runTraced 自动同路径 openSession 一次并重试 body 一次，op 不抛（事故形态实录
 *    webui-2026-11-06.log seq 0239-0326：连环 no_active_session 33 秒直到用户刷新）。
 * 2. 重开失败按原样抛：重开 open_session 本身失败 → open_failed 上抛，不吞不换错，
 *    恰好一次重开尝试（无重试风暴）。
 * 3. ensure 在途合并（修2，02:52:50 seq 0190-0194 五路 in-flight 拒绝靶点）：就绪窗口
 *    内五个并发网关 op 共享同一次建 adapter+open_session（fake rpc.openSession/start
 *    恰好各 1 次），不再五路竞门；02:52:50 实录五路并发 ensure 各自建 adapter 五路
 *    open_session 被引擎 in-flight 守卫全数拒绝，落败 adapter 反占 engines 表。
 */
import { describe, expect, test, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { EngineProcessManager } from "../src/engine/process-manager"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"
import { encodeCwdToSessionDirName } from "../src/adapter/senpi-adapter"

const PROJECT = "/tmp/opencode/rt-reopen-proj"
const DURABLE_ID = "01c33333-0000-7000-8000-000000000007"
/** store 行可解析的合法会话文件体（header.timestamp + 一条带时间戳条目，缺一则
 *  SessionManager 行 created/modified 为 Invalid Date → sessionsList 映射抛
 *  Invalid time value，resolveSession 三级查找全灭——探针实证） */
const SESSION_FILE_BODY =
  JSON.stringify({ type: "session", version: 3, id: DURABLE_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: PROJECT }) +
  "\n" +
  JSON.stringify({ type: "message", id: "e1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } }) +
  "\n"

/** fake 引擎 RPC：openSession 计数；setClientInfo 可持锁（确定性就绪窗口：adapter.start()
 *  的就绪探测期间 engines 未置——wrapLifecycleClient 的 start 是 no-op 不委派，
 *  setClientInfo/send 才是真实委派面，延时门必须放在委派面上）；openShouldFail 注入
 *  重开必败形态（响应缺 sessionId → adapter 报 open_failed）；persistOnOpen 模拟
 *  真实引擎 open 即写盘（跨 registry 的 store 行发现用）。 */
class FakeReopenRpc {
  openCalls = 0
  holdSetClientInfo = false
  setClientInfoEntered = 0
  private holdResolve: (() => void) | null = null
  openShouldFail = false
  persistOnOpen = false
  private routing = 1
  private lastOpenPath = ""

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async setClientInfo(): Promise<void> {
    this.setClientInfoEntered += 1
    if (this.holdSetClientInfo) {
      await new Promise<void>((r) => {
        this.holdResolve = r
      })
    }
  }
  /** 放行持锁的 setClientInfo（测试确定性推进用） */
  releaseSetClientInfo(): void {
    this.holdResolve?.()
  }
  async send(): Promise<{ success: boolean }> {
    return { success: true }
  }
  async openSession(options: { sessionPath?: string }): Promise<{
    sessionId: string
    state: { sessionId: string; sessionFile?: string }
  }> {
    this.openCalls += 1
    if (this.openShouldFail) {
      return { sessionId: "", state: { sessionId: "", sessionFile: undefined } }
    }
    const path = options.sessionPath ?? ""
    this.lastOpenPath = path
    if (this.persistOnOpen && path) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, SESSION_FILE_BODY)
    }
    return { sessionId: `rpc-${this.routing++}`, state: { sessionId: DURABLE_ID, sessionFile: path } }
  }
  async closeSession(): Promise<void> {}
  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return [
      {
        sessionId: "rpc-1",
        sessionPath: this.lastOpenPath,
        cwd: PROJECT,
        status: "open",
        durableSessionId: DURABLE_ID,
      },
    ]
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

function makeRegistry(rpc: FakeReopenRpc, agentDir: string): EngineRuntimeRegistry {
  const fakeManager = {
    ensureRunning: async () => {},
    getClient: (_key: string) => rpc,
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

function setup(rpc = new FakeReopenRpc()): {
  root: string
  agentDir: string
  sessionPath: string
  rpc: FakeReopenRpc
  registry: EngineRuntimeRegistry
} {
  const root = mkdtempSync(join(tmpdir(), "rt-reopen-test-"))
  const agentDir = join(root, "agent")
  const sessionPath = join(agentDir, "sessions", encodeCwdToSessionDirName(PROJECT), `${DURABLE_ID}.jsonl`)
  mkdirSync(dirname(sessionPath), { recursive: true })
  writeFileSync(sessionPath, SESSION_FILE_BODY)
  return { root, agentDir, sessionPath, rpc, registry: makeRegistry(rpc, agentDir) }
}

/** 取当前绑定态（private 面运行期直读，仅测试注入事故形态用） */
function boundStateOf(
  registry: EngineRuntimeRegistry,
  sessionPath: string,
): { adapter: { active: unknown } } | undefined {
  const rt = (registry as unknown as { runtimes: Map<string, unknown> }).runtimes.get(PROJECT) as
    | { engines: Map<string, { adapter: { active: unknown } }> }
    | undefined
  return rt?.engines.get(sessionPath)
}

describe("runTraced no_active_session 兜底重开（2026-11-06 02:53 事故回归）", () => {
  test("active=null + lastSessionPath 在 → op 自动同路径重开并重试成功不抛", async () => {
    const { root, sessionPath, rpc, registry } = setup()
    try {
      // 首次正常：ensure 建 adapter 并 open 一次
      const page1 = await registry.messages(DURABLE_ID)
      expect(page1.entries).toEqual([])
      expect(rpc.openCalls).toBe(1)

      // 事故形态注入：adapter 绑定丢失（active=null；lastSessionPath 已由首次 open 备好）
      const st = boundStateOf(registry, sessionPath)
      expect(st).toBeDefined()
      st!.adapter.active = null

      // 修复前此处连环 no_active_session 33 秒；修复后单点兜底恰好重开一次并重试成功
      const page2 = await registry.messages(DURABLE_ID)
      expect(page2.entries).toEqual([])
      expect(rpc.openCalls).toBe(2)
      expect(st!.adapter.active).not.toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("重开本身失败 → open_failed 按原样上抛（不吞错不无限重试）", async () => {
    const { root, sessionPath, rpc, registry } = setup()
    try {
      await registry.messages(DURABLE_ID)
      expect(rpc.openCalls).toBe(1)

      // 注入重开必败形态（open_session 响应缺 sessionId → adapter 报 open_failed）
      rpc.openShouldFail = true
      const st = boundStateOf(registry, sessionPath)
      st!.adapter.active = null

      const err = await registry.messages(DURABLE_ID).then(
        () => {
          throw new Error("应当拒绝，不应成功")
        },
        (e: unknown) => e as { code?: string; message?: string },
      )
      expect(err.code).toBe("open_failed")
      // 恰好一次重开尝试：首开 1 次 + 兜底重开失败 1 次，无重试风暴
      expect(rpc.openCalls).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("ensure 在途合并（2026-11-06 02:52:50 五路 in-flight 竞门事故回归）", () => {
  test("就绪窗口内五个并发网关 op 共享同一次建 adapter+open_session", async () => {
    const { root, agentDir, rpc } = setup()
    try {
      // 先经 registryA createSession 落盘会话文件（persistOnOpen），换取跨 registry
      // 的 store 行：registryB 以空 engines 表冷解析同一会话
      rpc.persistOnOpen = true
      const registryA = makeRegistry(rpc, agentDir)
      const created = await registryA.createSession(PROJECT, {})
      expect(created.durable).toBe(true)
      expect(created.id).toBe(DURABLE_ID)

      // registryB：全新 runtimes/engines + 持锁 setClientInfo（确定性就绪窗口：
      // 窗口内 engines 未置，无合并时五路 ensure 各建 adapter 各入锁——02:52:50 事故形态）
      const rpcB = new FakeReopenRpc()
      rpcB.holdSetClientInfo = true
      const registryB = makeRegistry(rpcB, agentDir)
      const ops = [
        registryB.messages(DURABLE_ID),
        registryB.messages(DURABLE_ID),
        registryB.messages(DURABLE_ID),
        registryB.messages(DURABLE_ID),
        registryB.messages(DURABLE_ID),
      ]
      // 首路进入就绪窗口（确定性信号：委派面进入计数）
      await vi.waitFor(() => expect(rpcB.setClientInfoEntered).toBeGreaterThanOrEqual(1))
      // 有界静置：给其余四路到达时间（fs 解析链微秒级即可完成；无合并时它们
      // 会各建 adapter 并各自入锁，entered→5；合并时它们挂在在途 promise 上，entered 定格 1）
      await new Promise((r) => setTimeout(r, 50))
      rpcB.releaseSetClientInfo()
      const pages = await Promise.all(ops)
      expect(pages).toHaveLength(5)
      for (const page of pages) expect(page.entries).toEqual([])
      const rtB = (registryB as unknown as { runtimes: Map<string, { engines: Map<string, unknown> }> }).runtimes.get(PROJECT)
      // 合并生效：静置期恰好一次入锁 + 恰好一次 open + 恰好一个绑定态
      // （实录形态修复前：静置期 entered=5，释放后 open 为 5）
      expect(rpcB.setClientInfoEntered).toBe(1)
      expect(rpcB.openCalls).toBe(1)
      expect(rtB?.engines.size).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
