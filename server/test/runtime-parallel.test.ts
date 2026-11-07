// multi-session-parallel T8：同项目双会话并行集成证明（GAP-6 收口）。
// 与 T3 前置切片（runtime-session-routing.test.ts，FakeManager）不同：本套件走
// 真 EngineProcessManager（clientFactory 注入路径键控 fake 引擎 + MemProbe /proc
// 替身 + tmpdir 会话文件 harness，同 routes.test.ts 集成形态）+ 真
// EngineRuntimeRegistry，全链路 spawn→健康检查→试写门禁→绑定 open→回合路由。
// 六断言逐条独立（对抗 misleading_success_output，非合并真值）：
// ① 同项目两会话 ensure 后双引擎并存（engines Map 公共镜像两键、异 pid 异实例）
// ② 两会话同时 prompt 真并发（Promise.all，双 runningTurns 行）
// ③ A 回合进行中 B 发起不被 409（互斥按 sessionPath 判定，跨会话放行）
// ④ 同会话二发仍 409 already_processing（session_path_in_use 族结构化 409，IS-2）；
//   带 streamingBehavior 入队 queued（CLI 同构会话内排队）
// ⑤ A 引擎 crash 按 sessionPath 路由：仅 A 合成收尾（engine_crash），B 存活
// ⑥ 定向 stop(A)：A 进程关停、B 引擎行仍在且 B 回合不受扰
// 确定性（对抗 flaky_tests）：crash 一律走 supervisor pid 轮询 + 有界条件等待的
// 事件回声驱动，settlePollMs 拉满测试生命期，禁真睡。
import { afterEach, describe, expect, test, vi } from "vitest"

// 负载下 fork pool 启动风暴会冻结 worker：用例超时 30s（同 process-manager.test 纪律）
vi.setConfig({ testTimeout: 30_000 })
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EngineProcessManager,
  type EngineManagerEvent,
  type RpcClientEvent,
  type RpcClientOptions,
} from "../src/engine/process-manager"
import { MemProbe } from "./mocks"
import { ApiError } from "../src/api/http"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"
import { encodeCwdToSessionDirName } from "../src/adapter/senpi-adapter"
import { EventBus } from "../src/engine/events"
import {
  attachBackgroundTaskLedger,
  handleProjectEngineDeath,
  ledgerHasRunning,
  resetBackgroundTaskLedger,
} from "../src/api/background-task-ledger"
import { clearBackgroundStateCache, sessionBackgroundRunning } from "../src/api/background-tasks"

const SESSION_A = "01c11151-9a2b-7c01-8d3e-952b49731ea1"
const SESSION_B = "01c11151-9a2b-7c01-8d3e-952b49731eb2"

/** 路径键控 fake 引擎 RPC（T9 fixture 族形态 × routes.test 集成形态）：
 * clientFactory 每引擎一台实例；引擎键（sessionPath）由管理器绑定 open 帧告知
 * （spawn 参数只含项目 cwd，键迁移后引擎身份来自 open 认领）。handle 文件级唯一：
 * 真实引擎 handle 是进程内唯一标识跨引擎不冲突，fake 同名会在并发注册序抖动时被
 * durableSessionIdFor 扫到兄弟引擎误归属——那是 fixture 缺陷不是实现缺陷。 */
let rpcSeq = 0
class FakeEngineRpc {
  readonly spawnOpts: RpcClientOptions
  readonly handle: string
  readonly process: { pid: number }
  /** wire 调用日志（发生序）：prompt:started / prompt:queued / abort */
  readonly journal: string[] = []
  /** prompt 文本（路由正确性断言源，与 journal 形态分开记） */
  readonly prompts: string[] = []
  stopCount = 0
  /** get_state 的 isStreaming（true = 流式占用，settle 监视不合成；本套件无正常收尾） */
  fakeStreaming = true
  currentSessionPath: string | undefined
  private durableId: string | undefined
  private readonly listeners: Array<(event: RpcClientEvent) => void> = []

