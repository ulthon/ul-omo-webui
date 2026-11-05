/**
 * SenpiAdapter 流程单测——fake RpcClient 全部以真实引擎实录 fixture 应答（零 token）。
 * 覆盖：握手/活跃会话语义/messages 游标/prompt/abort/权限应答/todo/usage/模型/事件订阅/错误路径。
 */
import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SenpiAdapter, type RpcClientOptions, type SenpiRpcClient } from "../src/adapter/senpi-adapter"
import { RPC_CLIENT_CAPABILITIES_ENV } from "../src/engine/rpc-capabilities"
import { EngineAdapterError, type EngineEntry, type EngineEvent } from "../src/adapter/engine-adapter"

const FIXTURES = new URL("./fixtures/protocol/", import.meta.url).pathname

function load<T>(name: string): T {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8")) as T
}

const openFixture = load<{
  sessionId: string
  state: { sessionId: string; sessionFile: string }
}>("open-session.json")
const entriesFixture = load<{ persistedEntries: EngineEntry[] }>("todo-state.json").persistedEntries
const imageEntry = load<EngineEntry>("image-message-entry.json")
const statsFixture = load<Record<string, unknown>>("session-stats.json")
const modelsFixture = load<Array<Record<string, unknown>>>("models.json")
const thinkingFixture = load<string[]>("thinking-levels.json")
const rpcRows = load<Array<Record<string, unknown>>>("list-sessions.json")

/** 会话条目样例（形态照 verification/01 结论 3 的 message entry实录） */
const sampleEntries: EngineEntry[] = [
  {
    type: "model_change",
    id: "a1",
    parentId: null,
    timestamp: "2026-10-06T11:21:01.000Z",
    provider: "zai-coding-cn",
    modelId: "glm-5.3-flash",
  },
  {
    type: "message",
    id: "b2",
    parentId: "a1",
    timestamp: "2026-10-06T11:21:01.770Z",
    message: { role: "user", content: [{ type: "text", text: "回复：OK" }], timestamp: 1791285656175 },
  },
  ...entriesFixture,
  imageEntry,
]

/** fake RpcClient：记录调用，按 fixture 形态应答 */
class FakeRpcClient implements SenpiRpcClient {
  calls: Array<{ method: string; args?: unknown }> = []
  ready = true
  entries: EngineEntry[] = sampleEntries
  leafId: string | null = "b2"
  readonly sentResponses: Array<Record<string, unknown>> = []
  readonly listeners: Array<(e: EngineEvent) => void> = []
  private opened = false

  async start(): Promise<void> {
    this.calls.push({ method: "start" })
  }

  async stop(): Promise<void> {
    this.calls.push({ method: "stop" })
  }

  async setClientInfo(): Promise<void> {
    this.calls.push({ method: "set_client_info" })
  }

  /** start() 的就绪探测经由 cast 后的 send 访问（spike 实证用法） */
  send(message: unknown): Promise<{ success: boolean }> {
    this.calls.push({ method: "send", args: message })
    return Promise.resolve({ success: this.ready })
  }

  async openSession(options: { sessionPath?: string }): Promise<{ sessionId: string; state: { sessionId?: string; sessionFile?: string } }> {
    this.calls.push({ method: "open_session", args: options })
    this.opened = true
    return {
      sessionId: "rpc-1",
      state: { sessionId: openFixture.state.sessionId, sessionFile: options.sessionPath ?? openFixture.state.sessionFile },
    }
  }

