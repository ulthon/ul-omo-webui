/**
 * r11 todo 11：权限等待态中止前置 Deny（task-10 spike 定向修复）。
 *
 * spike 实证（.omo/evidence/r11/task-10-abort-spike.md §2.2）：权限挂起回合的
 * abort 在引擎面是静默 no-op——HTTP 200/11ms 后零帧、回合悬起 >5min、仅引擎重
 * 建可解除；提问等待同路径却有效（question_resolved +7ms → agent_end +176ms，
 * §2.3）。修复 = abort() 在 adapter.abort() 前把本回合挂起的权限请求经既有应
 * 答通道逐个取消（{cancelled:true}，与前端权限卡「忽略」同 wire 形态且对四型
 * 请求通用）：挂起工具以取消结果返回 → 回合自然收束 → agent_end 可达。
 *
 * 确定性断言（fake RPC 调用日志按发生序记录，帧序非时序，禁「不再现」式）：
 * 1. 帧序：deny(perm-1) → deny(perm-2) → abort（deny 严格先于 abort）；
 * 2. wire 帧形态：{type:"extension_ui_response", id, cancelled:true}（复用既有
 *    应答通道，非新造协议）；
 * 3. 解忙：每帧后 reportPermissionAnswered，挂起清单清零（deny 后不残留挂起）；
 * 4. 回合收尾可达：deny 后引擎回 agent_end（fake 经 onEvent 注入）→ streamingId
 *    清位 → peekRunStates 由 waiting 转空（服务端 runState 权威源回落）；
 * 5. 回归：无挂起权限时零 deny 帧纯 abort（流式路径零变化）；非本回合会话
 *    abort 不误拒（streamingId 守卫）。
 */
import { describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineProcessManager } from "../src/engine/process-manager"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"

const PROJECT = "/tmp/opencode/rt-abort-perm-proj"
const SESSIONS_DIR_NAME = `--${PROJECT.replace(/^\//, "").replaceAll("/", "-")}--`
const SESSION_ID = "01c11151-9a2b-7c01-8d3e-952b49731e99"
const OTHER_SESSION_ID = "01c11151-9a2b-7c01-8d3e-952b49731e88"

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

/** fake 引擎 RPC：abort/权限应答按真实发生序记日志（帧序断言源）；onEvent 存监
 *  听器供测试注入引擎回声帧（agent_end 收尾，模拟 spike §2.3 提问等待同型回声） */
class FakeEngineRpc {
  /** wire 调用日志：`deny:<requestId>` 与 `abort` 按发生顺序 */
  readonly journal: string[] = []
  /** sendExtensionUIResponse 收到的完整 wire 帧（形态断言源） */
  readonly sentResponses: Array<Record<string, unknown>> = []
  /** open_session 返回的 routing handle（注入回声帧 sessionId 用） */
  readonly handles: string[] = []
  private readonly listeners: Array<(event: unknown) => void> = []
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
    this.handles.push(handle)
    return { sessionId: handle, state: { sessionId: handle, sessionFile: options.sessionPath ?? this.sessionPath } }
  }

  async closeSession(): Promise<void> {}

  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return [
      { sessionId: "rpc-1", durableSessionId: SESSION_ID, sessionPath: this.sessionPath, cwd: PROJECT, status: "open" },
    ]
  }

  async prompt(): Promise<string> {
    return "started"
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

  /** 测试注入引擎回声帧（真实引擎：deny 后挂起工具返回 → agent_end） */
  emit(event: unknown): void {
    for (const fn of [...this.listeners]) fn(event)
  }

  async sendExtensionUIResponse(response: Record<string, unknown>): Promise<void> {
    this.sentResponses.push(response)
    this.journal.push(`deny:${String(response.id)}`)
  }

  async getAvailableModels(): Promise<unknown[]> {
    return []
  }
  async getAvailableThinkingLevels(): Promise<string[]> {
    return ["low", "high", "max"]
  }
  async getSessionStats(): Promise<Record<string, unknown>> {
    return {
      sessionId: SESSION_ID,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
      cost: 0,
      contextUsage: { tokens: 15, contextWindow: 1000000, percent: 0.001 },
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
  async getSteeringMessages(): Promise<unknown> {
    return []
  }
  async getFollowUpMessages(): Promise<unknown> {
    return []
  }
  async clearQueue(): Promise<unknown> {
    return { steering: [], followUp: [], ordered: [] }
  }
  async compact(): Promise<unknown> {
    throw new Error("compact not expected in abort tests")
  }
  async fork(): Promise<{ text: string; cancelled: boolean }> {
    throw new Error("fork not expected in abort tests")
  }
}

/** fake 管理器：pendingPermissions 可编程（模拟引擎权限挂起快照），应答解忙
 *  模拟真实 reportPermissionAnswered 的清账语义（process-manager pendingPermissions.delete） */
class FakeManager {
  pendingPermissions: string[] = []
  /** reportPermissionAnswered 收到 (project, requestId) 按序记录 */
  readonly answered: Array<{ project: string; requestId: string }> = []

  constructor(private readonly rpc: FakeEngineRpc) {}

  ensureRunning = async (): Promise<void> => {}
  getClient = (_project: string) => this.rpc
  getStatus = (): { state: "ready"; pendingPermissions: string[] } => ({
    state: "ready",
    pendingPermissions: [...this.pendingPermissions],
  })
  reportPermissionAnswered = (project: string, requestId: string): void => {
    this.answered.push({ project, requestId })
    this.pendingPermissions = this.pendingPermissions.filter((id) => id !== requestId)
  }
  onEvent = (_listener: (event: unknown) => void): (() => void) => () => {}
  stop = async (): Promise<void> => {}
  stopAll = async (): Promise<void> => {}
}

function makeRegistry(rpc: FakeEngineRpc, manager: FakeManager, agentDir: string): EngineRuntimeRegistry {
  return new EngineRuntimeRegistry(manager as unknown as EngineProcessManager, {
    listProjects: () => [PROJECT],
    agentDir,
  })
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "rt-abort-perm-test-"))
  const agentDir = join(root, "agent")
  mkdirSync(join(root, "proj"), { recursive: true })
  const rpc = new FakeEngineRpc(sessionFile(agentDir, SESSION_ID))
  sessionFile(agentDir, OTHER_SESSION_ID)
  const manager = new FakeManager(rpc)
  const registry = makeRegistry(rpc, manager, agentDir)
  return { root, rpc, manager, registry }
}

