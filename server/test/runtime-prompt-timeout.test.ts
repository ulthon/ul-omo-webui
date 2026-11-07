// session-polish 任务 1：prompt 等待超时（引擎可能迟到补跑）映射独立码 prompt_timeout。
// 覆盖对抗面：
// - 事故实录形态：网关 RpcClient 请求期限 30s 到期抛 RpcRequestTimeoutError
//   （message="Timeout waiting for response to prompt. Stderr: …"）→ ApiError 500
//   prompt_timeout（HTTP 状态与今日 generic internal 兜底一致，仅 code+message 变化）；
// - 排队停滞变体（promptStalledMessage 前缀）同族同映射；
// - 兄弟命令超时（list_sessions）不入 prompt 族（消息前缀锚定），原样上抛；
// - 409 already_processing（回合表守卫 + 引擎守卫消息映射两路）语义不变；
// - REST 序列化：toErrorResponse(prompt_timeout) → 500 {error:{code:"prompt_timeout"}}，
//   无身份的普通错误仍 500 internal 兜底。
// 确定性：fake 注入同步拒绝，settlePollMs 拉满测试生命期，禁真睡。
import { describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context } from "hono"
import type { EngineProcessManager } from "../src/engine/process-manager"
import { ApiError, toErrorResponse } from "../src/api/http"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"
import { isPromptWaitTimeoutError } from "../src/adapter/senpi-adapter"

const PROJECT = "/tmp/opencode/rt-prompt-timeout-proj"
const SESSIONS_DIR_NAME = `--${PROJECT.replace(/^\//, "").replaceAll("/", "-")}--`
const SESSION = "01c11152-9a2b-7c01-8d3e-952b49731ff1"