  async closeSession(): Promise<void> {
    this.calls.push({ method: "close_session" })
    this.opened = false
  }

  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return rpcRows
  }

  async getEntries(since?: string): Promise<{ entries: EngineEntry[]; leafId: string | null }> {
    this.calls.push({ method: "get_entries", args: since })
    if (!this.opened) throw new Error("no active session")
    if (since) return { entries: this.entries.filter((e) => e.id === since && false), leafId: this.leafId } // 游标语义：增量 0 条
    return { entries: this.entries, leafId: this.leafId }
  }

  async fork(): Promise<{ text: string; cancelled: boolean }> {
    this.calls.push({ method: "fork" })
    throw new Error("fork not expected in adapter tests")
  }

  async prompt(message: string, options?: { thinkingLevel?: string }): Promise<unknown> {
    this.calls.push({ method: "prompt", args: { message, thinkingLevel: options?.thinkingLevel } })
    if (!this.opened) throw new Error("no active session")
    return "started"
  }

  async abort(): Promise<void> {
    this.calls.push({ method: "abort" })
  }

  async clearQueue(): Promise<unknown> {
    this.calls.push({ method: "clearQueue" })
    return { steering: [], followUp: [], ordered: [] }
  }
  async getSteeringMessages(): Promise<string[]> {
    return []
  }
  async getFollowUpMessages(): Promise<string[]> {
    return []
  }

  onEvent(listener: (e: EngineEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners.splice(this.listeners.indexOf(listener), 1)
    }
  }

  async sendExtensionUIResponse(response: Record<string, unknown>): Promise<void> {
    this.sentResponses.push(response)
  }

  /** q1 提问卡片对账源（get_state.pendingQuestions）；本测试无未决提问场景，恒空 */
  async getState(): Promise<Record<string, unknown>> {
    return { pendingQuestions: [] }
  }

  async getAvailableModels(): Promise<Array<Record<string, unknown>>> {
    return modelsFixture
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    return thinkingFixture
  }

  commandsFixture: Array<Record<string, unknown>> = []
  async getCommands(): Promise<Array<Record<string, unknown>>> {
    this.calls.push({ method: "get_commands" })
    if (!this.opened) throw new Error("missing_session_id")
    return this.commandsFixture
  }

  async getSessionStats(): Promise<Record<string, unknown>> {
    return statsFixture
  }

  compactResult: unknown = { summary: "s", firstKeptEntryId: "e1", tokensBefore: 100 }
  async compact(): Promise<unknown> {
    this.calls.push({ method: "compact" })
    if (!this.opened) throw new Error("missing_session_id")
    return this.compactResult
  }

  async getMedia(): Promise<{ type: "image"; data: string; mimeType: string }> {
    return { type: "image", data: "ZmFrZQ==", mimeType: "image/png" }
  }
}

function makeAdapter(fake: FakeRpcClient): SenpiAdapter {
  return new SenpiAdapter({
    projectDir: "/tmp/opencode/w2-7-proj",
    agentDir: "/root/.pi/agent",
    provider: "zai-coding-cn",
    modelId: "glm-5.3-flash",
    engineCliPath: "/fake/cli.js",
    pluginDir: "/fake/plugin",
    clientFactory: () => fake,
  })
}

describe("spawn env 能力声明（docs08-r6 任务 5）", () => {
  test("createClient env 引用共享常量（与 process-manager 生产 spawn 路径同源）", async () => {
    let captured: RpcClientOptions | undefined
    const fake = new FakeRpcClient()
    const adapter = new SenpiAdapter({
      projectDir: "/tmp/opencode/w2-7-proj",
      agentDir: "/root/.pi/agent",
      engineCliPath: "/fake/cli.js",
      pluginDir: "/fake/plugin",
      clientFactory: (o) => {
        captured = o
        return fake
      },
    })
    await adapter.start()
    // stdio 能力唯一通道：自建 RpcClient 的 env 必须与共享常量一致（勿硬编码）
    expect(captured?.env?.SENPI_RPC_CLIENT_CAPABILITIES).toBe(RPC_CLIENT_CAPABILITIES_ENV.SENPI_RPC_CLIENT_CAPABILITIES)
    // 握手仍走 set_client_info（stdio 下仅宽度信令，能力面静默空操作）
    expect(fake.calls.some((c) => c.method === "set_client_info")).toBe(true)
  })
})

describe("SenpiAdapter 未启动错误路径", () => {
  test("start 前 prompt/messages/abort/openSession 报 not_started", async () => {
    const adapter = makeAdapter(new FakeRpcClient())
    for (const fn of [
      () => adapter.messages(),
      () => adapter.prompt({ text: "x" }),
      () => adapter.abort(),
      () => adapter.closeSession(),
      () => adapter.usage(),
      () => adapter.todoState(),
    ]) {
      // 方法为 async：同步 toThrow 捕不到，须走 rejects（bun:test 两者兼容，vitest 只认后者）
      await expect(fn()).rejects.toThrow(EngineAdapterError)
    }
    let err: unknown
    try {
      await adapter.openSession({})
    } catch (e) {
      err = e
    }
    expect((err as EngineAdapterError).code).toBe("not_started")
  })
})

