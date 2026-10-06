/**
 * P0-2 权限/表单往返验证 spike（todo 4）。
 *
 * 目标：对真实 omo/senpi 引擎（RPC 模式）捕获 extension_ui_request 四型
 * （select / confirm / input / editor）各至少一次，程序化应答后验证执行继续；
 * 同时观察无应答时的兜底行为（是否有超时、是否阻塞）。
 *
 * 触发构造（全部走引擎自带代码路径，不手写 UI 桩）：
 *  - select + input：内置权限系统。会话带 --permission-preset read-only
 *    （edit/bash/external_directory 全部 ask），让 agent 调 bash 工具 → 权限
 *    select（Allow once / Allow always / Deny / Deny with feedback，带 toolCallId）；
 *    回 "Deny with feedback" → 内置 Feedback input 对话框。
 *    注意 --exclude-tools eval：omo 扩展的 eval 工具会拦截 bash 意图且其权限
 *    请求不带工具元数据，排除后模型直接用内置 bash 工具（W3 需要的正是这种样本）。
 *  - editor：官方示例扩展 examples/extensions/rpc-demo.ts 的 /rpc-editor 命令
 *    （ctx.ui.editor，带 prefill）；另测内置 /todo edit 命令路径。
 *  - confirm：官方示例扩展 examples/extensions/commands.ts 的 /commands 命令——
 *    先弹 select（命令清单）→ 回答后弹 confirm（View source path?），一次构造
 *    连环证明应答后继续执行。
 *  - auto-answer：官方示例扩展 examples/extensions/timed-confirm.ts 的 /timed 命令
 *    （ctx.ui.confirm 带 {timeout: 5000}）——不应答，观察自动按默认值
 *    （confirm=false）落定并继续执行。权限 select 无调用方超时 → 观察窗口内
 *    验证其无限阻塞。
 *
 * 已知协议事实（首跑实证）：命令类 prompt 的 RPC 响应要到对话框应答后才返回，
 * 客户端会先超时——命令轮次必须吞掉该错误、以对话框到达为同步点。
 *
 * 运行：bun run server/spike/p0-2-permission.ts [round1,round2,...]
 * 证据：docs/verification/02-permission-roundtrip.md；完整事件流水与汇总 JSON
 * 落 /tmp/opencode/p0-2-proj/。
 */

import { RpcClient } from "@code-yeongyu/senpi"
import type { RpcExtensionUIResponse } from "@code-yeongyu/senpi"

// 四型对话框的结构化视图（引擎侧 RpcExtensionUIRequest 是按 method 判别的联合，
// spike 内统一收窄为本类型，避免逐处 narrowing）
interface DialogRequest {
  type: "extension_ui_request"
  id: string
  method: "select" | "confirm" | "input" | "editor"
  title?: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  timeout?: number
  toolCallId?: string
  parentToolCallId?: string
}
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = join(HERE, "..")
const OMO_BIN = join(SERVER_ROOT, "node_modules/omo-ai/bin/omo.js")
const SENPI_ROOT = join(SERVER_ROOT, "node_modules/@code-yeongyu/senpi")
const EXAMPLE_EXT = (name: string) => join(SENPI_ROOT, "examples/extensions", name)

const PROJECT_DIR = "/tmp/opencode/p0-2-proj"
const AGENT_DIR = "/root/.pi/agent"
const PROVIDER = "zai-coding-cn"
const MODEL = "glm-5.3-flash"

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"])

// ---------- 事件流水与等待原语 ----------

interface Record_ {
  t: number
  dir: "event" | "send" | "info" | "error"
  payload: unknown
}

const transcript: Record_[] = []
const transcriptPath = join(PROJECT_DIR, "p0-2-transcript.jsonl")

