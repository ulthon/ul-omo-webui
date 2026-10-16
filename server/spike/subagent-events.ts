/**
 * W4 todo 11 subagent 事件订阅与 payload 实测 spike（HARD GATE）。
 *
 * 五问取证（判定 PASS/FAIL 门槛 todo 12/13）：
 *   Q1 set_subagent_subscription RPC 是否存在；progress / events 两档差异——
 *      open_session 前后各发一帧原始探针，逐字记录响应；
 *   Q2 子代理事件是否需要握手 capability 扩容——按 adapter 现行握手
 *      setClientInfo(80, ["extension_events"]) 原样实测，另取 get_protocol_info
 *      的宿主 capability 清单对照；
 *   Q3 事件 payload 字段表——真实触发一个子代理（task 工具，后台模式），全量捕获
 *      事件流，对 subagent_lifecycle / subagent_progress / subagent_event /
 *      omo.dag.event / omo.task.updated 五类目标逐字留存原始帧；并逐字留存
 *      task 工具的 tool_execution_* 与 message_end 帧（父会话侧可见通道）；
 *   Q4 事件如何锚定会话——对比 open_session 的路由句柄 vs state.sessionId 持久 id，
 *      与事件帧携带的 sessionId 逐字比对；
 *   Q5 判定素材：至少一类 lifecycle/progress/event 帧携带可用子代理标识字段。
 *
 * 运行：bun run server/spike/subagent-events.ts
 * 模型：zai-coding-cn/glm-5.3-flash thinking low（驱动预算 ≤3 次 prompt；单轮脚本
 * 驱动 1 次。引擎内部回合放大——父回合工具循环 + 子代理自身回合——按 run_stats
 * 与 usageTotals 如实计入报告）。
 * 证据：.omo/qa/W4/subagent-spike.log（全量原始帧逐字落盘）。
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { RpcClient } from "@code-yeongyu/senpi"

const AGENT_DIR = "/root/.pi/agent"
const PROVIDER = "zai-coding-cn"
const MODEL = "glm-5.3-flash"
const THINKING = "low"
const PROJ_DIR = "/tmp/opencode/w4-11-subagent-proj"
const REPO = "/data/projects/ul-omo-webui"
const LOG_PATH = join(REPO, ".omo/qa/W4/subagent-spike.log")
const SELF_PID = process.pid

// 五类目标事件：事件帧 type 或 extension_event 的 name 命中即逐字留存
const TARGET_EVENT_NAMES = [
  "subagent_lifecycle",
  "subagent_progress",
  "subagent_event",
  "omo.dag.event",
  "omo.task.updated",
]

function engineCli(): string {
  const base = join(REPO, "node_modules/.bun")
  if (existsSync(base)) {
    for (const dir of readdirSync(base)) {
      // omo-ai 5.1.0 官配 senpi 2026.9.28-7（package.json 依赖锁定，同 w4-24-commands.ts）
      if (!dir.startsWith("@code-yeongyu+senpi@2026.9.28-7")) continue
      const p = join(base, dir, "node_modules", "@code-yeongyu", "senpi", "dist", "bundle", "cli.js")
      if (existsSync(p)) return p
    }
  }
  throw new Error("引擎 cli 不存在（.bun 旁路官配）")
}

const PLUGIN_DIR = join(REPO, "server/node_modules/omo-ai/plugin")

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

// ---- 工具（沿用 W4 spike 形态） ----

type AnyFrame = Record<string, unknown> & { _t?: number; _recvMs?: number }

const lines: string[] = []
function log(s: string): void {
  console.log(s)
  lines.push(s)
}

function raw(value: unknown): string {
  const s = JSON.stringify(value)
  return s === undefined ? "undefined" : s
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

async function waitUntilReady(client: RpcClient): Promise<boolean> {
  const send = (client as unknown as { send: (m: unknown) => Promise<{ success: boolean }> }).send.bind(client)
  for (let i = 1; i <= 20; i++) {
    try {
      const r = await send({ type: "get_protocol_info" })
      if (r.success) {
        log(`引擎就绪（第 ${i} 次探测）`)
        return true
      }
    } catch {
      /* 重试 */
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