  constructor(
    spawnOpts: RpcClientOptions,
    private readonly probeRef: MemProbe,
  ) {
    this.spawnOpts = spawnOpts
    this.handle = `rpc-${++rpcSeq}`
    this.process = { pid: 50000 + rpcSeq }
  }

  get pid(): number {
    return this.process.pid
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.stopCount++
    // stop 即进程退出（探针摘除 pid）：shutdownProcess 的 waitForExit 立即见死，不空等宽限
    this.probeRef.procs.delete(this.pid)
  }
  setClientInfo(): Promise<void> {
    return Promise.resolve()
  }
  getStderr(): string {
    return ""
  }

  async send(message: unknown): Promise<{ success: boolean; data: unknown }> {
    const wire = message as { type?: string; sessionPath?: string }
    if (wire.type === "open_session") {
      const sessionPath = String(wire.sessionPath ?? "")
      // 试写门禁探针（__probe__ 前缀，用后即焚）：写盘 + 认领本探针路径（门禁以磁盘
      // 为准），不占用会话绑定态
      if (sessionPath.includes("__probe__")) {
        writeFileSync(
          sessionPath,
          `${JSON.stringify({ type: "session", version: 3, id: "probe", cwd: this.spawnOpts.cwd, timestamp: new Date().toISOString() })}\n`,
        )
        return {
          success: true,
          data: { sessionId: `probe-${this.handle}`, state: { sessionId: "probe-durable", sessionFile: sessionPath } },
        }
      }
      return { success: true, data: this.openAt(sessionPath) }
    }
    if (wire.type === "close_session") return { success: true, data: {} }
    return { success: true, data: { engineVersion: "fake" } }
  }

  /** 路径感知 open（管理器绑定 open 与 adapter attach open 同路）：认领传入路径，
   * 认领身份取会话文件 header id（真实引擎 open 认领磁盘 durable id）；文件缺失
   * （未落盘新会话）退 handle 别名。 */
  private openAt(sessionPath: string): {
    sessionId: string
    state: { sessionId: string; sessionFile: string }
  } {
    this.currentSessionPath = sessionPath
    let durable: string | undefined
    try {
      const header = JSON.parse(readFileSync(sessionPath, "utf8").split("\n")[0] ?? "") as { id?: unknown }
      if (typeof header.id === "string") durable = header.id
    } catch {
      // 未落盘
    }
    this.durableId = durable
    return { sessionId: this.handle, state: { sessionId: durable ?? this.handle, sessionFile: sessionPath } }
  }

