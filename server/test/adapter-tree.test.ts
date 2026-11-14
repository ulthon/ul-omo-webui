/**
 * SenpiAdapter 会话树 RPC 四封装单测（session-branching todo 2）——零 token，纯内存 fake。
 * 覆盖：navigateTree（entryId/targetId 寻址折叠、归一回包、CAS 透传、streaming/压缩互斥
 * 409 映射、寻址守卫、stale_leaf 原样上抛）、getTree（透传）、editAssistantMessage
 * （outcome 归一、CAS 透传、409、参数守卫）、continueFromLeaf（CAS 透传、409）、
 * capabilities 能力位（treeNavigation 默认 true / editResend 维持 false 待翻转）。
 * 错误形态按引擎实录：RPC 面错误经 RpcCommandError（message+errorCode）鸭子到达；
 * ContinueFromLeafError（code="streaming"）与压缩互斥（无 errorCode 的普通 Error，
 * message 前缀 "Wait for the current compaction"）两种锚定都验。
 */
import { describe, expect, test } from "vitest"
import { SenpiAdapter, type SenpiRpcClient } from "../src/adapter/senpi-adapter"
import { ApiError } from "../src/api/http"
import { EngineAdapterError, type EngineEntry, type EngineTreeNode } from "../src/adapter/engine-adapter"

/** 精简 fake：只实现树链路触面（start 探测/openSession + 四树方法），按需可编程失败 */
class TreeFakeRpcClient {
  calls: Array<{ method: string; args?: unknown }> = []
  /** 可编程失败（下一次树调用抛出；null=健康） */
  failWith: unknown = null
  navigateTreeResult: {
    cancelled: boolean
    leafId: string | null
    editorText?: string
    aborted?: boolean
    summaryEntry?: { id?: unknown; [k: string]: unknown } | null
  } = { cancelled: false, leafId: "e5" }
  getTreeResult: { tree: EngineTreeNode[]; leafId: string | null } = { tree: [], leafId: "e5" }
  editResult: {
    outcome: "edited" | "unchanged" | "cancelled"
    entry?: unknown
    leafId: string | null
    aborted?: boolean
    summaryEntryId?: string
  } = { outcome: "edited", leafId: "e6" }

  async start(): Promise<void> {}
  async setClientInfo(): Promise<void> {}
  send(): Promise<{ success: boolean }> {
    return Promise.resolve({ success: true })
  }
  async openSession(options: { sessionPath?: string }): Promise<{ sessionId: string; state: { sessionId?: string; sessionFile?: string } }> {
    return { sessionId: "rpc-1", state: { sessionId: "durable-tree", sessionFile: options.sessionPath ?? "/tmp/tree-qa.jsonl" } }
  }

  private guard(): void {
    if (this.failWith !== null) throw this.failWith
  }

  async navigateTree(
    targetId: string,
    options?: { intent?: "select" | "resume"; expectedLeafId?: string },
  ): Promise<{
    cancelled: boolean
    leafId: string | null
    editorText?: string
    aborted?: boolean
    summaryEntry?: { id?: unknown; [k: string]: unknown } | null
  }> {
    this.calls.push({ method: "navigate_tree", args: { targetId, ...options } })
    this.guard()
    return this.navigateTreeResult
  }

  async getTree(): Promise<{ tree: EngineTreeNode[]; leafId: string | null }> {
    this.calls.push({ method: "get_tree" })
    this.guard()
    return this.getTreeResult
  }

  async editAssistantMessage(
    entryId: string,
    text: string,
    options?: { expectedLeafId?: string },
  ): Promise<{
    outcome: "edited" | "unchanged" | "cancelled"
    entry?: unknown
    leafId: string | null
    aborted?: boolean
    summaryEntryId?: string
  }> {
    this.calls.push({ method: "edit_assistant_message", args: { entryId, text, ...options } })
    this.guard()
    return this.editResult
  }

  async continueFromLeaf(options?: { expectedLeafId?: string }): Promise<void> {
    this.calls.push({ method: "continue_from_leaf", args: options })
    this.guard()
  }
}