/** 原始帧捕获：type / extension_event.name 命中目标即标 target=true */
class EventLog {
  readonly all: AnyFrame[] = []
  add(e: unknown): void {
    const f = e as AnyFrame
    const name = typeof f.name === "string" ? f.name : ""
    const target =
      TARGET_EVENT_NAMES.includes(String(f.type ?? "")) || TARGET_EVENT_NAMES.includes(name)
    this.all.push({ ...f, _recvMs: Date.now(), target })
  }
  mark(): number {
    return this.all.length
  }
  slice(fromIndex: number): AnyFrame[] {
    return this.all.slice(fromIndex)
  }
  async waitFor(type: string, timeoutMs: number, fromIndex: number): Promise<AnyFrame> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.all.find((e, i) => i >= fromIndex && e.type === type)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`等待事件 ${type} 超时 ${timeoutMs}ms`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

/** 对话框自动应答兜底（防 select/confirm/input/editor 弹窗阻塞回合） */
function autoRespondDialogs(client: RpcClient): void {
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
      log(`[dialog] 自动应答 method=${method} id=${id.slice(0, 8)}`)
      const send = (client as unknown as { send: (m: unknown) => Promise<unknown> }).send.bind(client)
      void send(frame).catch(() => undefined)
    }
  })
}

function listEngineProcesses(): number[] {
  const r = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8", timeout: 5000 })
  if (r.status !== 0 || !r.stdout) return []
  return r.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2] }))
    .filter((p) => p.pid !== SELF_PID && /--mode rpc|--multi-session/.test(p.cmd))
    .filter((p) => existsSync(`/proc/${p.pid}/cwd`) && readlinkSync(`/proc/${p.pid}/cwd`) === PROJ_DIR)
    .map((p) => p.pid)
}

/** 事件帧顶层键清单（字段表素材） */
function topKeys(f: AnyFrame): string[] {
  return Object.keys(f).filter((k) => !k.startsWith("_"))
}