function sessionFile(agentDir: string, id: string): string {
  const dir = join(agentDir, "sessions", SESSIONS_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `2026-11-07T00-00-00-000Z_${id}.jsonl`)
  writeFileSync(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-11-07T00:00:00.000Z",
      cwd: PROJECT,
    })}\n`,
    "utf8",
  )
  return path
}

/** SDK RpcRequestTimeoutError 复刻（鸭子形状：code+name+消息；不 import SDK 内部类） */
function rpcTimeout(name: "prompt" | "list_sessions"): Error {
  const err = new Error(
    name === "prompt"
      ? "Timeout waiting for response to prompt. Stderr: "
      : "Timeout waiting for response to list_sessions. Stderr: ",
  )
  return Object.assign(err, { code: "rpc_request_timeout", name: "RpcRequestTimeoutError" })
}

/** fake 单会话引擎 RPC：prompt 可注入失败（同步拒绝，无时间因素） */
class FakeEngineRpc {
  readonly journal: string[] = []
  readonly handles: string[] = []
  private readonly listeners: Array<(event: unknown) => void> = []

  constructor(
    readonly sessionPath: string,
    readonly promptError?: unknown,
  ) {}

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
    const handle = `rpc-${this.handles.length + 1}`
    this.handles.push(handle)
    return { sessionId: handle, state: { sessionId: handle, sessionFile: options.sessionPath ?? this.sessionPath } }
  }

  async closeSession(): Promise<void> {}

  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return [
      { sessionId: "rpc-1", durableSessionId: SESSION, sessionPath: this.sessionPath, cwd: PROJECT, status: "open" },
    ]
  }

  async activeSessions(): Promise<Array<Record<string, unknown>>> {
    return this.listSessions()
  }

  async prompt(_message: string, options?: { streamingBehavior?: string }): Promise<string> {
    this.journal.push(options?.streamingBehavior ? "prompt:queued" : "prompt:started")
    if (this.promptError !== undefined) throw this.promptError
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

  emit(event: unknown): void {
    for (const fn of [...this.listeners]) fn(event)
  }

  async sendExtensionUIResponse(_response: Record<string, unknown>): Promise<void> {}
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

/** fake 管理器（runtime-session-routing.test.ts 同款最小面） */
class FakeManager {
  readonly rpcs = new Map<string, FakeEngineRpc>()
  private readonly listeners: Array<(event: unknown) => void> = []

  ensureRunning = async (): Promise<void> => {}
  getClient = (sessionPath: string) => this.rpcs.get(sessionPath)
  getStatus = (sessionPath: string): { state: "ready"; pendingPermissions: string[] } => ({
    state: "ready",
    pendingPermissions: [],
  })
  reportPermissionAnswered = (_sessionPath: string, _requestId: string): void => {}
  reportSessionActive = (_sessionPath: string, _sessionId: string): void => {}
  markUserActivity = (_sessionPath: string): void => {}
  onEvent = (listener: (event: unknown) => void): (() => void) => {
    this.listeners.push(listener)
    return () => {
      const i = this.listeners.indexOf(listener)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }
  emit(event: unknown): void {
    for (const fn of [...this.listeners]) fn(event)
  }
}

async function setup(promptError?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "rt-prompt-timeout-test-"))
  try {
    const agentDir = join(root, "agent")
    mkdirSync(join(root, "proj"), { recursive: true })
    const path = sessionFile(agentDir, SESSION)
    const rpc = new FakeEngineRpc(path, promptError)
    const manager = new FakeManager()
    manager.rpcs.set(path, rpc)
    const registry = new EngineRuntimeRegistry(manager as unknown as EngineProcessManager, {
      listProjects: () => [PROJECT],
      agentDir,
      settlePollMs: 3_600_000,
      publishSyntheticEvent: () => {},
      onRoundSettled: () => {},
    })
    return { root, rpc, path, registry }
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    throw err
  }
}

describe("prompt 等待超时映射 prompt_timeout（session-polish 任务 1）", () => {
  test("网关 30s 期限超时（事故实录形态）→ ApiError 500 prompt_timeout，文案携 sessionPath", async () => {
    const { root, path, registry } = await setup(rpcTimeout("prompt"))
    try {
      const err = await registry.prompt(SESSION, { text: "迟到投递的事故形态" }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      const apiErr = err as ApiError
      // HTTP 状态保持今日兜底路径的 500，仅 code+server message 变化
      expect(apiErr.status).toBe(500)
      expect(apiErr.code).toBe("prompt_timeout")
      // 文案携 sessionPath 与迟到投递处置指引（与 T7 already_processing 同款口径）
      expect(apiErr.message).toContain(path)
      expect(apiErr.message).toContain("迟到投递")
      expect(apiErr.message).toContain("勿立即重发")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("排队停滞变体（promptStalledMessage 前缀，仅 name 身份）同族同映射", async () => {
    const stalled = Object.assign(new Error("prompt was received by the host but not accepted within 5 minutes"), {
      name: "RpcRequestTimeoutError",
    })
    const { root, registry } = await setup(stalled)
    try {
      const err = await registry.prompt(SESSION, { text: "停滞变体" }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(500)
      expect((err as ApiError).code).toBe("prompt_timeout")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("兄弟命令超时（list_sessions）不入 prompt 族：原样上抛非 ApiError", async () => {
    const { root, registry } = await setup(rpcTimeout("list_sessions"))
    try {
      const err = await registry.prompt(SESSION, { text: "兄弟命令" }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(ApiError)
      expect((err as Error).message).toBe("Timeout waiting for response to list_sessions. Stderr: ")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("409 already_processing 语义不变：回合表守卫与引擎守卫消息映射两路", async () => {
    // 路 1：回合占用 → runningTurns 表直接 409（不等引擎守卫）
    const s1 = await setup()
    try {
      await s1.registry.prompt(SESSION, { text: "第一发" })
      const err = await s1.registry.prompt(SESSION, { text: "第二发" }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(409)
      expect((err as ApiError).code).toBe("already_processing")
    } finally {
      rmSync(s1.root, { recursive: true, force: true })
    }
    // 路 2：引擎侧守卫报错消息（外部驱动绕过回合表）→ catch 映射 409 不变
    const s2 = await setup(new Error("already processing"))
    try {
      const err = await s2.registry.prompt(SESSION, { text: "外部占用" }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(409)
      expect((err as ApiError).code).toBe("already_processing")
    } finally {
      rmSync(s2.root, { recursive: true, force: true })
    }
  })

  test("REST 序列化：prompt_timeout → 500 wire {error:{code}}；普通错误仍 500 internal 兜底", () => {
    const c = { json: (body: unknown, status: number) => ({ body, status }) } as unknown as Context
    const mapped = toErrorResponse(
      c,
      new ApiError(
        500,
        "prompt_timeout",
        "prompt 等待响应超时（引擎可能仍在处理并迟到投递）：/x/s.jsonl，请稍候查看输出，勿立即重发",
      ),
    ) as unknown as {
      body: { error: { code: string; message: string } }
      status: number
    }
    expect(mapped.status).toBe(500)
    expect(mapped.body.error.code).toBe("prompt_timeout")
    expect(mapped.body.error.message).toContain("勿立即重发")
    // 无身份普通错误（映射前的今日形态）兜底不变
    const generic = toErrorResponse(c, rpcTimeout("prompt")) as unknown as {
      body: { error: { code: string } }
      status: number
    }
    expect(generic.status).toBe(500)
    expect(generic.body.error.code).toBe("internal")
  })

  test("谓词 isPromptWaitTimeoutError：身份+消息前缀双重锚定", () => {
    // 命中：30s 期限（code 身份）与停滞变体（name 身份）
    expect(isPromptWaitTimeoutError(rpcTimeout("prompt"))).toBe(true)
    expect(
      isPromptWaitTimeoutError(
        Object.assign(new Error("prompt was received by the host but not accepted within 5 minutes"), {
          name: "RpcRequestTimeoutError",
        }),
      ),
    ).toBe(true)
    // 不命中：兄弟命令同身份但消息前缀不同
    expect(isPromptWaitTimeoutError(rpcTimeout("list_sessions"))).toBe(false)
    // 不命中：消息同前缀但无 RpcRequestTimeoutError 身份字段
    expect(isPromptWaitTimeoutError(new Error("Timeout waiting for response to prompt. Stderr: "))).toBe(false)
    // 不命中：非对象 / null / 字符串
    expect(isPromptWaitTimeoutError(null)).toBe(false)
    expect(isPromptWaitTimeoutError(undefined)).toBe(false)
    expect(isPromptWaitTimeoutError("Timeout waiting for response to prompt")).toBe(false)
  })
})
