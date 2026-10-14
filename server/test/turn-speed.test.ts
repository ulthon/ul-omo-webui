/**
 * A5（docs08-r3 任务 6）：回合速度环运行时行为证明。
 * 经 EngineRuntimeRegistry 公共面驱动真实 ProjectRuntime → SenpiAdapter → fake RPC：
 * 直接向 adapter 的事件回调喂 wire 形态的 message_start/message_end（与 stores/messages.ts
 * fixtures 同一形态：{type, id, sessionId, message:{role, usage}}），断言 usage() 附加的
 * turnSpeed 快照。断言只锁样本数、有限性与单调量级，不锁具体 tok/s 数值（flaky 对抗）。
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineProcessManager } from "../src/engine/process-manager"
import { EngineRuntimeRegistry } from "../src/api/engine-runtime"

const PROJECT = "/tmp/opencode/rt-turnspeed-proj"
const SESSIONS_DIR_NAME = `--${PROJECT.replace(/^\//, "").replaceAll("/", "-")}--`
const DURABLE_ID = "01c11141-49e9-7fb0-a845-952b49731e54"

/** header v3 形态照 runtime-thinking.test.ts 同款实录 */
function sessionFile(agentDir: string, id: string): string {
  const dir = join(agentDir, "sessions", SESSIONS_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `2026-10-13T00-00-00-000Z_${id}.jsonl`)
  writeFileSync(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-10-13T00:00:00.000Z",
      cwd: PROJECT,
    })}\n`,
    "utf8",
  )
  return path
}

/** fake 引擎 RPC：可手动 emit wire 事件（engine-runtime 的 adapter.events 回调经 onEvent 挂上） */
class FakeEngineRpc {
  private listeners: Array<(e: Record<string, unknown>) => void> = []
  private routing = 1

  /** 最近一次 open_session 的 routing handle（事件归属键；invalidate 后重新 open 会换新） */
  get lastHandle(): string {
    return `rpc-${this.routing - 1}`
  }

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
    return { sessionId: handle, state: { sessionId: handle, sessionFile: options.sessionPath } }
  }
  async closeSession(): Promise<void> {}
  async listSessions(): Promise<Array<Record<string, unknown>>> {
    return [{ sessionId: "rpc-0", durableSessionId: DURABLE_ID, sessionPath: "", cwd: PROJECT, status: "open" }]
  }
  async prompt(): Promise<string> {
    return "started"
  }
  async abort(): Promise<void> {}
  onEvent(listener: (e: Record<string, unknown>) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }
  emit(event: Record<string, unknown>): void {
    for (const l of [...this.listeners]) l(event)
  }
  async sendExtensionUIResponse(): Promise<void> {}
  async getAvailableModels(): Promise<unknown[]> {
    return []
  }
  async getAvailableThinkingLevels(): Promise<string[]> {
    return ["low", "high", "max"]
  }
  async getSessionStats(): Promise<Record<string, unknown>> {
    return { sessionId: DURABLE_ID, tokens: { input: 10, output: 20, total: 30 }, cost: 0 }
  }
  async getMedia(): Promise<unknown> {
    return { type: "image", data: "", mimeType: "image/png" }
  }
  async getEntries(): Promise<{ entries: unknown[]; leafId: null }> {
    return { entries: [], leafId: null }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Harness {
  registry: EngineRuntimeRegistry
  rpc: FakeEngineRpc
  cleanup: () => void
}

async function setup(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "rt-turnspeed-test-"))
  const agentDir = join(root, "agent")
  mkdirSync(join(root, "proj"), { recursive: true })
  sessionFile(agentDir, DURABLE_ID)
  const rpc = new FakeEngineRpc()
  const fakeManager = {
    ensureRunning: async () => {},
    getClient: (_project: string) => rpc,
    getStatus: () => ({ state: "ready" }),
    onEvent: (_listener: (event: unknown) => void) => () => {},
    stop: async () => {},
    stopAll: async () => {},
  } as unknown as EngineProcessManager
  const registry = new EngineRuntimeRegistry(fakeManager, { listProjects: () => [PROJECT], agentDir })
  // 首次 usage：ensure() 建 adapter 挂事件回调 + switchTo 回填 handle→durable 映射
  await registry.usage(DURABLE_ID)
  return { registry, rpc, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 喂一条完整配对（start 与 end 间隔 ms 毫秒），sessionId 用最新 routing handle。
 * 事件形态按 QA SSE 实证：真实 wire 无消息 id 字段，配对按 sessionId 串行假设。 */
async function feedPair(rpc: FakeEngineRpc, output: number, ms = 4): Promise<void> {
  const handle = rpc.lastHandle
  rpc.emit({ type: "message_start", sessionId: handle, message: { role: "assistant" } })
  await sleep(ms)
  rpc.emit({
    type: "message_end",
    sessionId: handle,
    message: { role: "assistant", usage: { input: 10, output, totalTokens: output + 10 } },
  })
}

describe("A5 回合速度环（engine-runtime message_start/end 挂点）", () => {
  test("assistant start→end 配对产出样本：tok/s 有限正值，均值与单样本一致", async () => {
    const { registry, rpc, cleanup } = await setup()
    try {
      await feedPair(rpc, 100, 25)
      const usage = await registry.usage(DURABLE_ID)
      expect(usage.turnSpeed).toBeDefined()
      expect(usage.turnSpeed?.turns.length).toBe(1)
      const sample = usage.turnSpeed?.turns[0]
      // 只锁量级不锁数值：output 100 / 25ms → 数千 tok/s 量级，限界宽松防 flaky
      expect(sample?.tokPerSec).toBeFinite()
      expect(sample!.tokPerSec).toBeGreaterThan(0)
      expect(sample!.tokPerSec).toBeLessThan(1_000_000)
      expect(Number.isNaN(new Date(sample!.endedAt).getTime())).toBe(false)
      expect(usage.turnSpeed?.averageTokPerSec).toBeCloseTo(sample!.tokPerSec, 6)
    } finally {
      cleanup()
    }
  })

  test("user 消息 start/end 一律忽略（无 usage 实证，05 P1-4）", async () => {
    const { registry, rpc, cleanup } = await setup()
    try {
      const handle = rpc.lastHandle
      rpc.emit({ type: "message_start", sessionId: handle, message: { role: "user" } })
      await sleep(4)
      rpc.emit({ type: "message_end", sessionId: handle, message: { role: "user", usage: { output: 999 } } })
      const usage = await registry.usage(DURABLE_ID)
      expect(usage.turnSpeed?.turns.length).toBe(0)
    } finally {
      cleanup()
    }
  })

  test("user start/end 间插在 assistant 两侧：user 不触碰在途表，assistant 正确配对", async () => {
    const { registry, rpc, cleanup } = await setup()
    try {
      const handle = rpc.lastHandle
      rpc.emit({ type: "message_start", sessionId: handle, message: { role: "assistant" } })
      await sleep(3)
      // 回合内的 user/toolResult 消息事件（真实流中间插形态）
      rpc.emit({ type: "message_start", sessionId: handle, message: { role: "user" } })
      rpc.emit({ type: "message_end", sessionId: handle, message: { role: "user" } })
      rpc.emit({ type: "message_start", sessionId: handle, message: { role: "toolResult" } })
      rpc.emit({ type: "message_end", sessionId: handle, message: { role: "toolResult" } })
      await sleep(3)
      rpc.emit({
        type: "message_end",
        sessionId: handle,
        message: { role: "assistant", usage: { output: 60 } },
      })
      const usage = await registry.usage(DURABLE_ID)
      expect(usage.turnSpeed?.turns.length).toBe(1)
      expect(usage.turnSpeed?.turns[0].tokPerSec).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })

  test("丢弃规则：无配对起点 / output≤0 / usage 缺失均不入环", async () => {
    const { registry, rpc, cleanup } = await setup()
    try {
      // 无 start 的 end（引擎重启后起点丢失形态）
      rpc.emit({ type: "message_end", id: "m-orphan", sessionId: rpc.lastHandle, message: { role: "assistant", usage: { output: 100 } } })
      // output = 0 / 负数
      await feedPair(rpc, 0)
      await feedPair(rpc, -5)
      // usage 缺失（assistant 异常样本）
      rpc.emit({ type: "message_start", id: "m-nousage", sessionId: rpc.lastHandle, message: { role: "assistant" } })
      await sleep(4)
      rpc.emit({ type: "message_end", id: "m-nousage", sessionId: rpc.lastHandle, message: { role: "assistant" } })
      const usage = await registry.usage(DURABLE_ID)
      expect(usage.turnSpeed?.turns.length).toBe(0)
    } finally {
      cleanup()
    }
  })

  test("环容量 N=20 滑动：25 条配对后保留最近 20 条、最旧 5 条被挤出", async () => {
    const { registry, rpc, cleanup } = await setup()
    try {
      for (let i = 1; i <= 25; i++) {
        // 首条标记性超大 output：若未被挤出必然顶破量级上界（防"只统计到 1 条"的假绿同理）
        await feedPair(rpc, i === 1 ? 999_999 : 100, 2)
      }
      const usage = await registry.usage(DURABLE_ID)
      const turns = usage.turnSpeed?.turns ?? []
      expect(turns.length).toBe(20)
      for (const t of turns) {
        expect(t.tokPerSec).toBeFinite()
        expect(t.tokPerSec).toBeGreaterThan(0)
        expect(t.tokPerSec).toBeLessThan(100_000) // 999999/0.001=1e9 顶破，被挤出即通过
      }
      // 多样本均值 ≠ 单样本：证明环内是 20 条而非 1 条（misleading success 对抗）
      const avg = usage.turnSpeed?.averageTokPerSec ?? 0
      const manual = turns.reduce((s, t) => s + t.tokPerSec, 0) / turns.length
      expect(avg).toBeCloseTo(manual, 6)
    } finally {
      cleanup()
    }
  })

  test("invalidate（stopAll 路径）清空速度环与在途起点", async () => {
    const { registry, rpc, cleanup } = await setup()
    try {
      await feedPair(rpc, 100)
      // 残留一个未配对的 start：invalidate 后它的 end 不得产生样本
      rpc.emit({ type: "message_start", id: "m-lingering", sessionId: rpc.lastHandle, message: { role: "assistant" } })
      const handleBefore = rpc.lastHandle
      await registry.stopAll()
      // stopAll 后先走一次 usage：switchTo 重新 open → 新 routing handle + 映射重建
      const cleared = await registry.usage(DURABLE_ID)
      expect(cleared.turnSpeed?.turns.length).toBe(0)
      expect(rpc.lastHandle).not.toBe(handleBefore)
      await feedPair(rpc, 100)
      const usage = await registry.usage(DURABLE_ID)
      expect(usage.turnSpeed?.turns.length).toBe(1)
      expect(usage.turnSpeed?.turns[0].tokPerSec).toBeLessThan(100_000)
    } finally {
      cleanup()
    }
  })
})