async function probe(client: RpcClient, label: string, frame: Record<string, unknown>): Promise<void> {
  const send = (client as unknown as { send: (m: unknown) => Promise<unknown> }).send.bind(client)
  log(`[probe] ${label} 发送: ${raw(frame)}`)
  try {
    const r = await withTimeout(send(frame), 20000, label)
    log(`[probe] ${label} 响应: ${raw(r)}`)
  } catch (e) {
    log(`[probe] ${label} 异常: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ---- 主流程 ----

async function main(): Promise<void> {
  log(`=== W4 todo 11 subagent 事件订阅与 payload 实测（run2：后台模式 + open 后探针） ${new Date().toISOString()} ===`)
  log(`模型=${PROVIDER}/${MODEL} thinking=${THINKING} cwd=${PROJ_DIR}`)
  log(`握手 capability（复刻 adapter 现行）=["extension_events"]`)
  mkdirSync(PROJ_DIR, { recursive: true })
  mkdirSync(join(REPO, ".omo/qa/W4"), { recursive: true })

  const client = newClient()
  const events = new EventLog()
  client.onEvent((e) => events.add(e))
  autoRespondDialogs(client)

  try {
    await withTimeout(client.start(), 60000, "start")
    if (!(await waitUntilReady(client))) throw new Error("引擎 40s 未就绪")

    // ---- A 段：免费协议探针（不耗模型预算） ----
    log("\n=== A1 get_protocol_info：宿主 capability 清单（Q2 证据） ===")
    const sendRaw = (client as unknown as { send: (m: unknown) => Promise<Record<string, unknown>> }).send.bind(client)
    const info = await withTimeout(sendRaw({ type: "get_protocol_info" }), 20000, "get_protocol_info")
    const caps = (info.data as { capabilities?: string[] } | undefined)?.capabilities
    log(`[analysis] 宿主 capabilities=${raw(caps)}`)
    log(
      `[analysis] 宿主清单中 subagent/subscription/task 相关 capability：${
        (caps ?? []).filter((c) => /subagent|task|subscri|dag/i.test(c)).join(",") || "（无）"
      }`,
    )

    log("\n=== A2 复刻 adapter 握手：setClientInfo(80, [extension_events]) ===")
    await withTimeout(client.setClientInfo(80, ["extension_events"]), 20000, "set_client_info")
    log(`[probe] set_client_info 完成（现行 adapter 同参，无扩容）`)

    log("\n=== A3 set_subagent_subscription 探针（open_session 前） ===")
    await probe(client, "open前 tier=progress", { type: "set_subagent_subscription", tier: "progress" })
    await probe(client, "open前 tier=events", { type: "set_subagent_subscription", tier: "events" })

    // ---- B 段：真实子代理回合（1 次模型预算） ----
    log("\n=== B1 open_session：路由句柄 vs 持久 id（Q4 锚点） ===")
    const openRes = (await withTimeout(
      client.openSession({ provider: PROVIDER, modelId: MODEL, thinkingLevel: THINKING }) as never,
      60000,
      "open_session",
    )) as { sessionId?: string; state?: { sessionId?: string; sessionFile?: string }; attached?: boolean }
    const routingId = String(openRes.sessionId ?? "")
    const durableId = String(openRes.state?.sessionId ?? "")
    log(`[analysis] 路由句柄 sessionId=${routingId}`)
    log(`[analysis] 持久 id state.sessionId=${durableId}`)
    log(`[analysis] sessionFile=${String(openRes.state?.sessionFile ?? "")}`)

    log("\n=== B2 set_subagent_subscription 探针（open_session 后，Q1 定性） ===")
    await probe(client, "open后 tier=progress", { type: "set_subagent_subscription", tier: "progress" })
    await probe(client, "open后 tier=events", { type: "set_subagent_subscription", tier: "events" })

    log("\n=== B3 真实子代理触发（后台模式）：task 工具列出 /tmp/opencode 前 5 个文件 ===")
    const mark = events.mark()
    const PROMPT =
      "用 task 工具派一个子代理：让子代理执行 ls /tmp/opencode 并只取前 5 个文件名回复。task 调用参数 category 用 unspecified-high、run_in_background 用 true。不要使用 todo 工具。子代理派出后等它的结果到达，再用一句话告诉我它列出了什么。"
    void client.prompt(PROMPT, { thinkingLevel: THINKING }).catch(() => undefined)
    await withTimeout(events.waitFor("agent_settled", 300000, mark), 310000, "父回合 agent_settled")
    log(`[run] 父回合 agent_settled 已到`)

    // 尾窗：后台子代理晚于父回合落定；出现终态 omo.task.updated 或 150s 上限即收
    log("\n=== B4 后台任务尾窗：等待 omo.task.updated 终态 ===")
    const tailStart = Date.now()
    for (;;) {
      await new Promise((r) => setTimeout(r, 500))
      const hits = events.all.filter((e) => e.target)
      const terminal = hits.some((e) => /"(status|residency_state|state)"\s*:\s*"(complete|completed|finished|done|failed|error|cancelled)"/i.test(raw(e)))
      if (terminal) {
        log(`[run] 检测到终态任务帧，收口（尾窗 ${Date.now() - tailStart}ms）`)
        break
      }
      if (Date.now() - tailStart >= 150000) {
        log(`[run] 尾窗 150s 上限收口（未见可识别终态帧）`)
        break
      }
    }
    await new Promise((r) => setTimeout(r, 3000))

    // ---- C 段：统计与逐字留存 ----
    log("\n=== C1 窗口事件统计 ===")
    const window = events.slice(mark)
    const typeHist: Record<string, number> = {}
    const nameHist: Record<string, number> = {}
    for (const e of window) {
      const t = String(e.type ?? "?")
      typeHist[t] = (typeHist[t] ?? 0) + 1
      if (t === "extension_event") {
        const n = String(e.name ?? "?")
        nameHist[n] = (nameHist[n] ?? 0) + 1
      }
    }
    log(`[stats] 事件帧总数=${window.length}`)
    log(`[stats] type 直方图=${raw(typeHist)}`)
    log(`[stats] extension_event name 直方图=${raw(nameHist)}`)
    const targetHits = window.filter((e) => e.target)
    log(`[stats] 五类目标帧命中数=${targetHits.length}`)

    log("\n=== C2 五类目标帧逐字留存（每类全量，帧内不再截断） ===")
    if (targetHits.length === 0) {
      log("[stats] 无任何目标帧。")
    }
    for (const e of targetHits) {
      const label = e.type === "extension_event" ? `extension_event/${String(e.name)}` : String(e.type)
      log(`[target] ---- ${label} @+${e._recvMs! - (events.all[mark]?._recvMs ?? e._recvMs!)}ms keys=${raw(topKeys(e))}`)
      log(`[target] ${raw(e)}`)
    }

    log("\n=== C3 task 工具通道逐字留存（tool_execution_* 与 task message_end） ===")
    const taskFrames = window.filter((e) => {
      const t = String(e.type ?? "")
      if (t === "tool_execution_start" || t === "tool_execution_update" || t === "tool_execution_end") return true
      if (t === "message_end" && raw(e).includes('"toolName":"task"')) return true
      return false
    })
    log(`[stats] task 通道帧数=${taskFrames.length}（tool_execution_* 全量 + task message_end）`)
    for (const e of taskFrames) {
      const s = raw(e)
      log(`[taskchan] ---- ${String(e.type)} keys=${raw(topKeys(e))}`)
      log(`[taskchan] ${s.length > 6000 ? s.slice(0, 6000) + "...<截断,全长" + s.length + ">" : s}`)
    }

    log("\n=== C4 会话清单（含 worker）与用量对账 ===")
    try {
      const lst = await withTimeout(sendRaw({ type: "list_sessions", include_workers: true }), 20000, "list_sessions")
      log(`[probe] list_sessions(include_workers) 响应: ${raw(lst)}`)
    } catch (e) {
      log(`[probe] list_sessions 异常: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      const stats = (await withTimeout(client.getState(), 20000, "get_state")) as Record<string, unknown>
      log(`[analysis] 父会话 usageTotals=${raw(stats.usageTotals)}`)
    } catch (e) {
      log(`[analysis] get_state 异常: ${e instanceof Error ? e.message : String(e)}`)
    }

    log("\n=== C5 事件帧 sessionId 锚点比对（Q4） ===")
    const withSid = window.filter((e) => "sessionId" in e)
    const sidVals = new Set(withSid.map((e) => String(e.sessionId)))
    log(`[stats] 窗口内带 sessionId 字段的帧=${withSid.length}/${window.length}；取值集合=${raw([...sidVals])}`)
    for (const sid of sidVals) {
      log(
        `[analysis] ${sid} === 路由句柄(${routingId.slice(0, 12)}…)? ${sid === routingId}；=== 持久 id(${durableId.slice(0, 12)}…)? ${sid === durableId}`,
      )
    }
    const extWithSid = window.filter((e) => e.type === "extension_event")
    const extSidVals = new Set(extWithSid.map((e) => String((e as AnyFrame).sessionId ?? "<无>")))
    log(`[stats] extension_event 帧携带 sessionId 取值=${raw([...extSidVals])}`)

    log("\n=== C6 模型预算对账 ===")
    log(`[budget] 本脚本驱动 prompt 数=1（run2）；run1 另驱 1 次（合计 2/≤3）`)
    log(`[budget] 引擎内部放大（父回合工具循环 + 子代理自身回合）以 run_stats/usageTotals 如实计入报告`)

    log("\n=== 收尾 ===")
    await withTimeout(client.stop(), 8000, "stop").catch(() => undefined)
    log("client.stop() 完成")
  } finally {
    const leftover = listEngineProcesses()
    for (const pid of leftover) {
      try {
        process.kill(pid, "SIGKILL")
        log(`[cleanup] 强杀遗留引擎进程 pid=${pid}`)
      } catch {
        /* 已退出 */
      }
    }
    const left = listEngineProcesses()
    log(`[cleanup] 复核剩余引擎进程=${left.length}（本 spike spawn 的引擎由 client.stop() 终止；遗留者已按 PID 清扫）`)
  }
}

main()
  .then(() => {
    writeFileSync(LOG_PATH, lines.join("\n") + "\n")
    console.log(`\n证据已写 ${LOG_PATH}`)
    process.exit(0)
  })
  .catch((e) => {
    log(`SPIKE FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    mkdirSync(join(REPO, ".omo/qa/W4"), { recursive: true })
    writeFileSync(LOG_PATH, lines.join("\n") + "\n")
    for (const pid of listEngineProcesses()) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        /* 已退出 */
      }
    }
    process.exit(1)
  })