describe("SenpiAdapter 握手与活跃会话", () => {
  test("start 轮询 get_protocol_info 成功后可用；open_session 返回 durable id 并跟踪活跃", async () => {
    const fake = new FakeRpcClient()
    const adapter = makeAdapter(fake)
    await adapter.start()
    const opened = await adapter.openSession({ provider: "zai-coding-cn", modelId: "glm-5.3-flash", thinkingLevel: "low" })
    // durable id 来自 state.sessionId，routing handle 来自顶层 sessionId（verification/01 结论 2）
    expect(opened.sessionId).toBe(openFixture.state.sessionId)
    expect(opened.sessionPath).toBe(openFixture.state.sessionFile)
    expect(opened.routingId).toBe("rpc-1")
    expect(adapter.getActiveSession()?.sessionId).toBe(openFixture.state.sessionId)
    // 停止后活跃清空
    await adapter.stop()
    expect(adapter.getActiveSession()).toBe(null)
  })

  test("就绪探测始终失败 -> engine_not_ready 且子进程被回收", async () => {
    const fake = new FakeRpcClient()
    fake.ready = false
    const adapter = new SenpiAdapter({
      projectDir: "/tmp/opencode/w2-7-proj",
      agentDir: "/root/.pi/agent",
      engineCliPath: "/fake/cli.js",
      pluginDir: "/fake/plugin",
      readyProbeMax: 3,
      readyProbeIntervalMs: 1,
      clientFactory: () => fake,
    })
    let err: unknown
    try {
      await adapter.start()
    } catch (e) {
      err = e
    }
    expect((err as EngineAdapterError).code).toBe("engine_not_ready")
    // 失败路径回收子进程
    expect(fake.calls.some((c) => c.method === "stop")).toBe(true)
  })

  test("open_session 响应缺 state 字段 -> open_failed", async () => {
    class BrokenOpenClient extends FakeRpcClient {
      override async openSession(): Promise<{ sessionId: string; state: { sessionId?: string; sessionFile?: string } }> {
        return { sessionId: "rpc-1", state: {} }
      }
    }
    const adapter = makeAdapter(new BrokenOpenClient())
    await adapter.start()
    let err: unknown
    try {
      await adapter.openSession({})
    } catch (e) {
      err = e
    }
    expect((err as EngineAdapterError).code).toBe("open_failed")
  })
})

