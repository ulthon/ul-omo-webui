/**
 * W2 P1 六项 + P2-11 并发锁 逐项实测 spike（todo 7 实现依据）。
 *
 * 覆盖（docs/06 P1 5/6/7/8/9/10 + P2 11）：
 *   P1-1 会话/项目查询能力与 parent 血缘（SDK SessionManager.list 行字段、fork 会话 header、
 *        omo task 子会话 header 是否写 parentSession——W3 钻取方案的决定性实测）
 *   P1-2 todo 事件源（tool_execution/toolResult.details/senpi.todo-state entry）
 *   P1-3 图片 part 存储形态（用户上传图随 prompt 的落盘形态；getMedia 协议面）
 *   P1-4 usage 数据源（message_update.usage / agent_end / getSessionStats）
 *   P1-5 agent/model 枚举（get_available_models；agent 列表协议面有无）
 *   P1-6 消息编辑重发支持度（editUserMessage + continueFromLeaf）
 *   P1-7 --export HTML 可用性（omo CLI 侧，零 token）
 *   P2-11 并发锁语义（同一活动会话被两个引擎进程同时 open）
 *
 * 运行：cd /data/projects/senpi-webui && bun run server/spike/w2-p1-findings.ts
 * 模型：zai-coding-cn/glm-5.3-flash，thinking low，短 prompt（token 预算规则）。
 * fixture 导出：/tmp/opencode/w2-7-proj/p1-fixtures.json（供 server/test/ 单测使用，零 token）。
 */

import { spawnSync } from "node:child_process"
import { deflateSync } from "node:zlib"
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { RpcClient, SessionManager } from "@code-yeongyu/senpi"

// ---- 常量（全部来自 W1 实证规范） ----

const REPO = "/data/projects/senpi-webui"
const AGENT_DIR = "/root/.pi/agent"
const PROVIDER = "zai-coding-cn"
const MODEL = "glm-5.3-flash"
const THINKING = "low" as const
const PROJ_DIR = "/tmp/opencode/w2-7-proj"
const FIXTURE_PATH = join(PROJ_DIR, "p1-fixtures.json")
const SELF_PID = process.pid

/** 引擎 cli 本体：.bun/omo-ai@5.1.0 旁路的官配 senpi 2026.9.28-7（禁止 omo.js 包装器与根级直依赖） */
function engineCli(): string {
  const p = `${REPO}/node_modules/.bun/omo-ai@5.1.0/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js`
  if (!existsSync(p)) throw new Error(`引擎 cli 不存在: ${p}`)
  return p
}

const PLUGIN_DIR = `${REPO}/server/node_modules/omo-ai/plugin`

/** 实证 spawn 规范（verification/03）：cli 本体 + --extension omo plugin + --multi-session + 品牌 env */
function newClient(): RpcClient {
  return new RpcClient({
    cliPath: engineCli(),
    args: ["--extension", PLUGIN_DIR, "--multi-session"],
    cwd: PROJ_DIR,
    env: {
      OMO_CODING_AGENT_DIR: AGENT_DIR,
      SENPI_CODING_AGENT_DIR: AGENT_DIR,
      OMO_NATIVE: "1",
      PI_OFFLINE: "1",
    },
    provider: PROVIDER,
    model: MODEL,
  })
}

// ---- 通用工具 ----

type AnyEvent = Record<string, unknown> & { _t?: number }

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

