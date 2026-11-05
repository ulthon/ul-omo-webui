/**
 * SenpiAdapter 引擎原生分页回归（plan engine-open-read-batch 任务 4 / A-1）：
 * messages() 以 maxBytes 8MiB 页循环拼接直至 hasMore=false；24MB 总预算与无进展双守卫
 * 防引擎异常死循环；游标失效降级不再无参整读；response_too_large 结构化上抛。
 * 零 token：fake RpcClient 纯内存应答。
 */
import { describe, expect, test } from "vitest"
import { SenpiAdapter, type SenpiRpcClient } from "../src/adapter/senpi-adapter"
import { EngineAdapterError, type EngineEntry } from "../src/adapter/engine-adapter"

/** 引擎默认页 8MiB（get-entries-page.js DEFAULT_ENTRY_PAGE_BYTES；adapter 常量同源对齐） */
const PAGE_MAX_BYTES = 8 * 1024 * 1024

type PageResult = { entries: EngineEntry[]; leafId: string | null; hasMore?: boolean; nextSince?: string }
type PageRequest = { limit?: number; maxBytes?: number }

function entry(id: string, extra?: Partial<EngineEntry>): EngineEntry {
  return { type: "message", id, parentId: null, timestamp: "2026-11-06T00:00:00.000Z", ...extra }
}

/** 精简 fake：只实现 messages() 链路触面（start 探测/openSession/getEntries），
 *  以 respond 脚本按调用序应答并记录每次请求的 since/maxBytes。 */
class PagingFakeRpcClient {
  calls: Array<{ since: string | undefined; maxBytes: number | undefined }> = []
  respond: (since: string | undefined, page: PageRequest | undefined, callNo: number) => Promise<PageResult> = async () => {
    throw new Error("fake 分页脚本未配置")
  }

  async start(): Promise<void> {}
  async setClientInfo(): Promise<void> {}
  send(): Promise<{ success: boolean }> {
    return Promise.resolve({ success: true })
  }
  async openSession(options: { sessionPath?: string }): Promise<{ sessionId: string; state: { sessionId?: string; sessionFile?: string } }> {
    return { sessionId: "rpc-1", state: { sessionId: "durable-1", sessionFile: options.sessionPath ?? "/tmp/pager.jsonl" } }
  }
  async getEntries(since?: string, page?: PageRequest): Promise<PageResult> {
    this.calls.push({ since, maxBytes: page?.maxBytes })
    return this.respond(since, page, this.calls.length)
  }
}

function makeAdapter(fake: PagingFakeRpcClient): SenpiAdapter {
  return new SenpiAdapter({
    projectDir: "/tmp/opencode/w2-7-proj",
    agentDir: "/root/.pi/agent",
    provider: "zai-coding-cn",
    modelId: "glm-5.3-flash",
    engineCliPath: "/fake/cli.js",
    pluginDir: "/fake/plugin",
    // 精简 fake 未实现完整协议面：messages 链路只触上述五方法，cast 安全
    clientFactory: () => fake as unknown as SenpiRpcClient,
  })
}

async function openedAdapter(fake: PagingFakeRpcClient): Promise<SenpiAdapter> {
  const adapter = makeAdapter(fake)
  await adapter.start()
  await adapter.openSession({ thinkingLevel: "low" })
  return adapter
}

