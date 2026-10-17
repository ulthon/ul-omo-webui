/**
 * SenpiAdapter 流程单测——fake RpcClient 全部以真实引擎实录 fixture 应答（零 token）。
 * 覆盖：握手/活跃会话语义/messages 游标/prompt/abort/权限应答/todo/usage/模型/事件订阅/错误路径。
 */
import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { SenpiAdapter, type RpcClientOptions, type SenpiRpcClient } from "../src/adapter/senpi-adapter"
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

  test("无效 cursor（引擎 Entry not found）降级全量返回", async () => {
    const fake = new FakeRpcClient()
    const rawGetEntries = fake.getEntries.bind(fake)
    fake.getEntries = async (since?: string) => {
      if (since) throw new Error("Entry not found: stale-cursor")
      return rawGetEntries()
    }
    const adapter = makeAdapter(fake)
    await adapter.start()
    await adapter.openSession({ thinkingLevel: "low" })
    const page = await adapter.messages("stale-cursor")
    expect(page.entries.length).toBe(sampleEntries.length)
    expect(page.cursor).toBe("b2")
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