describe("SenpiAdapter 会话操作（fixture 应答）", () => {
  test("messages 全量/游标语义 + prompt 回执 + abort", async () => {
    const fake = new FakeRpcClient()
    const adapter = makeAdapter(fake)
    await adapter.start()
    await adapter.openSession({ thinkingLevel: "low" })

    const page = await adapter.messages()
    expect(page.entries.length).toBe(sampleEntries.length)
    expect(page.cursor).toBe("b2")
    // 游标语义：since=leafId 增量 0 条（verification/01）
    const nextPage = await adapter.messages(page.cursor ?? undefined)
    expect(nextPage.entries.length).toBe(0)

    const receipt = await adapter.prompt({ text: "回复：OK", thinkingLevel: "low" })
    expect(receipt.disposition).toBe("started")
    const promptCall = fake.calls.find((c) => c.method === "prompt")
    expect((promptCall!.args as { thinkingLevel?: string }).thinkingLevel).toBe("low")

    await adapter.abort()
    expect(fake.calls.some((c) => c.method === "abort")).toBe(true)
  })

  test("无效 cursor（引擎 Entry not found）上抛 cursor_invalid，不再静默降级全量（任务 5）", async () => {
    const fake = new FakeRpcClient()
    const rawGetEntries = fake.getEntries.bind(fake)
    // 覆写后 fake.calls 不再自动记录：本地计数器作引擎调用探针
    let engineCalls = 0
    fake.getEntries = async (since?: string) => {
      engineCalls++
      if (since) throw new Error("Entry not found: stale-cursor")
      return rawGetEntries(since)
    }
    const adapter = makeAdapter(fake)
    await adapter.start()
    await adapter.openSession({ thinkingLevel: "low" })
    let err: unknown
    try {
      await adapter.messages("stale-cursor")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(EngineAdapterError)
    expect((err as EngineAdapterError).code).toBe("cursor_invalid")
    // 降级全量路径已删除：首查即上抛，无第二次调用（不触发无参全量）
    expect(engineCalls).toBe(1)
  })

  test("无活跃会话时 prompt/messages 报 no_active_session", async () => {
    const adapter = makeAdapter(new FakeRpcClient())
    await adapter.start()
    let err: unknown
    try {
      await adapter.prompt({ text: "x" })
    } catch (e) {
      err = e
    }
    expect((err as EngineAdapterError).code).toBe("no_active_session")
  })

  test("sessionsList 走 SDK 直读（显式 sessionDir）", async () => {
    const adapter = makeAdapter(new FakeRpcClient())
    // 真实 FS：w2-7-proj 的会话库在 W2 spike 已产出
    const rows = await adapter.sessionsList("/tmp/opencode/w2-7-proj")
    expect(rows.length).toBeGreaterThanOrEqual(2)
    const withParent = rows.filter((r) => r.parentSessionPath)
    expect(withParent.length).toBe(1) // fork 血缘（verification/05 P1-1）
  })

  test("activeSessions 映射 RPC 行（无 parent/agent 字段）", async () => {
    const adapter = makeAdapter(new FakeRpcClient())
    await adapter.start()
    const rows = await adapter.activeSessions()
    expect(rows.length).toBe(rpcRows.length)
    expect(rows[0]!.durableSessionId).toBe(String(rpcRows[0]!.durableSessionId))
    expect(rows[0]!).not.toHaveProperty("parent")
    expect(rows[0]!).not.toHaveProperty("agent")
  })

  test("permissionRespond 发出实证应答帧", async () => {
    const fake = new FakeRpcClient()
    const adapter = makeAdapter(fake)
    await adapter.start()
    await adapter.permissionRespond("57114366-c83c-404c-9bd2-3ef5fef8dcbc", { value: "Allow once" })
    await adapter.permissionRespond("b28d8432", { confirmed: true })
    await adapter.permissionRespond("x", { cancelled: true })
    expect(fake.sentResponses).toEqual([
      { type: "extension_ui_response", id: "57114366-c83c-404c-9bd2-3ef5fef8dcbc", value: "Allow once" },
      { type: "extension_ui_response", id: "b28d8432", confirmed: true },
      { type: "extension_ui_response", id: "x", cancelled: true },
    ])
  })

  test("todoState 读最新 senpi.todo-state 条目（abandoned 终态）", async () => {
    const adapter = makeAdapter(new FakeRpcClient())
    await adapter.start()
    await adapter.openSession({})
    const todo = await adapter.todoState()
    expect(todo?.phases[0]!.tasks.map((t) => t.status)).toEqual(["abandoned", "abandoned"])
  })

  test("usage/models/thinkingLevels 映射 fixture", async () => {
    const adapter = makeAdapter(new FakeRpcClient())
    await adapter.start()
    await adapter.openSession({})
    const u = await adapter.usage()
    expect(u.cost).toBe(Number(statsFixture.cost))
    expect((await adapter.modelsList()).length).toBe(modelsFixture.length)
    expect(await adapter.thinkingLevels()).toEqual(["low", "high", "max"])
  })

  test("compactSession 映射 CompactionResult（tokensBefore/estimatedTokensAfter 窄化，docs08-r5 任务 8）", async () => {
    const fake = new FakeRpcClient()
    fake.compactResult = {
      summary: "压缩摘要",
      firstKeptEntryId: "entry-9",
      tokensBefore: 32881,
      estimatedTokensAfter: 9120,
      usage: { input: 1 },
      details: { internal: true },
    }
    const adapter = makeAdapter(fake)
    await adapter.start()
    await adapter.openSession({})
    const result = await adapter.compactSession()
    expect(result).toEqual({ summary: "压缩摘要", firstKeptEntryId: "entry-9", tokensBefore: 32881, estimatedTokensAfter: 9120 })
    expect(fake.calls.some((c) => c.method === "compact")).toBe(true)
  })

  test("compactSession 无活跃会话拒（no_active_session，与 usage 同口径）", async () => {
    const adapter = makeAdapter(new FakeRpcClient())
    await adapter.start()
    let err: unknown
    try {
      await adapter.compactSession()
    } catch (e) {
      err = e
    }
    expect((err as EngineAdapterError).code).toBe("no_active_session")
  })

  test("events 订阅/退订 + readImagePart", async () => {
    const fake = new FakeRpcClient()
    const adapter = makeAdapter(fake)
    await adapter.start()
    await adapter.openSession({})
    const seen: EngineEvent[] = []
    const sub = adapter.events((e) => seen.push(e))
    fake.listeners[0]!({ type: "agent_start" })
    expect(seen).toEqual([{ type: "agent_start" }])
    sub.unsubscribe()
    expect(fake.listeners.length).toBe(0)
    const img = await adapter.readImagePart("call_x", 0)
    expect(img.type).toBe("image")
  })

  test("capabilities 如实反映降级（verification/05）", () => {
    const adapter = makeAdapter(new FakeRpcClient())
    expect(adapter.capabilities.agentsList).toBe(false)
    expect(adapter.capabilities.editResend).toBe(false)
    expect(adapter.capabilities.modelsList).toBe(true)
    expect(adapter.capabilities.todoState).toBe(true)
    expect(adapter.capabilities.usageStats).toBe(true)
    expect(adapter.capabilities.exportHtml).toBe(true)
  })

  test("agentsList 抛 unsupported（无协议面降级）", async () => {
    const adapter = makeAdapter(new FakeRpcClient())
    let err: unknown
    try {
      await adapter.agentsList()
    } catch (e) {
      err = e
    }
    expect((err as EngineAdapterError).code).toBe("unsupported")
  })

  test("commands 映射 get_commands 行（name/description/source 窄化）；无活跃会话拒绝", async () => {
    const fake = new FakeRpcClient()
    fake.commandsFixture = [
      { name: "account", description: "List and manage accounts.", source: "extension", syntax: "slash", sourceInfo: { source: "builtin" } },
      { name: "skill:ast-grep", source: "skill", syntax: "dollar" },
      { name: "w18-spike", description: "模板", source: "prompt" },
      { name: "", source: "extension" },
    ]
    const adapter = makeAdapter(fake)
    await adapter.start()
    // open_session 前（无活跃会话）：fake 以 missing_session_id 拒绝（06 spike 实证口径）
    let err: unknown
    try {
      await adapter.commands()
    } catch (e) {
      err = e
    }
    expect((err as EngineAdapterError).code).toBe("no_active_session")
    await adapter.openSession({})
    const rows = await adapter.commands()
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ name: "account", source: "extension", description: "List and manage accounts." })
    expect(rows[1]).toEqual({ name: "skill:ast-grep", source: "skill" })
    expect(rows[2]).toEqual({ name: "w18-spike", source: "prompt", description: "模板" })
    expect(fake.calls.some((c) => c.method === "get_commands")).toBe(true)
  })
})