  async openSession(options: { sessionPath?: string }): Promise<{
    sessionId: string
    state: { sessionId: string; sessionFile?: string }
  }> {
    return this.openAt(options.sessionPath ?? "")
  }
  async closeSession(): Promise<void> {}
  async listSessions(): Promise<Array<Record<string, unknown>>> {
    const row: Record<string, unknown> = {
      sessionId: this.handle,
      sessionPath: this.currentSessionPath ?? "",
      cwd: this.spawnOpts.cwd,
      status: "open",
    }
    if (this.durableId) row.durableSessionId = this.durableId
    return [row]
  }
  async getEntries(): Promise<{ entries: never[]; leafId: null }> {
    return { entries: [], leafId: null }
  }
  async prompt(message: string, options?: { streamingBehavior?: string }): Promise<string> {
    this.journal.push(options?.streamingBehavior ? "prompt:queued" : "prompt:started")
    this.prompts.push(message)
    return options?.streamingBehavior ? "queued" : "started"
  }
  async abort(): Promise<void> {
    this.journal.push("abort")
  }
  async sendExtensionUIResponse(): Promise<void> {}
  async getAvailableModels(): Promise<never[]> {
    return []
  }
  async getAvailableThinkingLevels(): Promise<string[]> {
    return ["low"]
  }
  async clearQueue(): Promise<unknown> {
    return { steering: [], followUp: [], ordered: [] }
  }
  async getSteeringMessages(): Promise<never[]> {
    return []
  }
  async getFollowUpMessages(): Promise<never[]> {
    return []
  }
  /** checkSettle / runState 推导经 cast 直接调用 */
  async getState(): Promise<Record<string, unknown>> {
    return { isStreaming: this.fakeStreaming, messageCount: 0, pendingQuestions: [] }
  }
  onEvent(listener: (event: RpcClientEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const i = this.listeners.indexOf(listener)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }
  /** 测试注入引擎回声帧 */
  emit(event: Record<string, unknown>): void {
    // 迭代期快照：监听器在回调内增删不得影响本次遍历
    for (const fn of [...this.listeners]) fn(event as RpcClientEvent)
  }
}

interface Harness {
  root: string
  project: string
  manager: EngineProcessManager
  registry: EngineRuntimeRegistry
  probe: MemProbe
  /** clientFactory 创建序的全部引擎 fake（每会话一台） */
  rpcs: FakeEngineRpc[]
  pathA: string
  pathB: string
  synthetic: Array<{ projectPath: string; event: Record<string, unknown> }>
  settled: Array<{ projectPath: string; sessionId: string; sessionPath: string; reason: string }>
  events: EngineManagerEvent[]
}

async function setup(opts?: {
  crashPollMs?: number
  /** ⑦⑧ 用：收缩回收档驱动 isIdle 第三判据真实复评 + 注入真 sessionBackgroundRunning */
  idleTimeoutMs?: number
  sessionBackgroundRunning?: (sessionPath: string) => boolean
}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "rt-parallel-test-"))
  try {
    const project = join(root, "proj")
    mkdirSync(project, { recursive: true })
    // tmpdir 会话文件 harness（runtime-abort-permission 同构）：两会话文件落同一
    // 项目会话库（同项目双会话前提），header durable id 供 store 扫描解析
    const agentDir = join(root, "agent")
    const sessionsDir = join(agentDir, "sessions", encodeCwdToSessionDirName(project))
    mkdirSync(sessionsDir, { recursive: true })
    const writeSessionFile = (id: string): string => {
      const path = join(sessionsDir, `2026-11-01T00-00-00-000Z_${id}.jsonl`)
      writeFileSync(
        path,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id,
          timestamp: "2026-11-01T00:00:00.000Z",
          cwd: project,
        })}\n`,
        "utf8",
      )
      return path
    }
    const pathA = writeSessionFile(SESSION_A)
    const pathB = writeSessionFile(SESSION_B)

    const probe = new MemProbe()
    const rpcs: FakeEngineRpc[] = []
    const synthetic: Harness["synthetic"] = []
    const settled: Harness["settled"] = []
    const events: EngineManagerEvent[] = []
    const manager = new EngineProcessManager({
      registryPath: join(root, "registry.json"),
      agentDir,
      // 缺省拉满测试生命期（不超 32 位定时器上限）：空闲回收面不进入既有断言；
      // ⑦⑧ 显式调小（80ms）驱动 isIdle 第三判据，并注入生产同源 sessionBackgroundRunning
      idleTimeoutMs: opts?.idleTimeoutMs ?? 2_000_000_000,
      // 任务 7：本套件（含 ⑦⑧ 真实 isIdle 复评）到正常档回收梯，探活窗关闭
      activityWindowMs: 0,
      sessionBackgroundRunning: opts?.sessionBackgroundRunning,
      readyProbeIntervalMs: 1,
      readyProbeMaxAttempts: 20,
      stopGraceMs: 200,
      crashPollMs: opts?.crashPollMs ?? 60_000, // 缺省抑制 crash 检出；⑤ 显式拉小
      backoffBaseMs: 60_000, // crash 后停在退避态：重启搅动不进入断言窗口
      probe,
      clientFactory: (o) => {
        const fake = new FakeEngineRpc(o, probe)
        // 模拟真实 spawn 的 /proc 生命周期：spawn 后进程存在于进程表
        probe.add(fake.pid, { cwd: project, argv: ["node", "/fake/engine/cli.js", "--mode", "rpc"] })
        rpcs.push(fake)
        return fake
      },
    })
    manager.onEvent((e) => events.push(e))
    const registry = new EngineRuntimeRegistry(manager, {
      listProjects: () => [project],
      agentDir,
      settlePollMs: 3_600_000, // 结算监视拉满测试生命期：正常收尾只走事件回声注入
      publishSyntheticEvent: (projectPath, event) => synthetic.push({ projectPath, event }),
      onRoundSettled: (projectPath, info, reason) => {
        settled.push({ projectPath, sessionId: info.sessionId, sessionPath: info.sessionPath, reason })
      },
    })
    return { root, project, manager, registry, probe, rpcs, pathA, pathB, synthetic, settled, events }
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    throw err
  }
}

async function teardown(h: Harness): Promise<void> {
  // 探针清空让 stopAll 的 waitForExit 立即见到进程退出，不空等宽限
  h.probe.procs.clear()
  await h.registry.stopAll()
  rmSync(h.root, { recursive: true, force: true })
}

/** 按绑定路径找引擎 fake（引擎键=会话文件路径，绑定 open 后成立） */
function rpcFor(h: Harness, sessionPath: string): FakeEngineRpc {
  const rpc = h.rpcs.find((r) => r["currentSessionPath"] === sessionPath)
  if (!rpc) throw new Error(`未找到绑定 ${sessionPath} 的引擎 fake（ensure 未按路径键控）`)
  return rpc
}

/** 引擎 fake prompts 安全取（FIXUP：绑定 open 完成前返回空数组——冷态排队后
 *  kick 的 ensure/open 链尚在途，waitForCondition 条件首次评估时 fake 可能还未
 *  绑定路径；空数组命中条件的 length 检查自然等待，不抛错） */
function promptsFor(h: Harness, sessionPath: string): string[] {
  return h.rpcs.find((r) => r["currentSessionPath"] === sessionPath)?.prompts ?? []
}

/** 有界条件等待（禁真睡：事件回声条件驱动 + 硬截止，不用固定时长赌定时器） */
async function waitForCondition(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error("waitForCondition deadline exceeded")
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** 负向观察窗口：durationMs 内持续断言不变式成立，破坏即抛错（process-manager.test 同款） */
async function holdInvariant(invariant: () => boolean, durationMs: number, step = 25): Promise<void> {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    if (!invariant()) throw new Error("观察窗口内不变式被破坏")
    await new Promise((r) => setTimeout(r, step))
  }
}

/** 后台任务启动态回执行（background-tasks.ts hasRunningBackgroundTask 启动态口径） */
function backgroundReceiptLine(toolCallId: string, taskId: string): string {
  return (
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        content: [],
        details: { run_in_background: true, status: "running", task_id: taskId },
      },
    }) + "\n"
  )
}

/** 账本帧（omo.task.updated FULL SNAPSHOT；经 helper 返回消除字面量新鲜度，账本测试同机制） */
function taskUpdatedFrame(durableId: string, taskId: string) {
  return {
    type: "extension_event",
    name: "omo.task.updated",
    sessionId: "rpc-ledger",
    data: {
      parent_session_id: durableId,
      tasks: [{ task_id: taskId, status: "running", task_summary: "安静后台长任务", updated_at: "t" }],
    },
  } as const
}

/** 账本帧注入（真实 EventBus 扇出 = index.ts attachBackgroundTaskLedger 装配同路） */
function feedTaskSnapshot(bus: EventBus, project: string, durableId: string, taskId: string): void {
  bus.publish(project, taskUpdatedFrame(durableId, taskId))
}

describe("双会话并行集成证明（multi-session-parallel T8：真管理器×真运行时）", () => {
  test("① 同项目两会话 ensure 后双引擎并存（engines Map 两键）", async () => {
    const h = await setup()
    try {
      // 生产路径进入：两会话各自 prompt 触发各自 ensure（registry → manager 全链路）。
      // FIXUP（engine-ux-visibility 任务 5）：冷态 prompt 改为立即接住排队（disposition
      // "queued"），kick 的 ensure 链拉起引擎、ready 事件后自动补投——冷态同步直投
      // 回执不再存在；以引擎 fake 收到 prompt 为确定性信号等补投落定后再断言存量不变式
      const ra = await h.registry.prompt(SESSION_A, { text: "A 首问" })
      const rb = await h.registry.prompt(SESSION_B, { text: "B 首问" })
      expect(ra.disposition).toBe("queued")
      expect(rb.disposition).toBe("queued")
      await waitForCondition(
        () => promptsFor(h, h.pathA).length === 1 && promptsFor(h, h.pathB).length === 1,
      )
      expect(rpcFor(h, h.pathA).prompts).toEqual(["A 首问"])
      expect(rpcFor(h, h.pathB).prompts).toEqual(["B 首问"])

      // engines Map 公共镜像：两键（每会话一引擎），记录对 projectPath+sessionPath 齐全
      const rows = h.manager.getAllStatus()
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.sessionPath).sort()).toEqual([h.pathA, h.pathB].sort())
      for (const row of rows) {
        expect(row.projectPath).toBe(h.project)
        expect(row.state).toBe("ready")
      }
      // 对象身份防线（键两侧同 string 的假绿防线）：两键两实例异 pid，getClient 按键各回各家
      const clientA = h.manager.getClient(h.pathA) as unknown as FakeEngineRpc
      const clientB = h.manager.getClient(h.pathB) as unknown as FakeEngineRpc
      expect(clientA).toBe(rpcFor(h, h.pathA))
      expect(clientB).toBe(rpcFor(h, h.pathB))
      expect(clientA === clientB).toBe(false)
      expect(clientA.pid).not.toBe(clientB.pid)
    } finally {
      await teardown(h)
    }
  })

  test("② 两会话同时 prompt 真并发（Promise.all，双 runningTurns 行）", async () => {
    const h = await setup()
    try {
      // 真并发进入运行时（非顺序注册后假装并行）：两回合同时发起（FIXUP：冷态
      // 回执 queued，双路各自 kick/补投，以引擎 fake 收到 prompt 为落定信号）
      const [ra, rb] = await Promise.all([
        h.registry.prompt(SESSION_A, { text: "A 回合" }),
        h.registry.prompt(SESSION_B, { text: "B 回合" }),
      ])
      expect(ra.disposition).toBe("queued")
      expect(rb.disposition).toBe("queued")
      await waitForCondition(
        () => promptsFor(h, h.pathA).length === 1 && promptsFor(h, h.pathB).length === 1,
      )
      // 路径键控路由正确：双引擎各自只收到自己会话的 prompt
      expect(rpcFor(h, h.pathA).prompts).toEqual(["A 回合"])
      expect(rpcFor(h, h.pathB).prompts).toEqual(["B 回合"])
      // 双 runningTurns 行（收尾事件未发生，行仍在表 = 两回合同帧在途）
      const states = await h.registry.peekRunStates(h.project)
      expect(states).not.toBeNull()
      expect([...states!.keys()].sort()).toEqual([h.pathA, h.pathB].sort())
      expect(states!.get(h.pathA)).toBe("running")
      expect(states!.get(h.pathB)).toBe("running")
      const active = await h.registry.peekActiveSessionPaths(h.project)
      expect(active).not.toBeNull()
      expect([...active!].sort()).toEqual([h.pathA, h.pathB].sort())
    } finally {
      await teardown(h)
    }
  })

  test("③ A 回合进行中 B 发起不被 409（跨会话放行，互斥按 sessionPath 判定）", async () => {
    const h = await setup()
    try {
      // FIXUP：冷态回执 queued，等 A 补投落定（runningTurn 成立的前提）
      const ra0 = await h.registry.prompt(SESSION_A, { text: "A 回合" })
      expect(ra0.disposition).toBe("queued")
      await waitForCondition(() => promptsFor(h, h.pathA).length === 1)
      // A 在途真值：此刻仅 A 一行 running
      let states = await h.registry.peekRunStates(h.project)
      expect([...states!.keys()]).toEqual([h.pathA])

      // A 在途期间 B 发起：不 409（无跨会话互斥），B 冷态排队后 ready 补投正常投出
      const rb = await h.registry.prompt(SESSION_B, { text: "B 回合" })
      expect(rb.disposition).toBe("queued")
      await waitForCondition(() => promptsFor(h, h.pathB).length === 1)

      // A 回合不被 B 的发起打断：双行并行 running
      states = await h.registry.peekRunStates(h.project)
      expect(states!.get(h.pathA)).toBe("running")
      expect(states!.get(h.pathB)).toBe("running")
    } finally {
      await teardown(h)
    }
  })

  test("④ 同会话二发仍 409 already_processing（session_path_in_use 族），带 streamingBehavior 入队 queued", async () => {
    const h = await setup()
    try {
      // FIXUP：冷态回执 queued，等首投落定（回合占用成立的前提）后再验 409 半边
      await h.registry.prompt(SESSION_A, { text: "A 第一发" })
      await waitForCondition(() => promptsFor(h, h.pathA).length === 1)

      // 同会话二发：结构化 409（IS-2 的 409 半边；文案携被占会话路径，T7 常驻错误卡呈现面）
      const err = await h.registry.prompt(SESSION_A, { text: "A 第二发" }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(409)
      expect((err as ApiError).code).toBe("already_processing")
      expect((err as ApiError).message).toContain(h.pathA)
      // 运行时守卫先拦：第二发未触达引擎（不等引擎报错）
      expect(rpcFor(h, h.pathA).prompts).toEqual(["A 第一发"])

      // 带 streamingBehavior：放行入队（CLI 同构会话内排队），回执 queued
      const queued = await h.registry.prompt(SESSION_A, { text: "A 排队", streamingBehavior: "steer" })
      expect(queued.disposition).toBe("queued")
      expect(rpcFor(h, h.pathA).prompts).toEqual(["A 第一发", "A 排队"])
      // 排队回合不新增行：仍 A 一行 running（同一 run，run 尾才 settle 一次）
      const states = await h.registry.peekRunStates(h.project)
      expect([...states!.keys()]).toEqual([h.pathA])
    } finally {
      await teardown(h)
    }
  })

  test("⑤ A 引擎 crash 仅 A 合成收尾（engine_crash），B 存活", async () => {
    const h = await setup({ crashPollMs: 5 })
    try {
      await Promise.all([
        h.registry.prompt(SESSION_A, { text: "A 回合" }),
        h.registry.prompt(SESSION_B, { text: "B 回合" }),
      ])
      await waitForCondition(
        () => promptsFor(h, h.pathA).length === 1 && promptsFor(h, h.pathB).length === 1,
      )

      // kill -9 形态：A 进程从 /proc 消失 → supervisor pid 轮询检出 process_crashed
      //（事件回声驱动，非时序押注）。注：#22 后冷态补投成功也会合成 queue_update 清帧
      //（A/B 两路均可能先到），与 crash 收尾无固定先后——按类型等收尾帧再过滤断言。
      h.probe.procs.delete(rpcFor(h, h.pathA).pid)
      await waitForCondition(() =>
        h.synthetic.some((e) => e.event.type === "agent_settled"),
      )

      // 仅 A 一条合成收尾，reason engine_crash，sessionId 为 durable id
      const settles = h.synthetic.filter((e) => e.event.type === "agent_settled");
      expect(settles).toEqual([
        {
          projectPath: h.project,
          event: { type: "agent_settled", synthetic: true, sessionId: SESSION_A, reason: "engine_crash" },
        },
      ])
      // #22 顺带验证：A 的冷态补投成功合成过 queue_update 清帧（ordered:[]，durable id 路由）
      await waitForCondition(() =>
        h.synthetic.some(
          (e) => e.event.type === "queue_update" && e.event.sessionId === SESSION_A && (((e.event as { ordered?: unknown[] }).ordered ?? []).length === 0),
        ),
      )
      // crashSettle 排除 onRoundSettled（正常结算口径不触发）
      expect(h.settled).toEqual([])
      // B 存活：回合行仍在且 running；B 引擎零受扰（无 abort/stop 搅动）
      const states = await h.registry.peekRunStates(h.project)
      expect(states).not.toBeNull()
      expect([...states!.keys()]).toEqual([h.pathB])
      expect(states!.get(h.pathB)).toBe("running")
      const rpcB = rpcFor(h, h.pathB)
      expect(rpcB.journal).toEqual(["prompt:started"])
      expect(rpcB.stopCount).toBe(0)
    } finally {
      await teardown(h)
    }
  })

  test("⑥ 定向 stop(A) 后 B 引擎行仍在且 B 回合不受扰", async () => {
    const h = await setup()
    try {
      await Promise.all([
        h.registry.prompt(SESSION_A, { text: "A 回合" }),
        h.registry.prompt(SESSION_B, { text: "B 回合" }),
      ])
      await waitForCondition(
        () => promptsFor(h, h.pathA).length === 1 && promptsFor(h, h.pathB).length === 1,
      )
      expect(h.manager.getAllStatus()).toHaveLength(2)

      // 定向停：仅 A 的会话引擎
      await h.manager.stop(h.pathA)

      const rows = h.manager.getAllStatus()
      const rowA = rows.find((r) => r.sessionPath === h.pathA)
      const rowB = rows.find((r) => r.sessionPath === h.pathB)
      // A 行关停（stopped，pid 已清；行保留供懒起）
      expect(rowA?.state).toBe("stopped")
      expect(rowA?.pid).toBeUndefined()
      // B 引擎行仍在：ready 且 pid 原样
      expect(rowB?.state).toBe("ready")
      expect(rowB?.pid).toBe(rpcFor(h, h.pathB).pid)
      // 定向性：A 进程收到 stop，B 进程零搅动
      expect(rpcFor(h, h.pathA).stopCount).toBeGreaterThanOrEqual(1)
      expect(rpcFor(h, h.pathB).stopCount).toBe(0)
      // B 回合不受扰：仍 running
      const states = await h.registry.peekRunStates(h.project)
      expect([...states!.keys()]).toEqual([h.pathB])
      expect(states!.get(h.pathB)).toBe("running")
    } finally {
      await teardown(h)
    }
  })
})

describe("会话粒度引擎死亡失效（F2 审查 MAJOR 修复：A 死亡 B 不受扰）", () => {
  // 账本/推导缓存为模块级单例：用例间清场，防跨用例污染
  afterEach(() => {
    resetBackgroundTaskLedger()
    clearBackgroundStateCache()
  })

  /** 双会话双源毒化 + 前置真值断言（B 的「不受扰」以此为准，非仅无异常） */
  function poisonBothSessions(h: Harness): void {
    appendFileSync(h.pathA, backgroundReceiptLine("call-a", "task-a"))
    appendFileSync(h.pathB, backgroundReceiptLine("call-b", "task-b"))
    const bus = new EventBus({ capacity: 100 })
    attachBackgroundTaskLedger(bus)
    feedTaskSnapshot(bus, h.project, SESSION_A, "task-a")
    feedTaskSnapshot(bus, h.project, SESSION_B, "task-b")
    expect(sessionBackgroundRunning(h.pathA)).toBe(true)
    expect(sessionBackgroundRunning(h.pathB)).toBe(true)
    expect(ledgerHasRunning(h.project, SESSION_A)).toBe(true)
    expect(ledgerHasRunning(h.project, SESSION_B)).toBe(true)
  }

  test("⑦ 定向 stop(A) + 死亡失效按会话收缩：仅 A 双源失效，B 双源与 isIdle 第三判据不受扰", async () => {
    // 注入真 sessionBackgroundRunning（index.ts 装配同源）+ 80ms 回收档：
    // isIdle 判据链在真 manager 上真实复评，非仅函数级断言
    const h = await setup({ idleTimeoutMs: 80, sessionBackgroundRunning: sessionBackgroundRunning })
    try {
      // 回执先落盘后 ensure：ready 时 isIdle 即见忙（第三判据），不起回收定时器
      poisonBothSessions(h)
      await h.manager.ensureRunning(h.pathA, h.project)
      await h.manager.ensureRunning(h.pathB, h.project)

      // 定向停 A（⑥ 同入口）→ 死亡失效接线（index.ts 同参：仅死亡引擎键）
      await h.manager.stop(h.pathA)
      handleProjectEngineDeath(h.project, [h.pathA])

      // A 双源均已失效：jsonl 文本未重写（抑制来自冻结）；账本键被清
      expect(sessionBackgroundRunning(h.pathA)).toBe(false)
      expect(ledgerHasRunning(h.project, SESSION_A)).toBe(false)
      // B 第四态双源不受扰：指纹未冻 + 台账仍在（正断言，非仅无异常）
      expect(sessionBackgroundRunning(h.pathB)).toBe(true)
      expect(ledgerHasRunning(h.project, SESSION_B)).toBe(true)

      // manager.isIdle 判据链（T2 第三判据）真实复评 B：reportSessionActive/Closed
      // 最短触发对（process-manager.test (b) 同款）→ rescheduleIdleCheck → isIdle(B)
      // → sessionBackgroundRunning(pathB) 仍 true（忙）→ 不起回收定时器
      h.manager.reportSessionActive(h.pathB, "rpc-post-death")
      h.manager.reportSessionClosed(h.pathB, "rpc-post-death")
      await holdInvariant(() => h.manager.getStatus(h.pathB)?.state === "ready", 250)
      expect(h.manager.getStatus(h.pathB)?.state).toBe("ready")
      expect(rpcFor(h, h.pathB).stopCount).toBe(0)
      expect(h.events.some((e) => e.type === "engine_reclaimed")).toBe(false)

      // 对照组（对抗 misleading_success_output）：同 harness 反向证明本断言可检出回归
      // ——复现旧按项目口径（B 一并传入失效面 = 冻结 B）→ 第三判据翻闲 → 回收真发生
      handleProjectEngineDeath(h.project, [h.pathA, h.pathB])
      h.manager.reportSessionActive(h.pathB, "rpc-control")
      h.manager.reportSessionClosed(h.pathB, "rpc-control")
      await waitForCondition(() => h.manager.getStatus(h.pathB)?.state === "stopped")
      expect(h.events.some((e) => e.type === "engine_reclaimed" && e.sessionPath === h.pathB)).toBe(true)
    } finally {
      await teardown(h)
    }
  })

  test("⑧ A 崩溃 + 死亡失效按会话收缩：仅 A 双源失效，B 双源与 isIdle 第三判据不受扰", async () => {
    const h = await setup({ crashPollMs: 5, idleTimeoutMs: 80, sessionBackgroundRunning: sessionBackgroundRunning })
    try {
      poisonBothSessions(h)
      await h.manager.ensureRunning(h.pathA, h.project)
      await h.manager.ensureRunning(h.pathB, h.project)

      // kill -9 形态（⑤ 同入口）：A 进程从 /proc 消失 → supervisor 轮询检出 process_crashed
      h.probe.procs.delete(rpcFor(h, h.pathA).pid)
      await waitForCondition(() => h.events.some((e) => e.type === "process_crashed" && e.sessionPath === h.pathA))

      // 死亡失效接线（index.ts process_crashed 分支同参：仅死亡引擎键）
      handleProjectEngineDeath(h.project, [h.pathA])

      // A 失效，B 双源不受扰（指纹未冻 + 台账仍在）
      expect(sessionBackgroundRunning(h.pathA)).toBe(false)
      expect(ledgerHasRunning(h.project, SESSION_A)).toBe(false)
      expect(sessionBackgroundRunning(h.pathB)).toBe(true)
      expect(ledgerHasRunning(h.project, SESSION_B)).toBe(true)

      // B 引擎行原样 ready；第三判据仍判忙：复评后窗口内不被回收
      expect(h.manager.getStatus(h.pathB)?.state).toBe("ready")
      h.manager.reportSessionActive(h.pathB, "rpc-post-death")
      h.manager.reportSessionClosed(h.pathB, "rpc-post-death")
      await holdInvariant(() => h.manager.getStatus(h.pathB)?.state === "ready", 250)
      expect(rpcFor(h, h.pathB).stopCount).toBe(0)
    } finally {
      await teardown(h)
    }
  })
})
