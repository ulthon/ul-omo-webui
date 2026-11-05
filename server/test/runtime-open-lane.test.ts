/**
 * 任务 6（C3 单车道开门+落表后置+状态扇出）回归，engine-open-read-batch 计划行 6
 * + t9 诊断增补（session_path_in_use 并发场景）：
 * 1. 落表后置（02:53 病灶真身，webui-2026-11-06.log seq 0239-0326）：open 失败 →
 *    engines 表无落败条目 + 车道槽清空 + 后续 op 自愈——对抗 misleading_success_output：
 *    逐项断言表净（size 0 + 条目 undefined），非「不抛即过」；
 * 2. 五路并发（messages/usage/queue/questions/prompt，02:52:50 seq 0190-0194 形态）
 *    共享单次建 adapter+open——fake 内置引擎侧 in-flight 守卫（并发同路径 open 直接
 *    拒 session_path_in_use，t9 诊断的引擎面语义），单车道下守卫零触发（无
 *    already-in-flight 风暴、无 path 撞路）；
 * 3. 扇出固定清单：activeId 点亮、handleToDurable 即时回填（无 MISS）、
 *    reportSessionActive 恰一次（routingId 口径）、unpersistedClaims 磁盘复核
 *    （认领未落盘登记 / 落盘后重开解除，t1 铁律：口头认领不可信）；
 * 4. createSession 参数随车道直达首开（单次 open 携参，替代旧「裸开+参数开」两连发）；
 * 5. 绑定丢失五路并发兜底重开合并为恰好一次（重开撞路消弭，open 持锁门确定性推进）。
 * 确定性（对抗 flaky_tests）：并发窗口用 setClientInfo / open 持锁门（委派面）+
 * waitFor + 有界静置推进（同 runtime-active-reopen 既有纪律），禁真睡。
 */