function log(dir: Record_["dir"], payload: unknown) {
  const rec = { t: Date.now(), dir, payload }
  transcript.push(rec)
  appendFileSync(transcriptPath, JSON.stringify(rec) + "\n")
  if (dir === "error") console.error("[spike:error]", JSON.stringify(payload).slice(0, 500))
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

// ---------- 测试项目 ----------

mkdirSync(PROJECT_DIR, { recursive: true })
writeFileSync(transcriptPath, "")
writeFileSync(join(PROJECT_DIR, "note.txt"), "P0-2 权限往返验证测试文件\n由 server/spike/p0-2-permission.ts 创建\n")

// ---------- 引擎连接 ----------

async function main() {
  const only = process.argv[2]?.split(",").filter(Boolean)
  const want = (id: string) => !only || only.includes(id)

  const client = new RpcClient({
    cliPath: OMO_BIN,
    cwd: PROJECT_DIR,
    provider: PROVIDER,
    model: MODEL,
    env: {
      OMO_RUNTIME: "node", // 阻止 omo.js 在 bun 上 re-exec，保证 RpcClient 持有的子进程句柄就是引擎本体（execve 换映像不换 PID）
      OMO_CODING_AGENT_DIR: AGENT_DIR, // W1 spawn 规范（verification/00-env.md）
    },
    args: [
      "--thinking", "low",
      "--permission-preset", "read-only",
      "--exclude-tools", "eval",
      "--extension", EXAMPLE_EXT("rpc-demo.ts"),
      "--extension", EXAMPLE_EXT("commands.ts"),
      "--extension", EXAMPLE_EXT("timed-confirm.ts"),
    ],
  })

  const summary: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    spawn: { cliPath: OMO_BIN, cwd: PROJECT_DIR, provider: PROVIDER, model: MODEL },
    rounds: {},
  }

  // 对话框队列：extension_ui_request（四型）按到达顺序排队。
  // scope 用于作废 Promise.race 竞品的残留 waiter（否则旧 waiter 会抢走后续同型对话框）。
  interface WaitScope { cancelled: boolean }
  const dialogQueue: DialogRequest[] = []
  const dialogWaiters: Array<{
    method: string
    scope?: WaitScope
    resolve: (req: DialogRequest) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  let settledResolve: (() => void) | null = null

  client.onEvent((event) => {
    log("event", event)
    const anyEvent = event as unknown as { type: string; method?: string }
    if (anyEvent.type === "extension_ui_request" && anyEvent.method && DIALOG_METHODS.has(anyEvent.method)) {
      for (let i = dialogWaiters.length - 1; i >= 0; i--) {
        if (dialogWaiters[i].scope?.cancelled) dialogWaiters.splice(i, 1)
      }
      const req = event as DialogRequest
      const waiterIdx = dialogWaiters.findIndex((w) => w.method === req.method)
      if (waiterIdx >= 0) {
        const w = dialogWaiters.splice(waiterIdx, 1)[0]
        clearTimeout(w.timer)
        w.resolve(req)
      } else {
        dialogQueue.push(req)
      }
    }
    if (anyEvent.type === "agent_settled" && settledResolve) {
      const resolve = settledResolve
      settledResolve = null
      resolve()
    }
  })

  await client.start()
  log("info", { step: "started", stderrTail: client.getStderr().slice(-400) })

  function waitDialog(method: string, timeoutMs: number, scope?: WaitScope): Promise<DialogRequest> {
    const queuedIdx = dialogQueue.findIndex((r) => r.method === method)
    if (queuedIdx >= 0) return Promise.resolve(dialogQueue.splice(queuedIdx, 1)[0])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = dialogWaiters.findIndex((w) => w.method === method && w.scope === scope)
        if (i >= 0) dialogWaiters.splice(i, 1)
        reject(new Error(`等待 ${method} 对话框超时（${timeoutMs}ms）`))
      }, timeoutMs)
      dialogWaiters.push({ method, scope, resolve, timer })
    })
  }

  function waitSettled(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (settledResolve === resolve) settledResolve = null
        resolve(false)
      }, timeoutMs)
      settledResolve = () => {
        clearTimeout(timer)
        resolve(true)
      }
    })
  }

  async function answer(req: DialogRequest, payload: Record<string, unknown>) {
    const frame = { type: "extension_ui_response" as const, id: req.id, ...payload }
    log("send", frame)
    await client.sendExtensionUIResponse(frame as RpcExtensionUIResponse)
  }

  /** 把积压的未决对话框全部取消，防止污染下一轮 */
  async function drainDialogs() {
    while (dialogQueue.length > 0) {
      const req = dialogQueue.shift() as DialogRequest
      await answer(req, { cancelled: true })
    }
  }

  /** 回答到达的每个 select 直到回合落定（模型可能连续发起多个需授权调用） */
  async function answerSelectsUntilSettled(choice: string, capMs: number): Promise<DialogRequest[]> {
    const answered: DialogRequest[] = []
    const deadline = Date.now() + capMs
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`回答 select 后 ${capMs}ms 内未 agent_settled`)
      const scope: WaitScope = { cancelled: false }
      try {
        const race = await Promise.race([
          waitSettled(remaining).then((ok) => ({ settled: ok as boolean })),
          waitDialog("select", remaining, scope).then((req) => ({ req })),
        ])
        if ("settled" in race) {
          if (!race.settled) throw new Error(`回答 select 后 ${capMs}ms 内未 agent_settled`)
          return answered
        }
        answered.push(race.req)
        await answer(race.req, { value: choice })
      } finally {
        scope.cancelled = true
      }
    }
  }

  /** 收集 silenceMs 内到达的全部事件（用于无应答观察窗口） */
  async function observeSilence(silenceMs: number): Promise<unknown[]> {
    const before = transcript.length
    await sleep(silenceMs)
    return transcript.slice(before).map((r) => r.payload)
  }

  /** 命令类 prompt：RPC 响应会拖到对话框应答/自动落定之后才返回，属预期。后台发送，以对话框为同步点 */
  function promptCommandAsync(text: string) {
    void client.prompt(text).then(
      (disposition) => log("info", { step: "promptCommand", text, disposition: String(disposition) }),
      (error) => log("info", { step: "promptCommand-async", text, note: error instanceof Error ? error.message : String(error) }),
    )
  }

  const continuationNotify = (events: unknown[]) => {
    const notify = events.find(
      (e) => (e as { type?: string; method?: string }).type === "extension_ui_request" && (e as { method?: string }).method === "notify",
    ) as { message?: string } | undefined
    return notify ? { notifyMessage: notify.message } : { tailEvents: events.slice(-3) }
  }

  async function runRound(id: string, fn: () => Promise<Record<string, unknown>>) {
    if (!want(id)) return
    console.log(`\n===== round ${id} =====`)
    await drainDialogs()
    try {
      const detail = await fn()
      ;(summary.rounds as Record<string, unknown>)[id] = { ok: true, ...detail }
      console.log(`[round ${id}] OK`, JSON.stringify(detail).slice(0, 400))
    } catch (error) {
      ;(summary.rounds as Record<string, unknown>)[id] = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
      console.error(`[round ${id}] FAIL:`, error instanceof Error ? error.message : error)
    }
  }

  // round 0：基线连通（默认会话 + 短 prompt）
  await runRound("r0-baseline", async () => {
    const state = await client.getState()
    log("info", { step: "getState", sessionId: state.sessionId })
    const disposition = await client.prompt("Reply with exactly: OK")
    log("info", { step: "prompt", disposition: String(disposition) })
    const settled = await waitSettled(90_000)
    if (!settled) throw new Error("基线 prompt 90s 内未 agent_settled")
    const last = await client.getLastAssistantText()
    return { disposition: String(disposition), assistantText: last?.slice(0, 80) ?? null, sessionId: state.sessionId }
  })

  // round 1：select 型（权限门）+ 无应答阻塞观察 + Allow once 放行闭环
  await runRound("r1-select-approve", async () => {
    await client.prompt("Call the bash tool with command `ls -la`, then summarize the output in one line.")
    const req = await waitDialog("select", 150_000)
    const arrivedAt = Date.now()
    console.log("[r1] select request:", JSON.stringify(req))
    // 无应答观察窗口：权限 select 未带 timeout 字段（调用方未传）→ 预期无限等待
    const during = await observeSilence(60_000)
    const continuedWhileSilent = during.some((e) => {
      const t = (e as { type?: string }).type
      return t === "agent_settled" || t === "tool_execution_start" || t === "message_update"
    })
    await answer(req, { value: "Allow once" })
    const markBeforeAnswer = transcript.length
    const further = await answerSelectsUntilSettled("Allow once", 240_000)
    const roundEvents = transcript.slice(markBeforeAnswer).map((r) => r.payload)
    const toolRan = roundEvents.some(
      (e) =>
        ((e as { type?: string }).type === "tool_execution_end" || (e as { type?: string }).type === "tool_execution_start") &&
        (e as { toolName?: string }).toolName === "bash",
    )
    return {
      request: req,
      hasToolCallId: typeof (req as { toolCallId?: string }).toolCallId === "string",
      answered: { value: "Allow once" },
      furtherSelectsAnswered: further.length,
      noAnswerObservationMs: 60_000,
      continuedWhileSilent,
      bashToolRanAfterAnswer: toolRan,
    }
  })

  // round 2：select 拒绝路径 → 触发内置 input 型（Feedback），应答后继续执行
  await runRound("r2-select-deny-input", async () => {
    await client.prompt("Call the bash tool with command `echo p0-2-deny-probe`.")
    const sel = await waitDialog("select", 150_000)
    await answer(sel, { value: "Deny with feedback" })
    const inp = await waitDialog("input", 60_000)
    console.log("[r2] input request:", JSON.stringify(inp))
    await answer(inp, { value: "P0-2 roundtrip: denied with feedback text" })
    await answerSelectsUntilSettled("Allow once", 240_000)
    return {
      selectRequest: sel,
      inputRequest: inp,
      answered: ["Deny with feedback", "P0-2 roundtrip: denied with feedback text"],
    }
  })

  // round 3：editor 型（官方示例扩展 /rpc-editor 命令，无 LLM token）
  await runRound("r3-editor-demo-ext", async () => {
    promptCommandAsync("/rpc-editor")
    const req = await waitDialog("editor", 60_000)
    console.log("[r3] editor request:", JSON.stringify(req))
    const edited = `${req.prefill ?? ""}\nLine 4 appended by P0-2`
    await answer(req, { value: edited })
    const during = await observeSilence(8_000)
    return { request: req, answered: { value: edited }, ...continuationNotify(during) }
  })

  // round 4：editor 型（引擎内置 /todo edit 命令，无 LLM token）
  await runRound("r4-editor-todo-builtin", async () => {
    promptCommandAsync("/todo edit")
    const req = await waitDialog("editor", 60_000)
    console.log("[r4] editor request (prefill head):", JSON.stringify({ ...req, prefill: req.prefill?.slice(0, 200) }))
    const edited = `${req.prefill ?? ""}\n  - [x] P0-2 roundtrip task`
    await answer(req, { value: edited })
    const during = await observeSilence(8_000)
    return {
      requestHead: { ...req, prefill: req.prefill?.slice(0, 200) },
      answered: { valueHead: edited.slice(0, 120) },
      ...continuationNotify(during),
    }
  })

  // round 5：confirm 型（官方示例扩展 /commands 连环：select 清单 → confirm，无 LLM token）
  await runRound("r5-confirm-commands-chain", async () => {
    promptCommandAsync("/commands")
    const sel = await waitDialog("select", 60_000)
    const timedOption = sel.options?.find((o) => o.startsWith("/timed "))
    if (!timedOption) throw new Error(`命令清单中未找到 /timed 项，实际 options=${JSON.stringify(sel.options)?.slice(0, 400)}`)
    await answer(sel, { value: timedOption })
    const cf = await waitDialog("confirm", 30_000)
    console.log("[r5] confirm request:", JSON.stringify(cf))
    await answer(cf, { confirmed: true })
    const during = await observeSilence(8_000)
    return {
      selectRequestHead: { ...sel, options: sel.options?.slice(0, 6) },
      confirmRequest: cf,
      answered: [timedOption, { confirmed: true }],
      ...continuationNotify(during),
    }
  })

  // round 6：auto-answer 正例——调用方带 timeout 的 confirm 不应答，观察自动落定
  await runRound("r6-confirm-timeout-autoanswer", async () => {
    promptCommandAsync("/timed")
    const cf = await waitDialog("confirm", 60_000)
    const arrivedAt = Date.now()
    console.log("[r6] timed confirm request:", JSON.stringify(cf))
    const during = await observeSilence(10_000)
    const notify = during.find(
      (e) => (e as { type?: string; method?: string }).type === "extension_ui_request" && (e as { method?: string }).method === "notify",
    ) as { message?: string } | undefined
    if (!notify) throw new Error("10s 内未见超时后自动落定的 notify（预期 timeout:5000 自动 cancel）")
    return { request: cf, answered: null, autoResolvedNotify: notify, autoResolveAfterMs: Date.now() - arrivedAt }
  })

  await client.stop()
  log("info", { step: "stopped" })

  const rounds = summary.rounds as Record<string, { ok: boolean }>
  const typesCovered = {
    select: rounds["r1-select-approve"]?.ok === true,
    input: rounds["r2-select-deny-input"]?.ok === true,
    editor: rounds["r3-editor-demo-ext"]?.ok === true || rounds["r4-editor-todo-builtin"]?.ok === true,
    confirm: rounds["r5-confirm-commands-chain"]?.ok === true,
  }
  const finalSummary = {
    ...summary,
    finishedAt: new Date().toISOString(),
    typesCovered,
    allFourTypes: Object.values(typesCovered).every(Boolean),
  }
  writeFileSync(join(PROJECT_DIR, "p0-2-summary.json"), JSON.stringify(finalSummary, null, 2))
  console.log("\n===== summary =====")
  console.log(JSON.stringify(finalSummary, null, 2))
  // 证据已同步落盘；显式退出，避免竞品 waiter 的残留 timer 拖住事件循环
  process.exit(finalSummary.allFourTypes ? 0 : 1)
}

main().catch((error) => {
  console.error("[spike:fatal]", error)
  process.exitCode = 1
})
