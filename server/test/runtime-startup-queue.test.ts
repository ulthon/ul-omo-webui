/**
 * 启动期 prompt 自动补投（engine-ux-visibility 任务 5，2026-11-06 97 秒冷启事故回归）：
 * 1. starting 期 prompt → 200 排队语义（disposition="queued"+queued=true），引擎 RPC 零调用；
 *    ready 事件 → 原样投递恰好一次（会话文件单副本 + text 字节一致双断言）。
 * 2. 有界等待超时（QUEUED_STARTUP_PROMPT_TIMEOUT_MS=120s，START+OPEN 超时族之和）→
 *    合成 queued_prompt_timeout 事件（code=queued_timeout），消息绝不投递；引擎永久失败
 *    （stale 形态）由此兜底；迟到的 ready 事件命中空表同样零投递。
 * 3. 等待期 abort → 撤回（不走 ensure 链不拉引擎），此后 ready 零投递。
 * 4. 排队中第二个 prompt → 409 already_processing（不排两个）。
 * 5. backoff 期 prompt → 同样排队。
 * 6. stopped + 开门车道在途（stopped-with-open-in-progress）→ 排队。
 * 7. 纯 stopped 冷态 → 不排队走原同步 ensure 路径（503 engine_not_ready，行为零变化）。
 * 8. 回合进行中 prompt → 现有 409 already_processing 语义不变（ready 直投与 starting
 *    排队门两路都先撞回合占用）。
 * 9. ready 后投递失败（open_failed）→ 不重试，合成 queued_prompt_failed 事件可观测。
 */
import { describe, expect, test, vi } from "vitest"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { EngineProcessManager, EngineState } from "../src/engine/process-manager"
import { EngineRuntimeRegistry, QUEUED_STARTUP_PROMPT_TIMEOUT_MS } from "../src/api/engine-runtime"
import { encodeCwdToSessionDirName } from "../src/adapter/senpi-adapter"
import { ApiError } from "../src/api/http"

const PROJECT = "/tmp/opencode/rt-queue-proj"
const DURABLE_ID = "01d555555-0000-7000-8000-000000000005"
/** store 行可解析的合法会话文件体（header.timestamp + 一条带时间戳条目，缺一则
 *  SessionManager 行 created/modified 为 Invalid Date → sessionsList 映射抛
 *  Invalid time value，resolveSession 三级查找全灭——探针实证） */