describe("messages() 引擎原生分页循环（任务 4）", () => {
  test("多页拼接完整且每页请求携带 maxBytes 8MiB", async () => {
    const fake = new PagingFakeRpcClient()
    // misleading_success_output 防线：第 1 页必须回 hasMore=true——若实现单发即返回，
    // 拼接结果不含 e3 且 calls 不为 2，断言即失败（证明循环真实发生而非单页透传）
    const scripted: PageResult[] = [
      { entries: [entry("e1"), entry("e2")], leafId: "L", hasMore: true, nextSince: "e2" },
      { entries: [entry("e3")], leafId: "L", hasMore: false },
    ]
    fake.respond = async (_since, _page, callNo) => {
      const page = scripted[callNo - 1]
      if (!page) throw new Error("fake 分页脚本耗尽")
      return page
    }
    const adapter = await openedAdapter(fake)

    const page = await adapter.messages()
    expect(page.entries.map((e) => e.id)).toEqual(["e1", "e2", "e3"])
    // 读尽语义不变：cursor=leafId，续读增量 0 条（verification/01）
    expect(page.cursor).toBe("L")
    expect(page.leafId).toBe("L")
    expect(page.hasMore).toBeUndefined()
    expect(fake.calls.length).toBe(2)
    expect(fake.calls[0]).toEqual({ since: undefined, maxBytes: PAGE_MAX_BYTES })
    expect(fake.calls[1]).toEqual({ since: "e2", maxBytes: PAGE_MAX_BYTES })
  })

  test("游标失效上抛 cursor_invalid（任务 5：不再静默降级全量），调用有界", async () => {
    const fake = new PagingFakeRpcClient()
    fake.respond = async (since) => {
      if (since) throw new Error("Entry not found: stale-cursor")
      // 降级路径已删除：不应发生无参全量读
      throw new Error("fake 不应被无参调用（降级全量已删除）")
    }
    const adapter = await openedAdapter(fake)

    let err: unknown
    try {
      await adapter.messages("stale-cursor")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(EngineAdapterError)
    expect((err as EngineAdapterError).code).toBe("cursor_invalid")
    // 误导性成功输出防线：首查即上抛，无降级第二次调用
    expect(fake.calls.length).toBe(1)
  })

  test("引擎回 response_too_large 结构化上抛（EngineAdapterError），不裸传 RPC 错误", async () => {
    const fake = new PagingFakeRpcClient()
    fake.respond = async () => {
      const err = new Error("history exceeds one answer budget") as Error & { name?: string; errorCode?: string }
      err.name = "RpcCommandError"
      err.errorCode = "response_too_large"
      throw err
    }
    const adapter = await openedAdapter(fake)

    const err: unknown = await adapter.messages().then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(EngineAdapterError)
    expect((err as EngineAdapterError).code).toBe("response_too_large")
  })

  test("nextSince 永续推进且 hasMore 恒真 → 24MB 总预算截停，调用有界", async () => {
    const fake = new PagingFakeRpcClient()
    // malformed_input 防线：引擎每页回 ~9MB 单条且 hasMore 恒 true——字节预算 24MB
    // 在第 3 页后截停（2 页 ~18MB 未达预算，3 页 ~28MB 达标），断言有限调用不悬挂
    const BIG = "x".repeat(9 * 1024 * 1024)
    fake.respond = async (_since, _page, callNo) => ({
      entries: [entry(`e${callNo}`, { big: BIG })],
      leafId: "L",
      hasMore: true,
      nextSince: `p${callNo}`,
    })
    const adapter = await openedAdapter(fake)

    const page = await adapter.messages()
    expect(fake.calls.length).toBe(3)
    expect(page.entries.map((e) => e.id)).toEqual(["e1", "e2", "e3"])
    expect(page.hasMore).toBe(true)
    expect(page.nextSince).toBe("p3")
    // 截停 cursor=最后交付条目 id（非 leafId）：客户端续读不丢未交付区间
    expect(page.cursor).toBe("e3")
    expect(fake.calls.every((c) => c.maxBytes === PAGE_MAX_BYTES)).toBe(true)
  })

  test("nextSince 原地踏步 → 无进展守卫快速截停，不重复拼接", async () => {
    const fake = new PagingFakeRpcClient()
    let n = 0
    fake.respond = async () => {
      n++
      // 恒回同页同游标：第二轮 since="e1" 时 nextSince 原地踏步 → 守卫截停
      return { entries: [entry("e1")], leafId: "L", hasMore: true, nextSince: "e1" }
    }
    const adapter = await openedAdapter(fake)

    const page = await adapter.messages()
    expect(fake.calls.length).toBe(2)
    expect(n).toBe(2)
    expect(page.entries.map((e) => e.id)).toEqual(["e1"])
    expect(page.hasMore).toBe(true)
    expect(fake.calls.every((c) => c.maxBytes === PAGE_MAX_BYTES)).toBe(true)
  })
})