function makeAdapter(fake: TreeFakeRpcClient): SenpiAdapter {
  return new SenpiAdapter({
    projectDir: "/tmp/opencode/sb-w1-proj",
    agentDir: "/tmp/opencode/sb-w1-agent",
    provider: "zai-coding-cn",
    modelId: "glm-5.3-flash",
    engineCliPath: "/fake/cli.js",
    pluginDir: "/fake/plugin",
    // 精简 fake 未实现完整协议面：树链路只触上述方法，cast 安全（PagingFakeRpcClient 同款）
    clientFactory: () => fake as unknown as SenpiRpcClient,
  })
}

async function openedAdapter(fake: TreeFakeRpcClient): Promise<SenpiAdapter> {
  const adapter = makeAdapter(fake)
  await adapter.start()
  await adapter.openSession({ thinkingLevel: "low" })
  return adapter
}

/** 引擎实录错误形态工厂：RPC 面 RpcCommandError 鸭子（message + errorCode） */
function rpcCommandError(message: string, errorCode: string): Error {
  return Object.assign(new Error(message), { errorCode })
}

describe("navigateTree（RPC navigate_tree）", () => {
  test("entryId 寻址 select happy：折叠为 targetId 发帧，editorText/leafId/summaryEntryId 归一，CAS+intent 透传", async () => {
    const fake = new TreeFakeRpcClient()
    fake.navigateTreeResult = {
      cancelled: false,
      leafId: "e3",
      editorText: "回复：OK",
      summaryEntry: { id: "sum-1", type: "branch_summary" },
    }
    const adapter = await openedAdapter(fake)
    const result = await adapter.navigateTree({ entryId: "e3", intent: "select", expectedLeafId: "e5" })
    // 归一形态：cancelled 布尔化、summaryEntry 折叠为 id、无多余字段
    expect(result).toEqual({ leafId: "e3", cancelled: false, editorText: "回复：OK", summaryEntryId: "sum-1" })
    // 帧面：寻址折叠为 targetId（引擎核心等价），intent/expectedLeafId 原样透传
    expect(fake.calls).toEqual([
      { method: "navigate_tree", args: { targetId: "e3", intent: "select", expectedLeafId: "e5" } },
    ])
  })

  test("targetId 寻址 resume happy：cancelled/aborted 形态归一保留", async () => {
    const fake = new TreeFakeRpcClient()
    fake.navigateTreeResult = { cancelled: true, leafId: "e4", aborted: true }
    const adapter = await openedAdapter(fake)
    const result = await adapter.navigateTree({ targetId: "e4", intent: "resume" })
    expect(result).toEqual({ leafId: "e4", cancelled: true, aborted: true })
    expect(fake.calls[0]!.args).toEqual({ targetId: "e4", intent: "resume" })
  })

  test("streaming（RpcCommandError.errorCode=\"streaming\"，SessionStreamingError 实录形态）→ 409 already_processing", async () => {
    const fake = new TreeFakeRpcClient()
    fake.failWith = rpcCommandError("Cannot modify the session tree while a response is streaming", "streaming")
    const adapter = await openedAdapter(fake)
    let err: unknown
    try {
      await adapter.navigateTree({ entryId: "e3", intent: "select" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ApiError)
    const api = err as ApiError
    expect(api.status).toBe(409)
    expect(api.code).toBe("already_processing")
  })

  test("压缩/导航互斥（isCompacting 普通 Error，无 errorCode）→ 409 already_processing", async () => {
    const fake = new TreeFakeRpcClient()
    fake.failWith = new Error("Wait for the current compaction or tree navigation to finish before navigating the session tree.")
    const adapter = await openedAdapter(fake)
    let err: unknown
    try {
      await adapter.navigateTree({ targetId: "e3", intent: "select" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(409)
    expect((err as ApiError).code).toBe("already_processing")
  })

  test("寻址守卫（both/neither/空串）→ bad_options，引擎未触达", async () => {
    const fake = new TreeFakeRpcClient()
    const adapter = await openedAdapter(fake)
    for (const input of [
      { entryId: "e3", targetId: "e3", intent: "select" as const },
      { intent: "select" as const },
      { entryId: "", intent: "select" as const },
      { targetId: "", intent: "select" as const },
    ]) {
      let err: unknown
      try {
        await adapter.navigateTree(input)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(EngineAdapterError)
      expect((err as EngineAdapterError).code).toBe("bad_options")
    }
    expect(fake.calls).toEqual([])
  })

  test("非忙碌业务码（stale_leaf CAS 拒绝）原样上抛不吞不改", async () => {
    const fake = new TreeFakeRpcClient()
    const stale = rpcCommandError("The conversation moved on while you were editing", "stale_leaf")
    fake.failWith = stale
    const adapter = await openedAdapter(fake)
    let err: unknown
    try {
      await adapter.navigateTree({ entryId: "e3", intent: "select", expectedLeafId: "e-old" })
    } catch (e) {
      err = e
    }
    // 乐观锁 stale 拒绝是业务码不是忙碌态：原样到达上层（路由层映射），不被 409 吞掉
    expect(err).toBe(stale)
    expect(err).not.toBeInstanceOf(ApiError)
  })

  test("无活跃会话 → no_active_session（与 usage/compact 同口径）", async () => {
    const adapter = makeAdapter(new TreeFakeRpcClient())
    await adapter.start()
    let err: unknown
    try {
      await adapter.navigateTree({ entryId: "e3", intent: "select" })
    } catch (e) {
      err = e
    }
    expect((err as EngineAdapterError).code).toBe("no_active_session")
  })
})

describe("getTree（RPC get_tree）", () => {
  test("happy：tree（含嵌套 children/label 元数据）与 leafId 原样透传", async () => {
    const fake = new TreeFakeRpcClient()
    const entry = (id: string, parentId: string | null): EngineEntry => ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-11-14T10:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: id }] },
    })
    const tree: EngineTreeNode[] = [
      {
        entry: entry("e1", null),
        children: [
          { entry: entry("e2", "e1"), children: [], label: "尝试A", labelTimestamp: "2026-11-14T10:01:00.000Z" },
          { entry: entry("e3", "e1"), children: [{ entry: entry("e4", "e3"), children: [] }] },
        ],
      },
    ]
    fake.getTreeResult = { tree, leafId: "e4" }
    const adapter = await openedAdapter(fake)
    const result = await adapter.getTree()
    expect(result.leafId).toBe("e4")
    // 原样透传（引用相等：不拷贝不改写不裁剪 label 等元数据字段）
    expect(result.tree).toBe(tree)
    expect(result.tree[0]!.children[0]!.label).toBe("尝试A")
    expect(fake.calls).toEqual([{ method: "get_tree" }])
  })
})

describe("editAssistantMessage（RPC edit_assistant_message）", () => {
  test("happy：outcome=edited，entry/leafId 透传，entryId/text/expectedLeafId CAS 透传入帧", async () => {
    const fake = new TreeFakeRpcClient()
    const edited: EngineEntry = {
      type: "message",
      id: "e9",
      parentId: "e2",
      timestamp: "2026-11-14T11:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "改后的回复" }] },
    }
    fake.editResult = { outcome: "edited", entry: edited, leafId: "e9", summaryEntryId: "sum-9" }
    const adapter = await openedAdapter(fake)
    const result = await adapter.editAssistantMessage({ entryId: "e5", text: "改后的回复", expectedLeafId: "e5" })
    expect(result).toEqual({ outcome: "edited", leafId: "e9", entry: edited, summaryEntryId: "sum-9" })
    expect(fake.calls).toEqual([
      { method: "edit_assistant_message", args: { entryId: "e5", text: "改后的回复", expectedLeafId: "e5" } },
    ])
  })

  test("unchanged/cancelled outcome 原样归一（不伪造成 edited）", async () => {
    const fake = new TreeFakeRpcClient()
    fake.editResult = { outcome: "unchanged", leafId: "e5" }
    const adapter = await openedAdapter(fake)
    expect(await adapter.editAssistantMessage({ entryId: "e5", text: "同文" })).toEqual({ outcome: "unchanged", leafId: "e5" })
    fake.editResult = { outcome: "cancelled", leafId: "e5", aborted: true }
    expect(await adapter.editAssistantMessage({ entryId: "e5", text: "x" })).toEqual({ outcome: "cancelled", leafId: "e5", aborted: true })
  })

  test("streaming → 409 already_processing", async () => {
    const fake = new TreeFakeRpcClient()
    fake.failWith = rpcCommandError("Cannot edit while streaming", "streaming")
    const adapter = await openedAdapter(fake)
    let err: unknown
    try {
      await adapter.editAssistantMessage({ entryId: "e5", text: "x" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(409)
    expect((err as ApiError).code).toBe("already_processing")
  })

  test("参数守卫（空 entryId）→ bad_options 引擎未触达；空 text 透传由引擎业务码拒绝", async () => {
    const fake = new TreeFakeRpcClient()
    const adapter = await openedAdapter(fake)
    let err: unknown
    try {
      await adapter.editAssistantMessage({ entryId: "", text: "x" })
    } catch (e) {
      err = e
    }
    expect((err as EngineAdapterError).code).toBe("bad_options")
    expect(fake.calls).toEqual([])
    // 空 text 是引擎 AssistantEditError("empty") 业务码的管辖面：适配层不拦，透传引擎拒
    await adapter.editAssistantMessage({ entryId: "e5", text: "" })
    expect(fake.calls[0]!.args).toEqual({ entryId: "e5", text: "" })
  })
})

describe("continueFromLeaf（RPC continue_from_leaf）", () => {
  test("happy + expectedLeafId CAS 透传入客户端调用（引擎帧尚无该字段，通道预留）", async () => {
    const fake = new TreeFakeRpcClient()
    const adapter = await openedAdapter(fake)
    await adapter.continueFromLeaf({ expectedLeafId: "e9" })
    expect(fake.calls).toEqual([{ method: "continue_from_leaf", args: { expectedLeafId: "e9" } }])
    // 无参调用亦通
    fake.calls.length = 0
    await adapter.continueFromLeaf()
    expect(fake.calls).toEqual([{ method: "continue_from_leaf", args: undefined }])
  })

  test("streaming（ContinueFromLeafError code=\"streaming\" 锚，经 code 字段到达）→ 409 already_processing", async () => {
    const fake = new TreeFakeRpcClient()
    fake.failWith = Object.assign(new Error("Cannot continue while a response is streaming"), { code: "streaming" })
    const adapter = await openedAdapter(fake)
    let err: unknown
    try {
      await adapter.continueFromLeaf({ expectedLeafId: "e9" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(409)
    expect((err as ApiError).code).toBe("already_processing")
  })

  test("leaf_not_assistant 业务码原样上抛（不被 409 映射吞掉）", async () => {
    const fake = new TreeFakeRpcClient()
    fake.failWith = rpcCommandError("There is no answer to continue: the conversation ends on a user message.", "leaf_not_assistant")
    const adapter = await openedAdapter(fake)
    let err: unknown
    try {
      await adapter.continueFromLeaf()
    } catch (e) {
      err = e
    }
    expect((err as { errorCode?: string }).errorCode).toBe("leaf_not_assistant")
    expect(err).not.toBeInstanceOf(ApiError)
  })
})

describe("capabilities 能力位（session-branching todo 2）", () => {
  test("treeNavigation 默认 true（todo-1 实调结论前）；editResend 维持 false 待翻转", () => {
    const adapter = makeAdapter(new TreeFakeRpcClient())
    expect(adapter.capabilities.treeNavigation).toBe(true)
    expect(adapter.capabilities.editResend).toBe(false)
    expect(adapter.capabilities.messageEdit).toBe(true)
  })
})