function brief(value: unknown, max = 700): string {
  const s = JSON.stringify(value)
  return s === undefined ? "undefined" : s.length <= max ? s : `${s.slice(0, max)}...<截断,全长${s.length}>`
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 冷启动就绪轮询（verification/03 坑 1：先 get_protocol_info 成功再 open_session） */
async function waitUntilReady(client: RpcClient, label: string): Promise<Record<string, unknown> | null> {
  const send = (client as unknown as { send: (m: unknown) => Promise<{ success: boolean; data?: unknown }> }).send.bind(client)
  for (let i = 1; i <= 15; i++) {
    try {
      const r = await send({ type: "get_protocol_info" })
      if (r.success) {
        console.log(`[${label}] 引擎就绪（第 ${i} 次探测）`)
        return (r.data ?? null) as Record<string, unknown> | null
      }
    } catch {
      console.log(`[${label}] 就绪探测 ${i}/15 未就绪，重试...`)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return null
}

class EventLog {
  readonly all: AnyEvent[] = []
  add(e: unknown): void {
    this.all.push({ ...(e as AnyEvent), _t: Date.now() })
  }
  of(type: string, fromIndex = 0): AnyEvent[] {
    return this.all.filter((e, i) => i >= fromIndex && e.type === type)
  }
  /** 只匹配快照之后到达的事件——历史事件不算数（run1 教训：旧 agent_settled 会提前满足等待） */
  mark(): number {
    return this.all.length
  }
  async waitFor(type: string, timeoutMs: number, fromIndex = 0, filter?: (e: AnyEvent) => boolean): Promise<AnyEvent> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.all.find((e, i) => i >= fromIndex && e.type === type && (!filter || filter(e)))
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`等待事件 ${type} 超时 ${timeoutMs}ms`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

async function waitSettled(events: EventLog, timeoutMs = 180000, label = ""): Promise<void> {
  // mark() 由调用方在 prompt 之前打点后传入；此处兜底用当前长度
  await waitSettledFrom(events, events.all.length, timeoutMs, label)
}

async function waitSettledFrom(events: EventLog, fromIndex: number, timeoutMs = 180000, label = ""): Promise<void> {
  await withTimeout(events.waitFor("agent_settled", timeoutMs, fromIndex), timeoutMs + 5000, `agent_settled(${label})`)
  await new Promise((r) => setTimeout(r, 400))
}

/** prompt 一律带超时——并发锁场景实测到过无响应挂起，不能让整个 spike 卡死 */
async function safePrompt(
  client: RpcClient,
  text: string,
  opts: { thinkingLevel: typeof THINKING; images?: Array<{ type: "image"; data: string; mimeType: string }> },
  ms = 60000,
): Promise<{ disposition: string; error?: string }> {
  try {
    const d = await withTimeout(client.prompt(text, opts as never), ms, `prompt(${text.slice(0, 24)})`)
    return { disposition: String(d) }
  } catch (e) {
    return { disposition: "rejected", error: e instanceof Error ? e.message : String(e) }
  }
}

/** 并发锁客户端的对话框兜底应答：权限 select/confirm/input/editor 到达即按默认放行，防 prompt 被对话框阻塞成悬挂 */
function autoRespondDialogs(client: RpcClient, events: EventLog, label: string): void {
  client.onEvent((e) => {
    const ev = e as Record<string, unknown>
    if (ev.type !== "extension_ui_request") return
    const method = String(ev.method ?? "")
    const id = String(ev.id ?? "")
    if (!id) return
    let frame: Record<string, unknown> | null = null
    if (method === "select") frame = { type: "extension_ui_response", id, value: ((ev.options as string[]) ?? [])[0] ?? "" }
    else if (method === "confirm") frame = { type: "extension_ui_response", id, confirmed: true }
    else if (method === "input" || method === "editor") frame = { type: "extension_ui_response", id, value: String(ev.prefill ?? "") }
    if (frame) {
      console.log(`[${label}] 自动应答对话框 method=${method} id=${id.slice(0, 8)}`)
      void client.sendExtensionUIResponse(frame as never).catch(() => undefined)
    }
  })
}

/** 引擎子进程探测（/proc cwd 精确过滤，禁止宽匹配） */
function listEngineProcesses(): Array<{ pid: number; cmd: string }> {
  const r = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8", timeout: 5000 })
  if (r.status !== 0 || !r.stdout) return []
  return r.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2] }))
    .filter(
      (p) =>
        p.pid !== SELF_PID &&
        /bundle\/cli\.js/.test(p.cmd) &&
        existsSync(`/proc/${p.pid}/cwd`) &&
        readlinkSync(`/proc/${p.pid}/cwd`) === PROJ_DIR,
    )
}

function killByPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // 已退出
  }
}

async function stopClient(client: RpcClient, label: string): Promise<void> {
  try {
    await withTimeout(client.stop(), 8000, `stop(${label})`)
  } catch {
    for (const p of listEngineProcesses()) killByPid(p.pid)
  }
}

// ---- 最小 PNG 生成（1x1 灰点，确定性构造，不依赖外部资源） ----

function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

function tinyGrayPng(): string {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type: grayscale
  const raw = Buffer.from([0, 128]) // filter 0 + 灰度 128
  const idat = deflateSync(raw)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64")
}

// ---- 会话目录快照（P1-1c 子会话落点观测） ----

function sessionDirSnapshot(): Record<string, { files: string[]; holders: string[] }> {
  const root = join(AGENT_DIR, "sessions", "--tmp-opencode-w2-7-proj--")
  const out: Record<string, { files: string[]; holders: string[] }> = {}
  if (!existsSync(root)) return out
  out.root = {
    files: readdirSync(root).filter((f) => f.endsWith(".jsonl")).sort(),
    holders: existsSync(join(root, "session-holders")) ? readdirSync(join(root, "session-holders")).sort() : [],
  }
  return out
}

function readHeader(path: string): Record<string, unknown> | null {
  try {
    const first = readFileSync(path, "utf8").split("\n")[0]
    return JSON.parse(first) as Record<string, unknown>
  } catch {
    return null
  }
}

// ---- 主流程 ----