const SESSION_FILE_BODY =
  JSON.stringify({ type: "session", version: 3, id: DURABLE_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: PROJECT }) +
  "\n" +
  JSON.stringify({ type: "message", id: "e1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } }) +
  "\n"

/** fake 引擎 RPC：prompt 记录调用并模拟真实引擎把 user 条目落盘（会话文件单副本
 *  断言源）；openShouldFail 注入 open 必败形态（投递失败合成事件场景用）。 */
class FakeQueueRpc {
  promptCalls = 0
  prompts: string[] = []
  openCalls = 0
  abortCalls = 0
  openShouldFail = false
  private routing = 1
  private lastOpenPath = ""
  private sessionPathForWrites = ""

  /** 投递写盘目标（setup 后注入；写盘模拟真实引擎 user 条目落盘） */
  bindSessionFile(path: string): void {
    this.sessionPathForWrites = path
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async setClientInfo(): Promise<void> {}
  async send(): Promise<{ success: boolean }> {
    return { success: true }
  }
  async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
    return { provider, id: modelId }
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
  async prompt(text: string): Promise<string> {
    this.promptCalls += 1
    this.prompts.push(text)
    // 模拟真实引擎：user 条目落盘（单副本断言按此文件数出现次数）
    if (this.sessionPathForWrites) {
      appendFileSync(
        this.sessionPathForWrites,
        JSON.stringify({
          type: "message",
          id: `m${this.promptCalls}`,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: text },
        }) + "\n",
      )
    }
    return "started"
  }
  async abort(): Promise<void> {
    this.abortCalls += 1
  }
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

/** fake 管理器：状态可切换 + state_changed 事件可手动发射（确定性 ready 触发）；
 *  ensureRunning 计数供「撤回不拉引擎」断言；stateOverrides 依次弹出供竞态场景
 *（排队判定与登记复查两次 getStatus 返回不同值的确定性注入）。 */
class FakeManager {
  state: EngineState = "starting"
  stateOverrides: EngineState[] = []
  ensureRunningCalls = 0
  private readonly listeners = new Set<(e: unknown) => void>()
  constructor(private readonly rpc: FakeQueueRpc) {}
  ensureRunning = async (): Promise<void> => {
    this.ensureRunningCalls += 1
  }
  getClient = (): unknown => this.rpc
  getStatus = (): { state: EngineState } => ({
    state: this.stateOverrides.length > 0 ? this.stateOverrides.shift()! : this.state,
  })
  reportSessionActive = (_sessionPath: string, _sessionId: string): void => {}
  markUserActivity = (_sessionPath: string): void => {}
  onEvent = (listener: (e: unknown) => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  get listenerCount(): number {
    return this.listeners.size
  }
  /** 状态迁移 + state_changed 扇出（真实管理器 transition 同步扇出语义） */
  setState(to: EngineState, from: EngineState = this.state): void {
    this.state = to
    for (const listener of [...this.listeners]) {
      listener({ type: "state_changed", projectPath: PROJECT, sessionPath: "", from, to })
    }
  }
  /** 定向发射（真实事件携 sessionPath；按登记键路由） */
  emitReady(sessionPath: string): void {
    for (const listener of [...this.listeners]) {
      listener({ type: "state_changed", projectPath: PROJECT, sessionPath, from: "starting", to: "ready" })
    }
  }
}

interface Harness {
  root: string
  agentDir: string
  sessionPath: string
  rpc: FakeQueueRpc
  manager: FakeManager
  registry: EngineRuntimeRegistry
  syntheticEvents: Array<Record<string, unknown>>
}

function setup(state: EngineState = "starting"): Harness {
  const root = mkdtempSync(join(tmpdir(), "rt-startup-queue-test-"))
  const agentDir = join(root, "agent")
  const sessionPath = join(agentDir, "sessions", encodeCwdToSessionDirName(PROJECT), `${DURABLE_ID}.jsonl`)
  mkdirSync(dirname(sessionPath), { recursive: true })
  writeFileSync(sessionPath, SESSION_FILE_BODY)
  const rpc = new FakeQueueRpc()
  rpc.bindSessionFile(sessionPath)
  const manager = new FakeManager(rpc)
  manager.state = state
  const syntheticEvents: Array<Record<string, unknown>> = []
  const registry = new EngineRuntimeRegistry(manager as unknown as EngineProcessManager, {
    listProjects: () => [PROJECT],
    agentDir,
    publishSyntheticEvent: (_projectPath: string, event: Record<string, unknown>) => {
      syntheticEvents.push(event)
    },
  })
  return { root, agentDir, sessionPath, rpc, manager, registry, syntheticEvents }
}

/** 会话文件中 text 出现次数（单副本断言） */
function occurrencesInSessionFile(sessionPath: string, text: string): number {
  return readFileSync(sessionPath, "utf8").split(text).length - 1
}

/** 排队监听器挂/退断言面：registry 构造另挂 crash 路由常驻订阅（engine-runtime
 *  2139 行），FakeManager.listenerCount 数不到排队监听；直读运行时内部 offManagerEvent
 *  槽（null = 已退订，仅排队存在期间非空）。 */
function queuedListenerActive(registry: EngineRuntimeRegistry): boolean {
  const rt = (registry as unknown as {
    runtimes: Map<string, { offManagerEvent: (() => void) | null }>
  }).runtimes.get(PROJECT)
  return rt?.offManagerEvent != null
}

describe("启动期 prompt 排队与就绪自动补投（engine-ux-visibility 任务 5）", () => {
  test("starting → 排队接住（200 queued 语义、零引擎调用）→ ready → 原样投递恰好一次（会话文件单副本 + 字节一致）", async () => {
    const h = setup("starting")
    try {
      const TEXT = "97s 事故回归：启动期消息应原样补投，字节不可变"
      const receipt = await h.registry.prompt(DURABLE_ID, { text: TEXT })
      // 200 排队语义：立即接住，未碰引擎 RPC（97s 事故形态：此前在 ensure 链等 84s）
      expect(receipt.disposition).toBe("queued")
      expect(receipt.queued).toBe(true)
      expect(h.rpc.promptCalls).toBe(0)
      // 按需挂监听：排队存在期间排队监听器在挂（registry 自有 crash 常驻订阅不计）
      expect(queuedListenerActive(h.registry)).toBe(true)

      // ready 事件（引擎冷启完成）→ 自动补投恰好一次
      h.manager.state = "ready"
      h.manager.emitReady(h.sessionPath)
      await vi.waitFor(() => expect(h.rpc.promptCalls).toBe(1))
      // 有界静置复查（misleading_success 对抗：确无第二次投递）
      await new Promise((r) => setTimeout(r, 150))
      expect(h.rpc.promptCalls).toBe(1)
      // 字节级原样（byte-once 双断言：RPC 收到的文本 + 会话文件落盘单副本）
      expect(h.rpc.prompts[0]).toBe(TEXT)
      expect(occurrencesInSessionFile(h.sessionPath, TEXT)).toBe(1)
      // 投递完成即退订：零常驻排队监听
      expect(queuedListenerActive(h.registry)).toBe(false)
      // 超时定时器已随取走清掉：静置后无 timeout 事件（不会有迟到的误报）
      expect(h.syntheticEvents).toHaveLength(0)
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("排队登记瞬间引擎恰已 ready（state_changed 错过竞态）→ 竞态复查立即补投不挂等", async () => {
    const h = setup("ready")
    try {
      // 竞态注入：排队门判定时 starting，挂监听后复查时已 ready（真实形态：
      // 挂监听前一瞬引擎迁移完成，state_changed 已发过收不到）
      h.manager.stateOverrides = ["starting", "ready"]
      const receipt = await h.registry.prompt(DURABLE_ID, { text: "race-ready" })
      // HTTP 已回排队语义（消息已接受），投递由竞态复查立即异步补发
      expect(receipt.disposition).toBe("queued")
      expect(receipt.queued).toBe(true)
      await vi.waitFor(() => expect(h.rpc.promptCalls).toBe(1))
      expect(h.rpc.prompts[0]).toBe("race-ready")
      expect(occurrencesInSessionFile(h.sessionPath, "race-ready")).toBe(1)
      // 立即投递后无残留订阅与超时误报
      expect(queuedListenerActive(h.registry)).toBe(false)
      expect(h.syntheticEvents).toHaveLength(0)
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("引擎永久失败（stale 形态）→ 等满 120s 超时：合成 queued_prompt_timeout、消息绝不投递；迟到的 ready 零投递", async () => {
    const h = setup("backoff")
    try {
      vi.useFakeTimers()
      try {
        const receipt = await h.registry.prompt(DURABLE_ID, { text: "timeout-msg" })
        expect(receipt.queued).toBe(true)
        // 引擎全程未 ready（backoff 循环 / worker 换件失败），假时钟推进到等待上限
        await vi.advanceTimersByTimeAsync(QUEUED_STARTUP_PROMPT_TIMEOUT_MS)
        expect(h.rpc.promptCalls).toBe(0)
        const timeoutEvent = h.syntheticEvents.find((e) => e.type === "queued_prompt_timeout")
        expect(timeoutEvent).toBeDefined()
        expect(timeoutEvent?.code).toBe("queued_timeout")
        expect(timeoutEvent?.sessionId).toBe(DURABLE_ID)
        // 超时即退订（零常驻排队监听）
        expect(queuedListenerActive(h.registry)).toBe(false)
        // stale 防护：超时后引擎才起来（迟到 ready 事件）→ 消息已失效，零投递
        h.manager.state = "ready"
        h.manager.emitReady(h.sessionPath)
        await vi.advanceTimersByTimeAsync(5_000)
        expect(h.rpc.promptCalls).toBe(0)
        // 会话文件从无此消息
        expect(occurrencesInSessionFile(h.sessionPath, "timeout-msg")).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("等待期 abort → 撤回（不拉引擎不走 ensure 链）；此后 ready 零投递", async () => {
    const h = setup("starting")
    try {
      const receipt = await h.registry.prompt(DURABLE_ID, { text: "cancel-me" })
      expect(receipt.queued).toBe(true)
      await h.registry.abort(DURABLE_ID)
      // 撤回不碰引擎：ensure 零调用（不走 ensureForSession）、引擎 abort 零调用
      expect(h.manager.ensureRunningCalls).toBe(0)
      expect(h.rpc.abortCalls).toBe(0)
      expect(queuedListenerActive(h.registry)).toBe(false)
      // 撤回后引擎就绪也不投递
      h.manager.state = "ready"
      h.manager.emitReady(h.sessionPath)
      await new Promise((r) => setTimeout(r, 150))
      expect(h.rpc.promptCalls).toBe(0)
      expect(occurrencesInSessionFile(h.sessionPath, "cancel-me")).toBe(0)
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("排队中第二个 prompt → 409 already_processing（不排两个）", async () => {
    const h = setup("starting")
    try {
      const first = await h.registry.prompt(DURABLE_ID, { text: "first" })
      expect(first.queued).toBe(true)
      const err = await h.registry.prompt(DURABLE_ID, { text: "second" }).then(
        () => {
          throw new Error("应当 409 拒绝，不应排队两条")
        },
        (e: unknown) => e as ApiError,
      )
      expect(err).toBeInstanceOf(ApiError)
      expect(err.status).toBe(409)
      expect(err.code).toBe("already_processing")
      expect(err.message).toContain("启动期排队")
      // 队列仍只有第一条：ready 后投递的是 first，恰一次
      h.manager.state = "ready"
      h.manager.emitReady(h.sessionPath)
      await vi.waitFor(() => expect(h.rpc.promptCalls).toBe(1))
      expect(h.rpc.prompts[0]).toBe("first")
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("backoff 期 prompt → 同样排队（crash 重启窗口）", async () => {
    const h = setup("backoff")
    try {
      const receipt = await h.registry.prompt(DURABLE_ID, { text: "backoff-msg" })
      expect(receipt.disposition).toBe("queued")
      expect(receipt.queued).toBe(true)
      expect(h.rpc.promptCalls).toBe(0)
      h.manager.state = "ready"
      h.manager.emitReady(h.sessionPath)
      await vi.waitFor(() => expect(h.rpc.promptCalls).toBe(1))
      expect(h.rpc.prompts[0]).toBe("backoff-msg")
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("stopped + 开门车道在途（stopped-with-open-in-progress）→ 排队并在 ready 后补投", async () => {
    const h = setup("stopped")
    try {
      // 制造在途车道：messages 触发 openLane（引擎未 ready → 车道轮询挂起）
      const msgsPromise = h.registry.messages(DURABLE_ID)
      await new Promise((r) => setTimeout(r, 50))
      // stopped 且车道在途 → 排队（非纯 stopped 冷态）
      const receipt = await h.registry.prompt(DURABLE_ID, { text: "lane-in-flight" })
      expect(receipt.queued).toBe(true)
      // 引擎就绪（车道轮询放行 + state_changed 事件）
      h.manager.state = "ready"
      h.manager.emitReady(h.sessionPath)
      await msgsPromise
      await vi.waitFor(() => expect(h.rpc.promptCalls).toBe(1))
      expect(h.rpc.prompts[0]).toBe("lane-in-flight")
      expect(occurrencesInSessionFile(h.sessionPath, "lane-in-flight")).toBe(1)
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("纯 stopped 冷态（无在途车道）→ 不排队走原同步 ensure 路径（503 engine_not_ready，行为零变化）", async () => {
    const h = setup("stopped")
    try {
      vi.useFakeTimers()
      try {
        const p = h.registry.prompt(DURABLE_ID, { text: "cold-start" })
        const errP = p.then(
          () => {
            throw new Error("应当走原路径 503，不应排队成功")
          },
          (e: unknown) => e as ApiError,
        )
        // openLane 有界等待 15s（250ms 轮询）全在假时钟内推进；resolveSession 的 fs
        // 宏任务链会消耗前置步数（首推几步无 timer 可触发），步数上限覆盖
        // fs 偏移 + 15s deadline（30s 假时钟裕量）防失控
        for (let i = 0; i < 120; i++) {
          await vi.advanceTimersByTimeAsync(250)
        }
        const err = await errP
        expect(err).toBeInstanceOf(ApiError)
        expect(err.status).toBe(503)
        expect(err.code).toBe("engine_not_ready")
        // 未排队：无合成事件、无引擎调用、无排队监听（registry 常驻 crash 订阅不计）
        expect(h.rpc.promptCalls).toBe(0)
        expect(h.syntheticEvents).toHaveLength(0)
        expect(queuedListenerActive(h.registry)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("回合进行中 prompt → 现有 409 already_processing 语义不变（ready 直投路径与 starting 排队门两路都先撞回合占用）", async () => {
    const h = setup("ready")
    try {
      // 正常路径首条 prompt：直投成功 → 回合占用（disposition=started 非 handled）
      const r1 = await h.registry.prompt(DURABLE_ID, { text: "turn-1" })
      expect(r1.disposition).toBe("started")
      expect(r1.queued).toBeUndefined()
      expect(h.rpc.promptCalls).toBe(1)

      // 引擎 ready：原 409（runTraced body 内回合表判定）保持
      const err1 = await h.registry.prompt(DURABLE_ID, { text: "turn-2" }).then(
        () => {
          throw new Error("应当 409")
        },
        (e: unknown) => e as ApiError,
      )
      expect(err1.status).toBe(409)
      expect(err1.code).toBe("already_processing")
      expect(err1.message).toContain("进行中的回合")

      // 引擎转 starting（crash 重启窗口）：排队门内回合占用仍优先于排队
      h.manager.state = "starting"
      const err2 = await h.registry.prompt(DURABLE_ID, { text: "turn-3" }).then(
        () => {
          throw new Error("应当 409")
        },
        (e: unknown) => e as ApiError,
      )
      expect(err2.status).toBe(409)
      expect(err2.code).toBe("already_processing")
      // 全程只投递过一次
      expect(h.rpc.promptCalls).toBe(1)
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("ready 后投递失败（open_failed）→ 不重试不双重投递，合成 queued_prompt_failed 可观测", async () => {
    const h = setup("starting")
    try {
      const receipt = await h.registry.prompt(DURABLE_ID, { text: "flush-fail" })
      expect(receipt.queued).toBe(true)
      // ready 瞬间注入 open 必败形态（绑定建立即失败）
      h.rpc.openShouldFail = true
      h.manager.state = "ready"
      h.manager.emitReady(h.sessionPath)
      await vi.waitFor(() => {
        expect(h.syntheticEvents.some((e) => e.type === "queued_prompt_failed")).toBe(true)
      })
      // 有界静置复查：不重试（byte-once 铁律：不确定是否送达即不再送）
      await new Promise((r) => setTimeout(r, 150))
      expect(h.rpc.promptCalls).toBe(0)
      expect(h.rpc.openCalls).toBe(1)
      const failEvent = h.syntheticEvents.find((e) => e.type === "queued_prompt_failed")
      expect(failEvent?.code).toBe("open_failed")
      expect(failEvent?.sessionId).toBe(DURABLE_ID)
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })
})
