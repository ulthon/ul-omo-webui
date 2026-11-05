// multi-session-parallel T3 会话路由重建最小并行证明（T8 集成证明的前置切片）。
// 覆盖对抗面：
// - misleading_success_output：两会话 prompt 并发在途（Promise.all 真并发进入运行时，
//   非顺序注册后假装并行），peekRunStates 同帧双行 running；
// - cancel_resume：abort 只作用目标会话——兄弟会话 rpc 零 abort 帧、回合行与权限
//   挂起均不受扰；
// - mid_operation_interrupts：A 引擎 process_crashed 按 sessionPath 路由，只 A 合成
//   收尾（reason:"engine_crash"），B 回合不受扰；
// - 同会话二发纪律（CLI 同构）：无 streamingBehavior 409 already_processing；带则
//   入队回执 queued。
// 确定性：结算一律走事件回声/管理器事件注入，settlePollMs 拉满测试生命期，禁真睡。
import { describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineProcessManager } from "../src/engine/process-manager"
import { ApiError } from "../src/api/http"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"

const PROJECT = "/tmp/opencode/rt-session-routing-proj"
const SESSIONS_DIR_NAME = `--${PROJECT.replace(/^\//, "").replaceAll("/", "-")}--`
const SESSION_A = "01c11151-9a2b-7c01-8d3e-952b49731ea1"
const SESSION_B = "01c11151-9a2b-7c01-8d3e-952b49731eb2"