describe("权限等待态中止前置 Deny（r11 todo 11，spike 定向）", () => {
  test("帧序：deny(perm-1) → deny(perm-2) → abort；wire 帧形态 cancelled；解忙清账不残留", async () => {
    const { root, rpc, manager, registry } = await setup()
    try {
      // 建立 webui 驱动回合（streamingId 占用），注入两个挂起权限请求
      await registry.prompt(SESSION_ID, { text: "触发权限门" })
      manager.pendingPermissions = ["perm-1", "perm-2"]

      await registry.abort(SESSION_ID)

      // 帧序硬断言：deny 逐个且严格先于 adapter.abort（修复点本身）
      expect(rpc.journal).toEqual(["deny:perm-1", "deny:perm-2", "abort"])
      // wire 形态：既有应答通道（extension_ui_response）+ 通用取消语义
      expect(rpc.sentResponses).toEqual([
        { type: "extension_ui_response", id: "perm-1", cancelled: true },
        { type: "extension_ui_response", id: "perm-2", cancelled: true },
      ])
      // 解忙：逐个 reportPermissionAnswered（项目级记账清账）
      expect(manager.answered).toEqual([
        { project: PROJECT, requestId: "perm-1" },
        { project: PROJECT, requestId: "perm-2" },
      ])
      // deny 后挂起清单不残留（stale-state 防护）
      expect(manager.pendingPermissions).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("回合收尾可达：deny 后 agent_end 回声 → streamingId 清位 → peekRunStates 由 waiting 转空", async () => {
    const { root, rpc, manager, registry } = await setup()
    try {
      await registry.prompt(SESSION_ID, { text: "触发权限门" })
      manager.pendingPermissions = ["perm-1"]

      // 中止前：权限挂起压制 running → 服务端 runState 权威源 = waiting
      const path = await registry.sessionPath(SESSION_ID)
      const before = await registry.peekRunStates(PROJECT)
      expect(before?.get(path)).toBe("waiting")

      await registry.abort(SESSION_ID)
      expect(rpc.journal).toEqual(["deny:perm-1", "abort"])

      // 引擎回声：deny 解权限门 → 挂起工具取消返回 → agent_end（wire handle 归属）
      rpc.emit({ type: "agent_end", sessionId: rpc.handles[0] })

      // 回合收尾：streamingId 清位 → active 路径清空 → runState 不再报 waiting
      const after = await registry.peekRunStates(PROJECT)
      expect(after).not.toBeNull()
      expect(after!.size).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("回归：无挂起权限时 abort 零 deny 帧纯 abort（流式路径零变化）", async () => {
    const { root, rpc, manager, registry } = await setup()
    try {
      await registry.prompt(SESSION_ID, { text: "普通流式回合" })
      // pendingPermissions 保持空

      await registry.abort(SESSION_ID)

      expect(rpc.journal).toEqual(["abort"])
      expect(rpc.sentResponses).toEqual([])
      expect(manager.answered).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("守卫：非本回合会话 abort 不误拒挂起权限（streamingId 归属校验）", async () => {
    const { root, rpc, manager, registry } = await setup()
    try {
      // 会话 A 建立 webui 驱动回合并挂起权限；对会话 B 调 abort
      await registry.prompt(SESSION_ID, { text: "回合在 A" })
      manager.pendingPermissions = ["perm-1"]

      await registry.abort(OTHER_SESSION_ID)

      // B 的 abort 不得消费 A 的权限挂起（跨会话误拒防护）；仅常规 abort
      expect(rpc.journal).toEqual(["abort"])
      expect(rpc.sentResponses).toEqual([])
      expect(manager.answered).toEqual([])
      expect(manager.pendingPermissions).toEqual(["perm-1"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