/** 引擎重启后残留旧绑定的 unknown_session 兜底（2026-11-03 实录）：
 *  op 报 unknown_session → 按 sessionPath 自动重开 → 重试恰好一次；
 *  只兜 unknown_session，其它错误原样透传。 */
describe("SenpiAdapter unknown_session 自动重开重试", () => {
  /** prompt 可编程失败的 fake（unknown_session 用引擎 RpcSessionRegistryError 的
   *  实录形态：message="unknown_session" 的普通 Error） */
  class FlakyPromptClient extends FakeRpcClient {
    failWith: Error | null = null
    failTimes = 0
    reopenError: Error | null = null
    /** 从第几次 open_session 调用开始失败（setup 的初始打开不算重开） */
    reopenFailFromCall = Number.POSITIVE_INFINITY
    openCallCount = 0
    promptAttempts = 0
    override async prompt(): Promise<unknown> {
      this.promptAttempts++
      if (this.failTimes > 0) {
        this.failTimes--
        throw this.failWith
      }
      return "started"
    }
    override async openSession(options: { sessionPath?: string }): Promise<{ sessionId: string; state: { sessionId?: string; sessionFile?: string } }> {
      this.openCallCount++
      if (this.reopenError && this.openCallCount >= this.reopenFailFromCall) {
        const err = this.reopenError
        this.reopenError = null
        throw err
      }
      return super.openSession(options)
    }
  }

  async function setup(fake: FlakyPromptClient) {
    const adapter = makeAdapter(fake)
    await adapter.start()
    await adapter.openSession({})
    return adapter
  }

  test("unknown_session → 重开 → 重试成功返回正常结果", async () => {
    const fake = new FlakyPromptClient()
    fake.failWith = new Error("unknown_session")
    fake.failTimes = 1
    const adapter = await setup(fake)
    const openCallsBefore = fake.calls.filter((c) => c.method === "open_session").length
    const receipt = await adapter.prompt({ text: "重试后应成功" })
    expect(receipt.disposition).toBe("started")
    // 兜底重开了一次 open_session，prompt 恰好重试一次（首次失败 + 重试成功）
    expect(fake.calls.filter((c) => c.method === "open_session").length).toBe(openCallsBefore + 1)
    expect(fake.promptAttempts).toBe(2)
  })

  test("session_closing（worker 隔离，2026-11-06 扩）→ 同兕底重开重试成功", async () => {
    const fake = new FlakyPromptClient()
    fake.failWith = new Error("session_closing")
    fake.failTimes = 1
    const adapter = await setup(fake)
    const openCallsBefore = fake.calls.filter((c) => c.method === "open_session").length
    const receipt = await adapter.prompt({ text: "隔离后应自动重开" })
    expect(receipt.disposition).toBe("started")
    expect(fake.calls.filter((c) => c.method === "open_session").length).toBe(openCallsBefore + 1)
    expect(fake.promptAttempts).toBe(2)
  })

  test("非 Error 实例的普通对象错误（网关层实录形态，2026-11-06 修）→ 兕底仍生效", async () => {
    const fake = new FlakyPromptClient()
    fake.failWith = { message: "unknown_session", code: "internal" } as unknown as Error
    fake.failTimes = 1
    const adapter = await setup(fake)
    const receipt = await adapter.prompt({ text: "普通对象错误也重开" })
    expect(receipt.disposition).toBe("started")
    expect(fake.promptAttempts).toBe(2)
  })

  test("并发 open_session 同会话在途合并（02:37 实录四路拉取竞态，2026-11-06 修）", async () => {
    const fake = new FlakyPromptClient()
    const adapter = await setup(fake)
    const before = fake.calls.filter((c) => c.method === "open_session").length
    const [a, b] = await Promise.all([adapter.openSession({ sessionPath: "/tmp/dur-x.jsonl" }), adapter.openSession({ sessionPath: "/tmp/dur-x.jsonl" })])
    expect(fake.calls.filter((c) => c.method === "open_session").length).toBe(before + 1)
    expect(a.sessionPath).toBe(b.sessionPath)
  })

  test("重开仍失败 → 原样报错（不无限重试）", async () => {
    const fake = new FlakyPromptClient()
    fake.failWith = new Error("unknown_session")
    fake.failTimes = 2 // 首次失败 + 重试仍失败
    fake.reopenError = new Error("unknown_session")
    fake.reopenFailFromCall = 2 // 第 2 次 open_session（即兑底重开）失败；第 1 次是 setup 初始打开
    const adapter = await setup(fake)
    await expect(adapter.prompt({ text: "x" })).rejects.toThrow("unknown_session")
    expect(fake.promptAttempts).toBe(1) // 重开失败：不重试
  })

  test("非 unknown_session 错误不触发重开重试", async () => {
    const fake = new FlakyPromptClient()
    fake.failWith = new Error("provider_overloaded")
    fake.failTimes = 1
    const adapter = await setup(fake)
    const openCallsBefore = fake.calls.filter((c) => c.method === "open_session").length
    await expect(adapter.prompt({ text: "x" })).rejects.toThrow("provider_overloaded")
    expect(fake.calls.filter((c) => c.method === "open_session").length).toBe(openCallsBefore)
    expect(fake.promptAttempts).toBe(1)
  })

  test("并发失败共享同一次重开（in-flight 去重）", async () => {
    const fake = new FlakyPromptClient()
    fake.failWith = new Error("unknown_session")
    fake.failTimes = 2
    const adapter = await setup(fake)
    const [a, b] = await Promise.all([adapter.prompt({ text: "a" }), adapter.prompt({ text: "b" })])
    expect(a.disposition).toBe("started")
    expect(b.disposition).toBe("started")
    // 两次并发失败只触发一次 open_session 重开
    expect(fake.calls.filter((c) => c.method === "open_session").length).toBe(2) // 初始 + 一次重开
  })
})