interface Findings {
  protocolInfo: unknown
  openResult: unknown
  listSessionsRows: unknown
  sdkListRows: unknown
  sdkListRowKeys: unknown
  sessionHeaders: Record<string, unknown>
  models: unknown
  thinkingLevels: unknown
  usage: Record<string, unknown>
  imageStorage: unknown
  todoSource: unknown
  editResend: Record<string, unknown>
  fork: Record<string, unknown>
  taskSubSessions: unknown
  agentEnumeration: unknown
  lock: Record<string, unknown>
  exportHtml: Record<string, unknown>
  uiRequestSamples: unknown
  eventSamples: Record<string, unknown>
}

async function main(): Promise<void> {
  console.log("=== W2 P1 六项 + P2-11 逐项实测 ===")
  console.log(`引擎 cli=${engineCli()}`)
  console.log(`omo-ai=5.1.0（官配内嵌 senpi 2026.9.28-7）；宿主 RpcClient=2026.10.10`)
  console.log(`模型=${PROVIDER}/${MODEL} thinking=${THINKING} cwd=${PROJ_DIR}`)
  mkdirSync(PROJ_DIR, { recursive: true })
  writeFileSync(join(PROJ_DIR, "README.md"), "# W2-7 adapter 冒烟项目\n")

  const F: Findings = {
    protocolInfo: null,
    openResult: null,
    listSessionsRows: null,
    sdkListRows: null,
    sdkListRowKeys: null,
    sessionHeaders: {},
    models: null,
    thinkingLevels: null,
    usage: {},
    imageStorage: null,
    todoSource: null,
    editResend: {},
    fork: {},
    taskSubSessions: null,
    agentEnumeration: null,
    lock: {},
    exportHtml: {},
    uiRequestSamples: [],
    eventSamples: {},
  }
  const failures: string[] = []

  const clientA = newClient()
  const eventsA = new EventLog()
  clientA.onEvent((e) => {
    eventsA.add(e)
    const t = String((e as AnyEvent).type ?? "")
    if ((t === "extension_ui_request" || t === "entry_appended" || t === "tool_execution_start" || t === "tool_execution_end") && !F.eventSamples[t]) {
      F.eventSamples[t] = e
    }
  })

  try {
    // ---- 启动 A ----
    await withTimeout(clientA.start(), 60000, "start(A)")
    await withTimeout(clientA.setClientInfo(80, ["extension_events"]), 20000, "set_client_info(A)")
    F.protocolInfo = await waitUntilReady(clientA, "A")
    if (!F.protocolInfo) throw new Error("引擎 A 就绪探测失败")
    console.log(`protocolInfo.engineVersion=${String((F.protocolInfo as Record<string, unknown>).engineVersion)}`)

    // ---- openSession S1 ----
    const open1 = await withTimeout(
      clientA.openSession({ provider: PROVIDER, modelId: MODEL, thinkingLevel: THINKING }),
      60000,
      "open_session(S1)",
    )
    F.openResult = open1
    console.log(`S1 routing=${open1.sessionId} durable=${(open1.state as Record<string, unknown>).sessionId}`)

    // ---- P1-4 usage：一轮短对话 ----
    section("P1-4 usage 数据源")
    let mark = eventsA.mark()
    const dispOk = await safePrompt(clientA, "回复：OK", { thinkingLevel: THINKING })
    console.log(`usage 轮 prompt=${JSON.stringify(dispOk)}`)
    if (!dispOk.error) await waitSettledFrom(eventsA, mark, 180000, "usage 轮")
    const msgEnd = eventsA.of("message_end", mark).find((e) => {
      const m = e.message as Record<string, unknown> | undefined
      return m && m.role === "assistant"
    })
    const turnEnd = eventsA.of("turn_end", mark).at(-1)
    const agentEnd = eventsA.of("agent_end", mark).at(-1)
    const agentEndMsgs = (agentEnd?.messages as Array<Record<string, unknown>> | undefined) ?? []
    const agentEndAssistant = [...agentEndMsgs].reverse().find((m) => m.role === "assistant")
    F.usage.messageEndUsage = msgEnd
      ? { usage: (msgEnd.message as Record<string, unknown>).usage ?? null, role: "assistant" }
      : null
    F.usage.turnEndMessageUsage = turnEnd
      ? { usage: (turnEnd.message as Record<string, unknown>).usage ?? null }
      : null
    F.usage.agentEndLastAssistantUsage = agentEndAssistant
      ? { usage: agentEndAssistant.usage ?? null, model: agentEndAssistant.model ?? null }
      : null
    F.usage.agentEndTopLevelUsage = (agentEnd as Record<string, unknown> | undefined)?.usage ?? null
    const upd = eventsA.of("message_update", mark).find((e) => {
      const u = e.usage as Record<string, number> | undefined
      return u && (u.totalTokens ?? 0) > 0
    })
    F.usage.messageUpdateUsage = upd?.usage ?? null
    F.usage.messageUpdateUsageSamples = eventsA
      .of("message_update", mark)
      .slice(0, 2)
      .map((e) => e.usage ?? null)
    const stats = await withTimeout(clientA.getSessionStats(), 20000, "get_session_stats")
    F.usage.sessionStats = stats
    console.log(`message_update.usage(终值样本)=${brief(F.usage.messageUpdateUsage, 300)}`)
    console.log(`message_end(assistant).usage=${brief(F.usage.messageEndUsage, 300)}`)
    console.log(`agent_end 末条 assistant usage=${brief(F.usage.agentEndLastAssistantUsage, 300)}`)
    console.log(`getSessionStats=${brief(stats, 500)}`)

    // ---- P1-5 模型/agent 枚举 ----    section("P1-5 agent/model 枚举")
    const models = await withTimeout(clientA.getAvailableModels(), 20000, "get_available_models")
    F.models = models
    console.log(`getAvailableModels=${models.length} 条；首条=${brief(models[0], 300)}`)
    F.thinkingLevels = await withTimeout(clientA.getAvailableThinkingLevels(), 20000, "get_available_thinking_levels")
    console.log(`thinkingLevels=${JSON.stringify(F.thinkingLevels)}`)
    // agent 列表协议面：rpc-client 全方法无 agents 类查询（实现层核对）；运行面再看 getCommands 有无 agent 管理命令
    const cmds = await withTimeout(clientA.getCommands(), 20000, "get_commands")
    const agentCmds = cmds
      .map((c) => String((c as Record<string, unknown>).name ?? ""))
      .filter((n) => /agent/i.test(n))
    F.agentEnumeration = { rpcClientMethodForAgents: "无（rpc-client.d.ts 全方法核对）", agentLikeCommands: agentCmds }
    console.log(`agent 协议面：无 agents 查询方法；agent 相关命令=${JSON.stringify(agentCmds)}`)

    // ---- P1-3 图片 part 存储形态 ----
    section("P1-3 图片 part 存储形态")
    const pngB64 = tinyGrayPng()
    mark = eventsA.mark()
    const dispImg = await safePrompt(clientA, "图片已附上。请只回复四个字：已看到图片", {
      thinkingLevel: THINKING,
      images: [{ type: "image", data: pngB64, mimeType: "image/png" }],
    })
    console.log(`带图 prompt=${JSON.stringify(dispImg)}`)
    if (!dispImg.error) await waitSettledFrom(eventsA, mark, 180000, "图片轮")
    const entriesImg = await withTimeout(clientA.getEntries(), 20000, "get_entries(图片轮)")
    const imgUserMsg = [...entriesImg.entries]
      .reverse()
      .find((e) => (e as Record<string, unknown>).type === "message" && JSON.stringify(e).includes('"image"'))
    F.imageStorage = {
      entryFound: Boolean(imgUserMsg),
      entry: imgUserMsg ?? null,
      pngBase64Len: pngB64.length,
    }
    console.log(`图片落盘形态 found=${Boolean(imgUserMsg)}：${brief(imgUserMsg, 600)}`)
    console.log(`（落盘 PNG base64 原长 ${pngB64.length} 字符——比对存储条目内 data 字段是否同长=inline base64）`)

    // ---- P1-2 todo 事件源 ----
    section("P1-2 todo 事件源")
    const todoEvents = new EventLog()
    const offTodo = clientA.onEvent((e) => todoEvents.add(e))
    const todoMark = todoEvents.mark()
    const todoDisp = await safePrompt(clientA, "用 todo 工具创建清单两项：买牛奶、寄包裹。不要做其他任何事，不要解释。", { thinkingLevel: THINKING })
    console.log(`todo prompt=${JSON.stringify(todoDisp)}`)
    if (!todoDisp.error) await waitSettledFrom(todoEvents, todoMark, 180000, "todo 轮")
    offTodo()
    const todoStart = todoEvents.of("tool_execution_start", todoMark).find((e) => (e as Record<string, unknown>).toolName === "todo")
    const todoEnd = todoEvents.of("tool_execution_end", todoMark).find((e) => (e as Record<string, unknown>).toolName === "todo")
    const todoEntry = todoEvents
      .of("entry_appended", todoMark)
      .find((e) => JSON.stringify(e).includes("senpi.todo-state"))
    const entriesTodo = await withTimeout(clientA.getEntries(), 20000, "get_entries(todo 轮)")
    const todoStateEntries = entriesTodo.entries.filter((e) => (e as Record<string, unknown>).customType === "senpi.todo-state")
    F.todoSource = {
      prompt: todoDisp,
      toolExecutionStart: todoStart ?? null,
      toolExecutionEnd: todoEnd ?? null,
      entryAppendedEvent: todoEntry ?? null,
      persistedEntries: todoStateEntries,
    }
    console.log(`todo 事件源：tool_execution_start=${Boolean(todoStart)} tool_execution_end=${Boolean(todoEnd)} entry_appended=${Boolean(todoEntry)} 落盘 entry=${todoStateEntries.length} 条`)
    console.log(`todo toolResult=${brief((todoEnd as Record<string, unknown> | undefined)?.result ?? null, 400)}`)
    console.log(`todoState 末条 entry=${brief(todoStateEntries.at(-1) ?? null, 500)}`)

    // ---- P1-1c omo task 子会话血缘（先于 fork：避免 fork 自身文件混淆快照差分） ----
    section("P1-1c omo task 子会话 header 是否写 parentSession")
    const snapBeforeTask = sessionDirSnapshot()
    const taskEvents = new EventLog()
    const offTask = clientA.onEvent((e) => taskEvents.add(e))
    const taskMark = taskEvents.mark()
    const taskDisp = await safePrompt(
      clientA,
      "用 task 工具启动一个子任务，任务内容：回复 TASK-OK。等子任务完成后把它返回的原文告诉我。不要做其他任何事。",
      { thinkingLevel: THINKING },
      90000,
    )
    console.log(`task prompt=${JSON.stringify(taskDisp)}`)
    if (!taskDisp.error) {
      try {
        await waitSettledFrom(taskEvents, taskMark, 240000, "task 轮")
      } catch (e) {
        console.log(`task 轮 settled 等待失败: ${e instanceof Error ? e.message : e}`)
      }
    }
    offTask()
    await new Promise((r) => setTimeout(r, 1200))
    const snapAfterTask = sessionDirSnapshot()
    const taskNewFiles = snapAfterTask.root.files.filter((f) => !snapBeforeTask.root.files.includes(f))
    const taskNewHolders = snapAfterTask.root.holders.filter((h) => !snapBeforeTask.root.holders.includes(h))
    const taskHeaders: Record<string, unknown> = {}
    for (const f of taskNewFiles) {
      const h = readHeader(join(AGENT_DIR, "sessions", "--tmp-opencode-w2-7-proj--", f))
      taskHeaders[f] = h
      F.sessionHeaders[f] = h
    }
    // holder 目录内容也可能放子会话
    const holderContents: Record<string, string[]> = {}
    for (const h of taskNewHolders) {
      const hd = join(AGENT_DIR, "sessions", "--tmp-opencode-w2-7-proj--", "session-holders", h)
      holderContents[h] = existsSync(hd) ? readdirSync(hd) : []
    }
    const taskToolCalls = taskEvents.of("tool_execution_start", taskMark).map((e) => ({
      toolName: (e as Record<string, unknown>).toolName,
      args: (e as Record<string, unknown>).args,
    }))
    F.taskSubSessions = { prompt: taskDisp, newFiles: taskNewFiles, newHolders: taskNewHolders, holderContents, taskHeaders, taskToolCalls }
    console.log(`task 轮新增会话文件=${JSON.stringify(taskNewFiles)}；新增 holders=${JSON.stringify(taskNewHolders)}`)
    console.log(`task 工具调用=${brief(taskToolCalls, 300)}`)
    console.log(`task 新会话 header=${brief(taskHeaders, 500)}`)
    console.log(`holder 内容=${brief(holderContents, 300)}`)

    // ---- P1-6 消息编辑重发 ----
    section("P1-6 消息编辑重发支持度")
    const entriesPre = await withTimeout(clientA.getEntries(), 20000, "get_entries(编辑前)")
    const firstUser = entriesPre.entries.find(
      (e) =>
        (e as Record<string, unknown>).type === "message" &&
        JSON.stringify((e as Record<string, unknown>).message).includes('"role":"user"'),
    )
    if (firstUser) {
      try {
        const editRes = await withTimeout(
          clientA.editUserMessage(firstUser.id, "回复：EDITED", { expectedLeafId: entriesPre.leafId ?? undefined }),
          30000,
          "edit_user_message",
        )
        console.log(`editUserMessage=${brief(editRes, 300)}`)
        let leafAfterEdit = entriesPre.leafId
        try {
          const entriesPostEdit = await withTimeout(clientA.getEntries(), 20000, "get_entries(编辑后)")
          leafAfterEdit = entriesPostEdit.leafId
        } catch {
          // 忽略
        }
        let continueResult: unknown = null
        let continueError = ""
        try {
          continueResult = await withTimeout(clientA.continueFromLeaf(), 30000, "continue_from_leaf")
          console.log(`continueFromLeaf=${brief(continueResult, 200)}`)
        } catch (e) {
          continueError = e instanceof Error ? e.message : String(e)
          console.log(`continueFromLeaf 被拒: ${continueError}`)
        }
        if (!continueError) {
          const editMark = eventsA.mark()
          await waitSettledFrom(eventsA, editMark, 180000, "编辑重发轮")
        }
        const lastText = await withTimeout(clientA.getLastAssistantText(), 20000, "get_last_assistant_text")
        F.editResend = {
          editSupported: true,
          editUserMessageResult: editRes,
          leafAfterEdit: leafAfterEdit ?? null,
          continueFromLeafSupported: !continueError,
          continueError,
          continueResult,
          lastAssistantText: lastText,
        }
        console.log(`编辑重发结论：编辑=${F.editResend.editSupported} continue_from_leaf=${F.editResend.continueFromLeafSupported}`)
      } catch (e) {
        F.editResend = { editSupported: false, error: e instanceof Error ? e.message : String(e) }
        failures.push(`P1-6 编辑重发：${F.editResend.error}`)
        console.log(`编辑重发失败: ${F.editResend.error}`)
      }
    } else {
      F.editResend = { editSupported: false, error: "未找到 user message entry" }
      failures.push("P1-6 编辑重发：未找到 user message entry")
    }

    // ---- P1-1b fork 会话血缘 ----
    section("P1-1 会话/项目查询能力（fork 血缘）")
    const snapBeforeFork = sessionDirSnapshot()
    try {
      const forkMsgs = await withTimeout(clientA.getForkMessages(), 20000, "get_fork_messages")
      console.log(`getForkMessages=${forkMsgs.length} 条，取首条 entryId=${forkMsgs[0]?.entryId}`)
      const forkRes = await withTimeout(clientA.fork(forkMsgs[0]!.entryId, { position: "at" }), 30000, "fork")
      console.log(`fork=${brief(forkRes, 200)}`)
      await new Promise((r) => setTimeout(r, 800))
      const snapAfterFork = sessionDirSnapshot()
      const newFiles = snapAfterFork.root.files.filter((f) => !snapBeforeFork.root.files.includes(f))
      console.log(`fork 后立即新增会话文件=${JSON.stringify(newFiles)}（注意：文件可能在下次条目落盘时才物化）`)
      const stateAfterFork = await withTimeout(clientA.getState(), 20000, "get_state(fork 后)")
      F.fork = { forkResult: forkRes, newFilesImmediately: newFiles, stateAfterFork }
      console.log(`fork 后 state.sessionId=${String((stateAfterFork as Record<string, unknown>).sessionId)} sessionFile=${String((stateAfterFork as Record<string, unknown>).sessionFile)}`)
    } catch (e) {
      F.fork = { error: e instanceof Error ? e.message : String(e) }
      failures.push(`P1-1 fork：${F.fork.error}`)
      console.log(`fork 实测失败: ${F.fork.error}`)
    }

    // RPC 侧 list_sessions 行
    F.listSessionsRows = await withTimeout(clientA.listSessions(), 20000, "list_sessions(A)")
    console.log(`RPC list_sessions=${(F.listSessionsRows as unknown[]).length} 行：${brief(F.listSessionsRows, 600)}`)

    // ---- P2-11 并发锁（阶段 1：A 空闲，B 打开同一会话） ----
    section("P2-11 并发锁阶段 1：A 空闲，B 进程打开同一会话文件")
    const clientB = newClient()
    const eventsB = new EventLog()
    clientB.onEvent((e) => eventsB.add(e))
    autoRespondDialogs(clientB, eventsB, "B")
    try {
      await withTimeout(clientB.start(), 60000, "start(B)")
      await withTimeout(clientB.setClientInfo(80, ["extension_events"]), 20000, "set_client_info(B)")
      await waitUntilReady(clientB, "B")
      const s1File = String((open1.state as Record<string, unknown>).sessionFile)
      try {
        const openB = await withTimeout(clientB.openSession({ sessionPath: s1File, thinkingLevel: THINKING }), 60000, "open_session(B 同文件)")
        F.lock.idleOpenByB = { result: "success", openB }
        console.log(`B 打开 A 持有的空闲会话：成功 durable=${openB.sessionId}`)
        const rB = await safePrompt(clientB, "回复：FROM-B", { thinkingLevel: THINKING }, 45000)
        console.log(`B prompt=${JSON.stringify(rB)}`)
        F.lock.idleDriveByB = rB
        if (!rB.error) {
          const bMark = eventsB.mark()
          await waitSettledFrom(eventsB, bMark, 180000, "B 轮").catch((e) => console.log(`B settled 等待: ${e.message}`))
          // A 侧随后追加：双进程交替写同一文件
          const aMark = eventsA.mark()
          const rA2 = await safePrompt(clientA, "回复：FROM-A-AFTER-B", { thinkingLevel: THINKING }, 90000)
          console.log(`A 交替写=${JSON.stringify(rA2)}`)
          F.lock.alternatingWrite = rA2
          if (!rA2.error) await waitSettledFrom(eventsA, aMark, 180000, "A 交替写").catch((e) => console.log(`A settled 等待: ${e.message}`))
        }
        await withTimeout(clientB.closeSession(), 20000, "close_session(B)").catch((e) => console.log(`B close: ${e.message}`))
      } catch (e) {
        F.lock.idleOpenByB = { result: "refused", error: e instanceof Error ? e.message : String(e) }
        console.log(`B 打开被拒: ${F.lock.idleOpenByB.error}`)
      }
    } catch (e) {
      failures.push(`P2-11 阶段1 B 启动：${e instanceof Error ? e.message : String(e)}`)
      console.log(`B 启动失败: ${e instanceof Error ? e.message : e}`)
    }
    await stopClient(clientB, "B")

    // ---- P2-11 并发锁（阶段 2：A 流式运行中，B 打开同一会话） ----
    section("P2-11 并发锁阶段 2：A 流式运行中，B 打开同一会话")
    const clientC = newClient()
    const eventsC = new EventLog()
    clientC.onEvent((e) => eventsC.add(e))
    autoRespondDialogs(clientC, eventsC, "C")
    try {
      await withTimeout(clientC.start(), 60000, "start(C)")
      await withTimeout(clientC.setClientInfo(80, ["extension_events"]), 20000, "set_client_info(C)")
      await waitUntilReady(clientC, "C")
      const runningMark = eventsA.mark()
      void clientA.prompt("请从 1 数到 40，每个数字单独一行，不要任何解释", { thinkingLevel: THINKING }).catch(() => undefined)
      await withTimeout(eventsA.waitFor("message_update", 60000, runningMark), 65000, "A 进入流式")
      const s1FileC = String((open1.state as Record<string, unknown>).sessionFile)
      const tOpen = Date.now()
      try {
        const openC = await withTimeout(clientC.openSession({ sessionPath: s1FileC, thinkingLevel: THINKING }), 60000, "open_session(C 运行中)")
        F.lock.runningOpenByC = { result: "success", openMs: Date.now() - tOpen, durable: openC.sessionId }
        console.log(`C 在 A 运行中打开同一会话：成功（${Date.now() - tOpen}ms）`)
        const rC = await safePrompt(clientC, "回复：FROM-C", { thinkingLevel: THINKING }, 45000)
        F.lock.runningDriveByC = rC
        console.log(`C prompt=${JSON.stringify(rC)}`)
      } catch (e) {
        F.lock.runningOpenByC = { result: "refused", error: e instanceof Error ? e.message : String(e) }
        console.log(`C 运行中打开被拒: ${F.lock.runningOpenByC.error}`)
      }
      await clientA.abort().catch(() => undefined)
      await waitSettledFrom(eventsA, runningMark, 120000, "长任务收尾").catch(() => undefined)
      console.log(`A 事件: message_update=${eventsA.of("message_update", runningMark).length}；C 事件: message_update=${eventsC.of("message_update").length}`)
      F.lock.runningPhaseEventCounts = { aMessageUpdates: eventsA.of("message_update", runningMark).length, cMessageUpdates: eventsC.of("message_update").length }
    } catch (e) {
      failures.push(`P2-11 阶段2：${e instanceof Error ? e.message : String(e)}`)
      console.log(`阶段 2 失败: ${e instanceof Error ? e.message : e}`)
    }
    await stopClient(clientC, "C")

    // ---- 收尾 A ----
    const stateFinal = await withTimeout(clientA.getState(), 20000, "get_state(final)").catch(() => null)
    if (stateFinal) F.sessionHeaders.__finalState = stateFinal
    await stopClient(clientA, "A")

    // ---- P1-7 --export HTML（omo CLI 侧，零 token） ----
    section("P1-7 --export HTML 可用性（omo CLI）")
    // fork 会话文件此刻应已被后续回合落盘（锁阶段 A 交替写打到 fork 会话上）
    const forkState = (F.fork.stateAfterFork ?? null) as Record<string, unknown> | null
    const forkFile = forkState ? String(forkState.sessionFile ?? "") : ""
    if (forkFile && existsSync(forkFile)) {
      const fh = readHeader(forkFile)
      if (fh) F.sessionHeaders.__forkedSession = fh
      console.log(`fork 会话文件（终态）header=${brief(fh, 400)}`)
    } else {
      console.log(`fork 会话文件仍未物化: ${forkFile || "(无路径)"}`)
    }
    const s1File = String((open1.state as Record<string, unknown>).sessionFile)
    const outHtml = join(PROJ_DIR, "export-test.html")
    const r = spawnSync("node", [`${REPO}/server/node_modules/omo-ai/bin/omo.js`, "--export", s1File, outHtml], {
      encoding: "utf8",
      timeout: 120000,
      cwd: PROJ_DIR,
      env: { ...process.env, OMO_CODING_AGENT_DIR: AGENT_DIR, SENPI_CODING_AGENT_DIR: AGENT_DIR },
    })
    const exported = existsSync(outHtml) ? statSync(outHtml).size : 0
    F.exportHtml = {
      status: r.status,
      stdoutTail: (r.stdout ?? "").split("\n").slice(-5).join(" | ").slice(0, 400),
      stderrTail: (r.stderr ?? "").split("\n").slice(-5).join(" | ").slice(0, 400),
      outFileBytes: exported,
    }
    console.log(`--export status=${r.status} outFileBytes=${exported}`)
    if (exported === 0) {
      console.log(`stdout: ${F.exportHtml.stdoutTail}`)
      console.log(`stderr: ${F.exportHtml.stderrTail}`)
    }

    // ---- 最终 SDK list（显式 sessionDir vs 默认解析，两组对照） ----
    const sessionsRoot = join(AGENT_DIR, "sessions", "--tmp-opencode-w2-7-proj--")
    const mapSdkRow = (rr: Awaited<ReturnType<typeof SessionManager.list>>[number]) => ({
      path: rr.path,
      id: rr.id,
      cwd: rr.cwd,
      name: rr.name ?? null,
      parentSessionPath: rr.parentSessionPath ?? null,
      created: rr.created,
      modified: rr.modified,
      messageCount: rr.messageCount,
      firstMessage: rr.firstMessage?.slice(0, 80) ?? "",
    })
    const sdkExplicit = await withTimeout(SessionManager.list(PROJ_DIR, sessionsRoot), 30000, "SessionManager.list(显式 sessionDir)").catch(() => [])
    const sdkDefault = await withTimeout(SessionManager.list(PROJ_DIR), 30000, "SessionManager.list(默认解析)").catch(() => [])
    F.sdkListRows = sdkExplicit.map(mapSdkRow)
    F.sdkListRowKeys = { explicitSessionDirRows: sdkExplicit.length, defaultAgentDirRows: sdkDefault.length, keys: sdkExplicit.length ? Object.keys(sdkExplicit[0]!) : [] }
    console.log(`SDK list(显式 sessionDir)=${sdkExplicit.length} 行；list(默认解析)=${sdkDefault.length} 行`)
    const withParent = sdkExplicit.filter((rr) => rr.parentSessionPath)
    console.log(`SDK 行含 parentSessionPath=${withParent.length}：${withParent.map((rr) => `${rr.id} -> ${rr.parentSessionPath}`).join(" ; ") || "(无)"}`)
  } finally {
    // ---- 进程卫生（只按 PID） ----
    await new Promise((r2) => setTimeout(r2, 1000))
    const left = listEngineProcesses()
    for (const p of left) {
      console.log(`清扫遗留引擎进程 ${p.pid}`)
      killByPid(p.pid)
    }
    console.log(`清扫后剩余=${listEngineProcesses().length}`)

    writeFileSync(FIXTURE_PATH, JSON.stringify({ findings: F, failures }, null, 2))
    console.log(`\nfixture 已写 ${FIXTURE_PATH}`)

    section("结论摘要")
    console.log(`P1-1 血缘: fork 立即新文件=${brief(F.fork.newFilesImmediately ?? null, 150)} 终态header=${brief(F.sessionHeaders.__forkedSession ?? null, 300)}`)
    console.log(`P1-1 血缘: task 子会话=${brief((F.taskSubSessions as Record<string, unknown> | null)?.taskHeaders ?? null, 300)}`)
    console.log(`P1-1 SDK 行=${JSON.stringify(F.sdkListRowKeys)}`)
    console.log(`P1-2 todo=${brief({ start: Boolean((F.todoSource as Record<string, unknown>)?.toolExecutionStart), entries: Array.isArray((F.todoSource as Record<string, unknown>)?.persistedEntries) ? ((F.todoSource as Record<string, unknown>).persistedEntries as unknown[]).length : 0 }, 200)}`)
    console.log(`P1-3 图片落盘=${brief(Boolean((F.imageStorage as Record<string, unknown>)?.entryFound), 50)}`)
    console.log(`P1-4 usage sources=${brief(Object.keys(F.usage), 300)}`)
    console.log(`P1-5 agent 枚举=${brief(F.agentEnumeration, 300)}`)
    console.log(`P1-6 编辑重发=${brief(F.editResend, 300)}`)
    console.log(`P1-7 export HTML bytes=${String((F.exportHtml as Record<string, unknown>)?.outFileBytes)}`)
    console.log(`P2-11 lock=${brief(F.lock, 600)}`)
    if (failures.length) console.log(`\n失败项:\n- ${failures.join("\n- ")}`)
    console.log("\nSPIKE DONE")
  }
}

main()
  .catch((e) => {
    console.error(`\nP1 spike FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    for (const p of listEngineProcesses()) killByPid(p.pid)
    process.exitCode = 2
  })
