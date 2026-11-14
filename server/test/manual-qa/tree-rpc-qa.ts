// session-branching todo 2 MANUAL-QA：一次性脚本驱动 SenpiAdapter 对 fake 网关（server 形态）。
// 运行方式（工作树 server 目录内，esbuild 解 TS+无扩展名导入后 node 直跑）：
//   node_modules/.bin/esbuild test/manual-qa/tree-rpc-qa.ts --bundle --platform=node \
//     --format=esm --packages=external --outfile=test/manual-qa/.tree-rpc-qa.bundle.mjs
//   node test/manual-qa/.tree-rpc-qa.bundle.mjs
// 场景（brief Worker B）：happy=navigateTree select 收 editorText 断言透传字段归一；
// failure=fake 抛 streaming（RpcCommandError 实录形态）断言 409 already_processing 语义对象。
// 纪律：断言一律针对返回对象本身（非日志输出）。
import { SenpiAdapter, type SenpiRpcClient } from "../../src/adapter/senpi-adapter"
import { ApiError } from "../../src/api/http"

class QaFakeRpcClient {
  calls: Array<{ method: string; args?: unknown }> = []
  failWith: unknown = null
  async start(): Promise<void> {}
  async setClientInfo(): Promise<void> {}
  send(): Promise<{ success: boolean }> {
    return Promise.resolve({ success: true })
  }
  async openSession(): Promise<{ sessionId: string; state: { sessionId?: string; sessionFile?: string } }> {
    return { sessionId: "rpc-1", state: { sessionId: "durable-qa", sessionFile: "/tmp/sb-qa-tree.jsonl" } }
  }
  private guard(): void {
    if (this.failWith !== null) throw this.failWith
  }
  async navigateTree(
    targetId: string,
    options?: { intent?: "select" | "resume"; expectedLeafId?: string },
  ): Promise<{ cancelled: boolean; leafId: string | null; editorText?: string; summaryEntry?: { id?: unknown; [k: string]: unknown } | null }> {
    this.calls.push({ method: "navigate_tree", args: { targetId, ...options } })
    this.guard()
    return {
      cancelled: false,
      leafId: "e3",
      editorText: "回复：OK",
      summaryEntry: { id: "sum-qa", type: "branch_summary" },
    }
  }
  async getTree(): Promise<{ tree: Array<Record<string, unknown>>; leafId: string | null }> {
    this.calls.push({ method: "get_tree" })
    this.guard()
    return {
      tree: [{ entry: { type: "message", id: "e1", parentId: null, timestamp: "t" }, children: [], label: "尝试A" }],
      leafId: "e3",
    }
  }
  async editAssistantMessage(
    entryId: string,
    text: string,
    options?: { expectedLeafId?: string },
  ): Promise<{ outcome: "edited"; leafId: string | null }> {
    this.calls.push({ method: "edit_assistant_message", args: { entryId, text, ...options } })
    this.guard()
    return { outcome: "edited", leafId: "e9" }
  }
  async continueFromLeaf(options?: { expectedLeafId?: string }): Promise<void> {
    this.calls.push({ method: "continue_from_leaf", args: options })
    this.guard()
  }
}

const fake = new QaFakeRpcClient()
const adapter = new SenpiAdapter({
  projectDir: "/tmp/opencode/sb-w1-proj",
  agentDir: "/tmp/opencode/sb-w1-agent",
  engineCliPath: "/fake/cli.js",
  pluginDir: "/fake/plugin",
  clientFactory: () => fake as unknown as SenpiRpcClient,
})

let failed = 0
function assert(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    failed++
    console.error(`FAIL ${name}${detail ? " — " + detail : ""}`)
    return
  }
  console.log(`PASS ${name}${detail ? " — " + detail : ""}`)
}

await adapter.start()
await adapter.openSession({ thinkingLevel: "low" })

// --- happy：navigateTree(entryId select) 收 editorText，透传字段归一 ---
const nav = await adapter.navigateTree({ entryId: "e3", intent: "select", expectedLeafId: "e5" })
assert(
  "navigateTree happy 归一（editorText/leafId/summaryEntryId/cancelled）",
  nav.leafId === "e3" && nav.cancelled === false && nav.editorText === "回复：OK" && nav.summaryEntryId === "sum-qa",
  JSON.stringify(nav),
)
assert(
  "navigateTree 帧面（entryId 折叠 targetId + intent/expectedLeafId CAS 透传）",
  JSON.stringify(fake.calls[0]) === JSON.stringify({ method: "navigate_tree", args: { targetId: "e3", intent: "select", expectedLeafId: "e5" } }),
  JSON.stringify(fake.calls[0]),
)

// --- happy：getTree / editAssistantMessage / continueFromLeaf 透传 ---
const tree = await adapter.getTree()
assert("getTree happy（tree+leafId 原样）", tree.leafId === "e3" && Array.isArray(tree.tree) && (tree.tree[0] as { label?: string }).label === "尝试A")
const edit = await adapter.editAssistantMessage({ entryId: "e5", text: "改后的回复", expectedLeafId: "e5" })
assert("editAssistantMessage happy（outcome/leafId）", edit.outcome === "edited" && edit.leafId === "e9", JSON.stringify(edit))
assert(
  "editAssistantMessage 帧面（entryId/text/expectedLeafId 透传）",
  JSON.stringify(fake.calls[2]) === JSON.stringify({ method: "edit_assistant_message", args: { entryId: "e5", text: "改后的回复", expectedLeafId: "e5" } }),
)
await adapter.continueFromLeaf({ expectedLeafId: "e9" })
assert(
  "continueFromLeaf 帧面（expectedLeafId 透传）",
  JSON.stringify(fake.calls[3]) === JSON.stringify({ method: "continue_from_leaf", args: { expectedLeafId: "e9" } }),
)

// --- failure：streaming（SessionStreamingError 经 RpcCommandError.errorCode 实录形态）→ 409 语义对象 ---
fake.failWith = Object.assign(new Error("Cannot modify the session tree while a response is streaming"), { errorCode: "streaming" })
let streamingErr: unknown
try {
  await adapter.navigateTree({ targetId: "e3", intent: "select" })
} catch (e) {
  streamingErr = e
}
assert(
  "streaming → 409 already_processing 语义对象",
  streamingErr instanceof ApiError && streamingErr.status === 409 && streamingErr.code === "already_processing",
  streamingErr instanceof ApiError ? `status=${streamingErr.status} code=${streamingErr.code}` : `非 ApiError: ${String(streamingErr)}`,
)

// --- failure：压缩/导航互斥（isCompacting 普通 Error）→ 409 ---
fake.failWith = new Error("Wait for the current compaction or tree navigation to finish before navigating the session tree.")
let compactingErr: unknown
try {
  await adapter.editAssistantMessage({ entryId: "e5", text: "x" })
} catch (e) {
  compactingErr = e
}
assert(
  "压缩互斥 → 409 already_processing",
  compactingErr instanceof ApiError && compactingErr.status === 409 && compactingErr.code === "already_processing",
)

// --- 能力位 ---
assert(
  "capabilities（treeNavigation=true 默认 / editResend=false 待翻转）",
  adapter.capabilities.treeNavigation === true && adapter.capabilities.editResend === false,
)

if (failed > 0) {
  console.error(`\nQA FAILED — ${failed} 项断言未过`)
  process.exit(1)
}
console.log("\nALL PASS — 9/9")