import { describe, expect, test, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { EngineProcessManager } from "../src/engine/process-manager"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"
import { encodeCwdToSessionDirName } from "../src/adapter/senpi-adapter"
import type { EngineMessagesPage, EngineQuestionFrame, EngineQueueSnapshot, EngineUsageStats } from "../src/adapter/engine-adapter"

const PROJECT = "/tmp/opencode/rt-open-lane-proj"
const DURABLE_ID = "01c44444-0000-7000-8000-000000000011"
/** store 行可解析的合法会话文件体（header.timestamp + 一条带时间戳条目） */
const SESSION_FILE_BODY =
  JSON.stringify({ type: "session", version: 3, id: DURABLE_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: PROJECT }) +
  "\n" +
  JSON.stringify({ type: "message", id: "e1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } }) +
  "\n"

/** fake 引擎 RPC：openSession 带引擎侧 in-flight 守卫（并发同路径 open 拒
 *  session_path_in_use——t9 诊断的引擎面语义，单车道回归的检出器）；openShouldFail
 *  注入必败形态（响应缺 sessionId → adapter 报 open_failed）；openGate 持锁门
 *  （重开确定性推进用：open 入口挂起至 release）；holdSetClientInfo 持锁就绪窗口
 *  （adapter.start() 委派面，同 runtime-active-reopen 纪律）。 */
class FakeLaneRpc {
  openCalls = 0
  /** 引擎 in-flight 守卫触发计数（单车道下恒 0；回归为 N 时即出现撞路） */
  pathInUseRejections = 0
  openShouldFail = false
  persistOnOpen = false
  holdSetClientInfo = false
  setClientInfoEntered = 0
  /** open 持锁门：开启后进入的 open 挂起，直到 releaseOpen（测试确定性推进用） */
  openGate = false
  openGateEntered = 0
  /** 最近一次 open 的入参（createSession 携参直达断言源） */
  lastOpenOptions: Record<string, unknown> = {}
  private openInFlight = false
  private openGateResolve: (() => void) | null = null
  private setClientInfoResolve: (() => void) | null = null
  private routing = 1
  private lastOpenPath = ""

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async setClientInfo(): Promise<void> {
    this.setClientInfoEntered += 1
    if (this.holdSetClientInfo) {
      await new Promise<void>((r) => {
        this.setClientInfoResolve = r
      })
    }
  }
  releaseSetClientInfo(): void {
    this.setClientInfoResolve?.()
  }
  async send(): Promise<{ success: boolean }> {
    return { success: true }
  }

  async openSession(options: { sessionPath?: string; provider?: string; modelId?: string }): Promise<{
    sessionId: string
    state: { sessionId: string; sessionFile?: string }
  }> {
    // 引擎 in-flight 守卫：并发同路径 open 直接拒（session_path_in_use 真语义）
    if (this.openInFlight) {
      this.pathInUseRejections += 1
      throw new Error(`session_path_in_use: 会话路径已有在途 open（${options.sessionPath ?? ""}）`)
    }
    this.openInFlight = true
    try {
      this.openCalls += 1
      this.lastOpenOptions = { ...options }
      if (this.openGate) {
        this.openGateEntered += 1
        await new Promise<void>((r) => {
          this.openGateResolve = r
        })
      }
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
    } finally {
      this.openInFlight = false
    }
  }
  releaseOpen(): void {
    this.openGateResolve?.()
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
  async getEntries(): Promise<{ entries: unknown[]; leafId: string | null; hasMore?: boolean; nextSince?: string }> {
    return { entries: [], leafId: null }
  }
  async getSteeringMessages(): Promise<string[]> {
    return []
  }
  async getFollowUpMessages(): Promise<string[]> {
    return []
  }
  async getState(): Promise<Record<string, unknown>> {
    return {}
  }
}

/** 间谍管理器：记录 reportSessionActive 扇出点亮（任务 6 清单③断言源） */
class SpyManager {
  readonly activeReports: Array<{ sessionPath: string; sessionId: string }> = []
  constructor(private readonly rpc: FakeLaneRpc) {}
  async ensureRunning(): Promise<void> {}
  getClient(_sessionPath: string): FakeLaneRpc {
    return this.rpc
  }
  getStatus(): { state: "ready" } {
    return { state: "ready" }
  }
  reportSessionActive(sessionPath: string, sessionId: string): void {
    this.activeReports.push({ sessionPath, sessionId })
  }
  markUserActivity(_sessionPath: string): void {}
  onEvent(_listener: (event: unknown) => void): () => void {
    return () => {}
  }
  async stop(): Promise<void> {}
  async stopAll(): Promise<void> {}
}

function makeRegistry(manager: SpyManager, agentDir: string): EngineRuntimeRegistry {
  return new EngineRuntimeRegistry(manager as unknown as EngineProcessManager, {
    listProjects: () => [PROJECT],
    agentDir,
    // 收尾监视轮询远长于测试生命期：用例结算不依赖真实时序
    settlePollMs: 3_600_000,
  })
}

function setup(rpc = new FakeLaneRpc()): {
  root: string
  agentDir: string
  sessionPath: string
  rpc: FakeLaneRpc
  manager: SpyManager
  registry: EngineRuntimeRegistry
} {
  const root = mkdtempSync(join(tmpdir(), "rt-open-lane-test-"))
  const agentDir = join(root, "agent")
  const sessionPath = join(agentDir, "sessions", encodeCwdToSessionDirName(PROJECT), `${DURABLE_ID}.jsonl`)
  mkdirSync(dirname(sessionPath), { recursive: true })
  writeFileSync(sessionPath, SESSION_FILE_BODY)
  const manager = new SpyManager(rpc)
  return { root, agentDir, sessionPath, rpc, manager, registry: makeRegistry(manager, agentDir) }
}

/** private 面运行期直读（仅测试断言用）：engines 表 / openLanes 车道槽 */
function runtimeOf(registry: EngineRuntimeRegistry): {
  engines: Map<string, { adapter: { active: unknown }; activeId: string | null; handleToDurable: Map<string, string> }>
  openLanes: Map<string, unknown>
} {
  const rt = (registry as unknown as { runtimes: Map<string, unknown> }).runtimes.get(PROJECT) as
    | {
        engines: Map<string, { adapter: { active: unknown }; activeId: string | null; handleToDurable: Map<string, string> }>
        openLanes: Map<string, unknown>
      }
    | undefined
  expect(rt).toBeDefined()
  return rt!
}

describe("落表后置（任务 6：02:53 病灶真身——落败 adapter 不占表）", () => {
  test("open 失败 → engines 表无落败条目 + 车道槽清空 + 后续 op 自愈", async () => {
    const { root, sessionPath, rpc, registry } = setup()
    try {
      rpc.openShouldFail = true
      const err = await registry.messages(DURABLE_ID).then(
        () => {
          throw new Error("应当拒绝，不应成功")
        },
        (e: unknown) => e as { code?: string },
      )
      expect(err.code).toBe("open_failed")
      // 对抗 misleading_success_output：不是「不抛即过」，逐项断言表净——
      // 旧序 engines.set 先于 open，此处 size=1（落败占表）即 02:53 复现形态
      const rt = runtimeOf(registry)
      expect(rt.engines.size).toBe(0)
      expect(rt.engines.get(sessionPath)).toBeUndefined()
      expect(rt.openLanes.size).toBe(0)
      // 自愈：恢复 open 后续 op 重走车道成功（不 33 秒连环 no_active_session）
      rpc.openShouldFail = false
      const page = await registry.messages(DURABLE_ID)
      expect(page.entries).toEqual([])
      expect(rpc.openCalls).toBe(2) // 失败 1 次 + 自愈 1 次，无重试风暴
      expect(runtimeOf(registry).engines.size).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("五路并发共享单次建引擎+开（02:52:50 形态 + t9 session_path_in_use 增补）", () => {
  test("messages/usage/queue/questions/prompt 并发 → 单 adapter 单 open，in-flight 守卫零触发", async () => {
    const { root, rpc, manager, registry } = setup()
    try {
      rpc.holdSetClientInfo = true // 确定性就绪窗口：adapter.start() 委派面持锁
      const ops: [
        Promise<EngineMessagesPage>,
        Promise<EngineUsageStats>,
        Promise<EngineQueueSnapshot>,
        Promise<EngineQuestionFrame[]>,
        Promise<{ disposition: string }>,
      ] = [
        registry.messages(DURABLE_ID),
        registry.usage(DURABLE_ID),
        registry.queueList(DURABLE_ID),
        registry.questionsList(DURABLE_ID),
        registry.prompt(DURABLE_ID, { text: "hi" }),
      ]
      // 首路进入就绪窗口（委派面进入计数）
      await vi.waitFor(() => expect(rpc.setClientInfoEntered).toBeGreaterThanOrEqual(1))
      // 有界静置：给其余四路到达时间；无合并时它们各建 adapter 各入锁（entered→5）
      // 且五路 open 撞 in-flight 守卫（pathInUseRejections>0），本用例即红
      await new Promise((r) => setTimeout(r, 50))
      rpc.releaseSetClientInfo()
      const [page, usage, queue, questions, receipt] = await Promise.all(ops)
      // 五路各自成功（非仅不抛：逐路断言业务结果）
      expect(page.entries).toEqual([])
      expect(usage.sessionId).toBe("")
      expect(queue.ordered).toEqual([])
      expect(questions).toEqual([])
      expect(["started", "handled", "queued"]).toContain(receipt.disposition)
      // 计数钉死：单次建 adapter + 单次 open + 守卫零触发 + 单绑定态
      expect(rpc.setClientInfoEntered).toBe(1)
      expect(rpc.openCalls).toBe(1)
      expect(rpc.pathInUseRejections).toBe(0)
      expect(runtimeOf(registry).engines.size).toBe(1)
      expect(manager.activeReports).toHaveLength(1) // 单次扇出点亮
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("绑定丢失五路并发 → 兜底重开合并为恰好一次（重开撞路消弭）", async () => {
    const { root, sessionPath, rpc, registry } = setup()
    try {
      // 首开正常（openCalls=1）
      await registry.messages(DURABLE_ID)
      expect(rpc.openCalls).toBe(1)
      // 事故形态注入：绑定丢失（active=null）+ open 持锁门（确定性：五路兜底全落同
      // 一车道再放行，而非凭微task时序碰运气）
      const st = runtimeOf(registry).engines.get(sessionPath)!
      st.adapter.active = null
      rpc.openGate = true
      const ops = [
        registry.messages(DURABLE_ID),
        registry.messages(DURABLE_ID),
        registry.messages(DURABLE_ID),
        registry.messages(DURABLE_ID),
        registry.messages(DURABLE_ID),
      ]
      // 首路兜底重开进入持锁门（openCalls=2 且门已进入）
      await vi.waitFor(() => {
        expect(rpc.openCalls).toBe(2)
        expect(rpc.openGateEntered).toBe(1)
      })
      // 有界静置：给其余四路 no_active_session 兜底到达时间（车道在途，全部合流）
      await new Promise((r) => setTimeout(r, 50))
      rpc.releaseOpen()
      const pages = await Promise.all(ops)
      expect(pages).toHaveLength(5)
      for (const page of pages) expect(page.entries).toEqual([])
      // 恰好一次重开：首开 1 + 兜底重开 1；守卫零触发（无 already-in-flight 撞路）
      expect(rpc.openCalls).toBe(2)
      expect(rpc.pathInUseRejections).toBe(0)
      expect(st.adapter.active).not.toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("扇出固定清单（任务 6：handleToDurable 无 MISS + 点亮 + claims 磁盘复核）", () => {
  test("open 成功后 activeId 点亮、映射就位、reportSessionActive 恰一次（routingId 口径）", async () => {
    const { root, sessionPath, rpc, manager, registry } = setup()
    try {
      await registry.messages(DURABLE_ID)
      expect(rpc.openCalls).toBe(1)
      const st = runtimeOf(registry).engines.get(sessionPath)!
      // ① activeId ← durableHint
      expect(st.activeId).toBe(DURABLE_ID)
      // ② handleToDurable 即时回填：wire 事件（routingId=rpc-1）解析零 MISS（attribution 观测归零）
      expect(st.handleToDurable.get("rpc-1")).toBe(DURABLE_ID)
      expect(registry.durableSessionIdFor(PROJECT, "rpc-1", sessionPath)).toBe(DURABLE_ID)
      // ③ 管理器点亮恰一次：sessionPath=引擎键、sessionId=routingId（与 agent_end 摘除同口径）
      expect(manager.activeReports).toEqual([{ sessionPath, sessionId: "rpc-1" }])
      // ④ durable 升级命中（文件在盘）：无未落盘认领残留
      const rt = runtimeOf(registry)
      expect((rt as unknown as { unpersistedClaims: Map<string, string> }).unpersistedClaims.size).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("认领未落盘 → unpersistedClaims 登记；落盘后下一次开门复核解除（existsSync 复核）", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-open-lane-claim-"))
    try {
      const agentDir = join(root, "agent")
      const rpc = new FakeLaneRpc()
      const manager = new SpyManager(rpc)
      const registry = makeRegistry(manager, agentDir)
      // 新会话（引擎认领 durableSessionId 但不写盘，t1 形态）：claim 登记 + durable=false
      const created = await registry.createSession(PROJECT, {})
      expect(created.durable).toBe(false)
      expect(created.id).toBe(DURABLE_ID)
      const err = await registry.sessionPath(DURABLE_ID).then(
        () => null,
        (e: unknown) => e as { code?: string },
      )
      expect(err?.code).toBe("session_not_persisted")
      // 引擎此后补写文件（懒落盘）+ 绑定丢失触发重开 → 扇出复核 existsSync 解除 claim
      mkdirSync(dirname(created.sessionPath), { recursive: true })
      writeFileSync(created.sessionPath, SESSION_FILE_BODY)
      const st = runtimeOf(registry).engines.get(created.sessionPath)!
      st.adapter.active = null
      const page = await registry.messages(DURABLE_ID)
      expect(page.entries).toEqual([])
      expect(rpc.openCalls).toBe(2) // 首开 1 + 兜底重开 1
      // 解除后正常解析（不再 409 session_not_persisted）
      const path = await registry.sessionPath(DURABLE_ID)
      expect(path).toBe(created.sessionPath)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("createSession 参数随车道直达首开（收编验证）", () => {
  test("provider/modelId 单次 open 携参生效（替代旧「裸开+参数开」两连发）", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-open-lane-create-"))
    try {
      const agentDir = join(root, "agent")
      const rpc = new FakeLaneRpc()
      rpc.persistOnOpen = true
      const manager = new SpyManager(rpc)
      const registry = makeRegistry(manager, agentDir)
      const created = await registry.createSession(PROJECT, { provider: "prov-x", modelId: "m-1" })
      expect(created.durable).toBe(true)
      expect(created.id).toBe(DURABLE_ID)
      // 计数钉死：恰一次 open 且携参直达（旧序此处 openCalls=2）
      expect(rpc.openCalls).toBe(1)
      expect(rpc.lastOpenOptions).toMatchObject({ provider: "prov-x", modelId: "m-1" })
      expect(rpc.pathInUseRejections).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