/** todoState 磁盘直读（任务 5 / A-2）：按窗反扫命中 senpi.todo-state 即停，
 *  纯看不占引擎；会话文件不在（未落盘/别名）回退引擎分页读（旧语义等价）。 */
describe("SenpiAdapter todoState 磁盘直读", () => {
  const tempDirs: string[] = []
  function mkTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "t5-todo-"))
    tempDirs.push(dir)
    return dir
  }

  /** 造会话 jsonl：header + fixture 条目（含多条 senpi.todo-state）+ 可选尾部噪声 */
  function makeTodoFile(tailNoiseCount = 0): string {
    const dir = mkTempDir()
    const path = join(dir, "s.jsonl")
    const lines = [JSON.stringify({ type: "session", version: 3, id: "hdr-todo", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/p" })]
    for (const e of entriesFixture) lines.push(JSON.stringify(e))
    for (let i = 0; i < tailNoiseCount; i++) {
      lines.push(
        JSON.stringify({
          type: "message",
          id: `noise${String(i).padStart(4, "0")}`,
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: `n${i}` }] },
        }),
      )
    }
    writeFileSync(path, lines.join("\n") + "\n")
    return path
  }

  test("磁盘反扫命中最新 senpi.todo-state（与旧引擎读值等价），零 get_entries 调用", async () => {
    const fake = new FakeRpcClient()
    const adapter = makeAdapter(fake)
    await adapter.start()
    await adapter.openSession({ sessionPath: makeTodoFile() })
    const todo = await adapter.todoState()
    expect(todo?.phases[0]!.tasks.map((t) => t.status)).toEqual(["abandoned", "abandoned"])
    // 引擎零参与（纯看不拉引擎）
    expect(fake.calls.some((c) => c.method === "get_entries")).toBe(false)
  })

  test("todo 条目在窗外更早处（噪声 > PAGE_LIMIT）：按窗续扫仍命中，仍零引擎调用", async () => {
    const fake = new FakeRpcClient()
    const adapter = makeAdapter(fake)
    await adapter.start()
    // 300 条尾部噪声 > 216 单窗：首窗全噪声无命中，须续窗才扫到 fixture 内 todo 条目
    await adapter.openSession({ sessionPath: makeTodoFile(300) })
    const todo = await adapter.todoState()
    expect(todo?.phases[0]!.tasks.map((t) => t.status)).toEqual(["abandoned", "abandoned"])
    expect(fake.calls.some((c) => c.method === "get_entries")).toBe(false)
  })

  test("会话文件不在（未落盘/别名）：回退引擎读，行为与旧实现等价", async () => {
    const fake = new FakeRpcClient()
    const adapter = makeAdapter(fake)
    await adapter.start()
    await adapter.openSession({ sessionPath: join(mkTempDir(), "missing.jsonl") })
    const todo = await adapter.todoState()
    expect(todo?.phases[0]!.tasks.map((t) => t.status)).toEqual(["abandoned", "abandoned"])
    expect(fake.calls.some((c) => c.method === "get_entries")).toBe(true)
  })

  test("磁盘文件无任何 todo 条目：扫尽文件头返回 null，不撞引擎", async () => {
    const dir = mkTempDir()
    const path = join(dir, "s.jsonl")
    const lines = [JSON.stringify({ type: "session", version: 3, id: "hdr-nt", timestamp: "t", cwd: "/p" })]
    for (let i = 0; i < 3; i++) {
      lines.push(
        JSON.stringify({
          type: "message",
          id: `m${i}`,
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        }),
      )
    }
    writeFileSync(path, lines.join("\n") + "\n")
    const fake = new FakeRpcClient()
    const adapter = makeAdapter(fake)
    await adapter.start()
    await adapter.openSession({ sessionPath: path })
    expect(await adapter.todoState()).toBeNull()
    expect(fake.calls.some((c) => c.method === "get_entries")).toBe(false)
  })

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
})