function sessionFile(agentDir: string, id: string): string {
  const dir = join(agentDir, "sessions", SESSIONS_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `2026-11-01T00-00-00-000Z_${id}.jsonl`)
  writeFileSync(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-11-01T00:00:00.000Z",
      cwd: PROJECT,
    })}\n`,
    "utf8",
  )
  return path
}

/** fake 单会话引擎 RPC：每会话一台（T1 键迁移），调用日志按发生序记录。
 *  handle 用文件级唯一序号：真实引擎 handle 是进程内唯一 UUID 跨引擎不冲突，
 *  fake 若各从 1 起号会同名冲突，并发注册序抖动时 durableSessionIdFor 扫到兄弟
 *  引擎同名 handle，配对校验正确拒绝误归属——那是 fixture 缺陷不是实现缺陷。 */
let rpcHandleSeq = 0
class FakeEngineRpc {
  readonly journal: string[] = []
  readonly handles: string[] = []
  private readonly listeners: Array<(event: unknown) => void> = []

  constructor(readonly sessionPath: string) {}

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
    const handle = `rpc-${++rpcHandleSeq}`
    this.handles.push(handle)
    return { sessionId: handle, state: { sessionId: handle, sessionFile: options.sessionPath ?? this.sessionPath } }
  }

  async closeSession(): Promise<void> {}

  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return [
      { sessionId: "rpc-1", durableSessionId: this.durableId, sessionPath: this.sessionPath, cwd: PROJECT, status: "open" },
    ]
  }

  /** durable id 由测试按会话文件注入（listSessions 行权威来源同 abort 套件口径） */
  durableId = ""

  async prompt(_message: string, options?: { streamingBehavior?: string }): Promise<string> {
    this.journal.push(options?.streamingBehavior ? "prompt:queued" : "prompt:started")
    return options?.streamingBehavior ? "queued" : "started"
  }

  async abort(): Promise<void> {
    this.journal.push("abort")
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const i = this.listeners.indexOf(listener)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  /** 测试注入引擎回声帧 */
  emit(event: unknown): void {
    for (const fn of [...this.listeners]) fn(event)
  }

  async sendExtensionUIResponse(response: Record<string, unknown>): Promise<void> {
    this.journal.push(`deny:${String(response.id)}`)
  }

  async getAvailableModels(): Promise<unknown[]> {
    return []
  }
  async getEntries(): Promise<{ entries: unknown[]; leafId: string | null }> {
    return { entries: [], leafId: null }
  }
  async getState(): Promise<Record<string, unknown>> {
    return {}
  }
  async getSteeringMessages(): Promise<unknown> {
    return []
  }
  async getFollowUpMessages(): Promise<unknown> {
    return []
  }
  async clearQueue(): Promise<unknown> {
    return { steering: [], followUp: [], ordered: [] }
  }
}

/** fake 管理器：按 sessionPath 键解析引擎（T1 键迁移形态），事件监听可注入管理器事件 */
class FakeManager {
  readonly rpcs = new Map<string, FakeEngineRpc>()
  readonly pendingPermissions = new Map<string, string[]>()
  readonly answered: Array<{ sessionPath: string; requestId: string }> = []
  private readonly listeners: Array<(event: unknown) => void> = []

  ensureRunning = async (): Promise<void> => {}
  getClient = (sessionPath: string) => this.rpcs.get(sessionPath)
  getStatus = (sessionPath: string): { state: "ready"; pendingPermissions: string[] } => ({
    state: "ready",
    pendingPermissions: [...(this.pendingPermissions.get(sessionPath) ?? [])],
  })
  reportPermissionAnswered = (sessionPath: string, requestId: string): void => {
    this.answered.push({ sessionPath, requestId })
    this.pendingPermissions.set(
      sessionPath,
      (this.pendingPermissions.get(sessionPath) ?? []).filter((id) => id !== requestId),
    )
  }
  /** 任务 6 扇出点亮面（真管理器上报口；本套件不断言其副作用，空实现即可） */
  reportSessionActive = (_sessionPath: string, _sessionId: string): void => {}
  markUserActivity = (_sessionPath: string): void => {}
  onEvent = (listener: (event: unknown) => void): (() => void) => {
    this.listeners.push(listener)
    return () => {
      const i = this.listeners.indexOf(listener)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }
  /** 测试注入管理器事件（process_crashed 等） */
  emit(event: unknown): void {
    for (const fn of [...this.listeners]) fn(event)
  }
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "rt-session-routing-test-"))
  try {
    const agentDir = join(root, "agent")
    mkdirSync(join(root, "proj"), { recursive: true })
    const pathA = sessionFile(agentDir, SESSION_A)
    const pathB = sessionFile(agentDir, SESSION_B)
    const rpcA = new FakeEngineRpc(pathA)
    const rpcB = new FakeEngineRpc(pathB)
    rpcA.durableId = SESSION_A
    rpcB.durableId = SESSION_B
    const manager = new FakeManager()
    manager.rpcs.set(pathA, rpcA)
    manager.rpcs.set(pathB, rpcB)
    const synthetic: Array<Record<string, unknown>> = []
    const settled: Array<{ sessionId: string; sessionPath: string; reason: string }> = []
    const registry = new EngineRuntimeRegistry(manager as unknown as EngineProcessManager, {
      listProjects: () => [PROJECT],
      agentDir,
      settlePollMs: 3_600_000,
      publishSyntheticEvent: (_project, event) => {
        synthetic.push(event)
      },
      onRoundSettled: (_project, info, reason) => {
        settled.push({ sessionId: info.sessionId, sessionPath: info.sessionPath, reason })
      },
    })
    return { root, manager, rpcA, rpcB, pathA, pathB, registry, synthetic, settled }
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    throw err
  }
}

describe("会话路由重建：跨会话并行与会话内单回合纪律（T3 最小并行证明）", () => {
  test("两会话并发 prompt：真并发在途，peekRunStates 同帧双行 running", async () => {
    const { root, registry, pathA, pathB } = await setup()
    try {
      // 真并发进入运行时（非顺序注册）：两回合行同时存在才算过
      const [ra, rb] = await Promise.all([
        registry.prompt(SESSION_A, { text: "A 回合" }),
        registry.prompt(SESSION_B, { text: "B 回合" }),
      ])
      expect(ra.disposition).toBe("started")
      expect(rb.disposition).toBe("started")

      const states = await registry.peekRunStates(PROJECT)
      expect(states).not.toBeNull()
      expect([...states!.keys()].sort()).toEqual([pathA, pathB].sort())
      expect(states!.get(pathA)).toBe("running")
      expect(states!.get(pathB)).toBe("running")

      const paths = await registry.peekActiveSessionPaths(PROJECT)
      expect(paths).not.toBeNull()
      expect([...paths!].sort()).toEqual([pathA, pathB].sort())
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("A 落定后 B 仍 running：结算按引擎归属，onRoundSettled 只收 A", async () => {
    const s = await setup()
    const { root, rpcA, registry, pathA, pathB, settled } = s
    try {
      await Promise.all([
        registry.prompt(SESSION_A, { text: "A 回合" }),
        registry.prompt(SESSION_B, { text: "B 回合" }),
      ])

      // A 引擎回声 agent_end（wire handle 归属）→ 仅 A 结算
      rpcA.emit({ type: "agent_end", sessionId: rpcA.handles[0] })

      expect(settled).toEqual([{ sessionId: SESSION_A, sessionPath: pathA, reason: "agent_end" }])
      const states = await registry.peekRunStates(PROJECT)
      expect(states).not.toBeNull()
      expect([...states!.keys()]).toEqual([pathB])
      expect(states!.get(pathB)).toBe("running")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("abort 只作用目标会话：A 的挂起权限被消费，B 的回合/rpc/权限零受扰", async () => {
    const s = await setup()
    const { root, manager, rpcA, rpcB, pathA, pathB, registry } = s
    try {
      await Promise.all([
        registry.prompt(SESSION_A, { text: "A 回合" }),
        registry.prompt(SESSION_B, { text: "B 回合" }),
      ])
      manager.pendingPermissions.set(pathA, ["perm-A"])
      manager.pendingPermissions.set(pathB, ["perm-B"])
      const journalBBefore = rpcB.journal.length

      await registry.abort(SESSION_A)

      // 仅 A 消费挂起权限（deny + 解忙），B 的 rpc 在 abort 阶段零新增帧、权限挂起原样
      expect(rpcA.journal).toEqual(["prompt:started", "deny:perm-A", "abort"])
      expect(rpcB.journal.length).toBe(journalBBefore)
      expect(manager.answered).toEqual([{ sessionPath: pathA, requestId: "perm-A" }])
      expect(manager.pendingPermissions.get(pathB)).toEqual(["perm-B"])
      // B 回合行不受扰：仍在表且因权限挂起压制为 waiting（回合行与权限双完好的强断言）
      const states = await registry.peekRunStates(PROJECT)
      expect(states!.get(pathB)).toBe("waiting")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("同会话二发纪律：无 streamingBehavior 409 already_processing；带则入队 queued", async () => {
    const s = await setup()
    const { root, rpcB, registry, pathB } = s
    try {
      await registry.prompt(SESSION_B, { text: "B 第一发" })

      // 无 streamingBehavior：409 already_processing（不等引擎守卫）
      const err = await registry.prompt(SESSION_B, { text: "B 第二发" }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(409)
      expect((err as ApiError).code).toBe("already_processing")

      // 带 streamingBehavior：放行入队，回执 queued（CLI 同构会话内排队）
      const queued = await registry.prompt(SESSION_B, { text: "B 排队", streamingBehavior: "steer" })
      expect(queued.disposition).toBe("queued")
      expect(rpcB.journal).toEqual(["prompt:started", "prompt:queued"])

      // 排队回合不新增行：仍只 B 一行 running（同一 run，run 尾才 settle 一次）
      const states = await registry.peekRunStates(PROJECT)
      expect([...states!.keys()]).toEqual([pathB])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("A 引擎 crash 按 sessionPath 路由：只 A 合成收尾，B 回合不受扰（mid_operation_interrupts）", async () => {
    const s = await setup()
    const { root, manager, registry, pathA, pathB, synthetic, settled } = s
    try {
      await Promise.all([
        registry.prompt(SESSION_A, { text: "A 回合" }),
        registry.prompt(SESSION_B, { text: "B 回合" }),
      ])

      manager.emit({ type: "process_crashed", projectPath: PROJECT, sessionPath: pathA })

      // 只 A 合成收尾（engine_crash），B 无合成帧；crashSettle 排除 onRoundSettled
      expect(synthetic).toEqual([
        { type: "agent_settled", synthetic: true, sessionId: SESSION_A, reason: "engine_crash" },
      ])
      expect(settled).toEqual([])
      const states = await registry.peekRunStates(PROJECT)
      expect(states).not.toBeNull()
      expect([...states!.keys()]).toEqual([pathB])
      expect(states!.get(pathB)).toBe("running")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
