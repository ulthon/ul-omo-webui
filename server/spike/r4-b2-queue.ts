/**
 * B2-spike：steer/followUp 排队发送事件流实证（docs08-r4 任务 2，Blocks: 11）。
 *
 * 场景：
 *   A  followUp 基线  ：流式中 prompt({streamingBehavior:"followUp"}) → 回执/落盘时机/wire 事件/时序
 *   B  steer 插队     ：流式中 prompt({streamingBehavior:"steer"}) → 当前回合流是否立刻变化
 *   C  同文本双条排队 ：去重边界 + getSteering/getFollowUp 队列查询
 *   D  撤销           ：clearQueue 撤单实测；abort 是否连带取消已排队消息
 *   F  409 边界       ：跨进程带 streamingBehavior 是否仍并发驾驶（P2-11 对照）
 * 运行：cd /data/projects/ul-omo-webui && bun run server/spike/r4-b2-queue.ts
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readlinkSync } from "node:fs"
import { join } from "node:path"
import { RpcClient } from "@code-yeongyu/senpi"

const REPO = "/data/projects/ul-omo-webui"
const AGENT_DIR = "/root/.pi/agent"
const PROVIDER = "zai-coding-cn"
const MODEL = "glm-5.3-flash"
const THINKING = "low" as const
const PROJ_DIR = "/tmp/opencode/r4-b2-proj"
const SELF_PID = process.pid

function engineCli(): string {
  const p = `${REPO}/node_modules/.bun/omo-ai@5.1.0/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js`
  if (!existsSync(p)) throw new Error(`引擎 cli 不存在: ${p}`)
  return p
}

const PLUGIN_DIR = `${REPO}/server/node_modules/omo-ai/plugin`

function newClient(): RpcClient {
  return new RpcClient({
    cliPath: engineCli(),
    args: ["--extension", PLUGIN_DIR, "--multi-session"],
    cwd: PROJ_DIR,
    env: { OMO_CODING_AGENT_DIR: AGENT_DIR, SENPI_CODING_AGENT_DIR: AGENT_DIR, OMO_NATIVE: "1", PI_OFFLINE: "1" },
    provider: PROVIDER,
    model: MODEL,
  })
}

type AnyEvent = Record<string, unknown>
interface Logged {
  t: number
  type: string
  json: string
}

function section(t: string): void {
  console.log(`\n=== ${t} ===`)
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

async function waitUntilReady(client: RpcClient, label: string): Promise<void> {
  const send = (client as unknown as { send: (m: unknown) => Promise<{ success: boolean }> }).send.bind(client)
  for (let i = 1; i <= 15; i++) {
    try {
      if ((await send({ type: "get_protocol_info" })).success) {
        console.log(`[${label}] 就绪（第 ${i} 次探测）`)
        return
      }
    } catch {
      // 重试
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`[${label}] 就绪探测失败`)
}

/** 带相对时间戳的事件日志：message_update 只计数，其余事件全量 compact JSON。 */
class Log {
  all: Logged[] = []
  t0 = Date.now()
  updates = 0
  add(e: unknown): void {
    const ev = e as AnyEvent
    const type = String(ev.type ?? "?")
    if (type === "message_update") {
      this.updates += 1
      return
    }
    this.all.push({ t: Date.now() - this.t0, type, json: compact(ev) })
  }
  count(type: string, from = 0): number {
    return this.all.filter((e, i) => i >= from && e.type === type).length
  }
  /** 打印 [from, to) 区间的全部非 update 事件（带相对 ms）。 */
  dump(from: number, to: number, label: string): void {
    for (let i = from; i < to && i < this.all.length; i++) {
      const e = this.all[i]
      console.log(`  [${String(e.t).padStart(6)}ms] ${e.type} ${e.json}`)
    }
    console.log(`  (${label}: 非 update 事件 ${Math.min(to, this.all.length) - from} 条，message_update 累计 ${this.updates})`)
  }
  mark(): number {
    return this.all.length
  }
}

function compact(v: unknown): string {
  let s: string
  try {
    s = JSON.stringify(v)
  } catch {
    s = String(v)
  }
  return s.length > 700 ? `${s.slice(0, 700)}…` : s
}

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

async function stopClient(client: RpcClient): Promise<void> {
  try {
    await withTimeout(client.stop(), 8000, "stop")
  } catch {
    for (const p of listEngineProcesses()) {
      try {
        process.kill(p.pid, "SIGKILL")
      } catch {
        // 已退出
      }
    }
  }
}

/** 磁盘核对：会话文件中含指定标记的行数与行号。 */
function diskGrep(sFile: string, marker: string): { count: number; lines: number[]; total: number } | { error: string } {
  try {
    const lines = readFileSync(sFile, "utf8").split("\n").filter((l) => l.trim())
    const hits: number[] = []
    lines.forEach((l, i) => {
      if (l.includes(marker)) hits.push(i + 1)
    })
    return { count: hits.length, lines: hits, total: lines.length }
  } catch (e) {
    return { error: String(e) }
  }
}

async function startTurnAnd_stream(client: RpcClient, log: Log, text: string, label: string): Promise<number> {
  const mark = log.mark()
  void client.prompt(text, { thinkingLevel: THINKING }).catch(() => undefined)
  const deadline = Date.now() + 90000
  for (;;) {
    if (log.updates > 0) return mark
    if (Date.now() > deadline) throw new Error(`${label} 进入流式超时`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** 等待自 mark 起 count 个 agent_settled。 */
async function waitSettles(log: Log, mark: number, n: number, label: string): Promise<void> {
  const deadline = Date.now() + 240000
  for (;;) {
    if (log.count("agent_settled", mark) >= n) return
    if (Date.now() > deadline) throw new Error(`${label} 等待 ${n} 次 agent_settled 超时（当前 ${log.count("agent_settled", mark)}）`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** 非致命等待：再等一个 settled（去重场景判别用）。 */
async function waitExtraSettle(log: Log, mark: number, timeoutMs: number): Promise<boolean> {
  const base = log.count("agent_settled", mark)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (log.count("agent_settled", mark) > base) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function promptWithBehavior(
  client: RpcClient,
  text: string,
  behavior: "steer" | "followUp",
  label: string,
): Promise<{ ackMs: number; disposition: string; error?: string }> {
  const t0 = Date.now()
  try {
    // 实测约束：排队 prompt 不得携带 thinkingLevel（引擎报错 "Cannot set thinkingLevel
    // on a queued prompt; set it after the current turn completes."），故排队调用只带 behavior
    const d = await withTimeout(client.prompt(text, { streamingBehavior: behavior }), 30000, label)
    return { ackMs: Date.now() - t0, disposition: String(d) }
  } catch (e) {
    return { ackMs: Date.now() - t0, disposition: "", error: e instanceof Error ? e.message : String(e) }
  }
}

async function main(): Promise<void> {
  mkdirSync(PROJ_DIR, { recursive: true })
  const out: Record<string, unknown> = {}
  const LONG_TASK = "请从 1 数到 60，每个数字单独一行，不要任何解释"

  const a = newClient()
  const evA = new Log()
  a.onEvent((e) => evA.add(e))
  await withTimeout(a.start(), 60000, "start(A)")
  await withTimeout(a.setClientInfo(80, ["extension_events"]), 20000, "sci(A)")
  await waitUntilReady(a, "A")
  const openA = await withTimeout(a.openSession({ provider: PROVIDER, modelId: MODEL, thinkingLevel: THINKING }), 60000, "open(A)")
  const sFile = String((openA.state as unknown as Record<string, unknown>).sessionFile)
  console.log(`A 会话 durable=${openA.sessionId} file=${sFile}`)
  out.sessionFile = sFile

  // ---- 场景 A：followUp 基线 ----
  section("场景 A：流式中 followUp 排队")
  const aMark = await startTurnAnd_stream(a, evA, LONG_TASK, "A-turn1")
  console.log(`turn1 已流式（message_update=${evA.updates}）`)
  const before = diskGrep(sFile, "Q-FOLLOWUP-A1")
  console.log(`排队前磁盘: ${JSON.stringify(before)}`)
  const ackA = await promptWithBehavior(a, "回复：Q-FOLLOWUP-A1", "followUp", "prompt(followUp)")
  console.log(`followUp 回执: ${JSON.stringify(ackA)}`)
  const afterAck = diskGrep(sFile, "Q-FOLLOWUP-A1")
  console.log(`回执后立刻磁盘: ${JSON.stringify(afterAck)}`)
  const settleMark = evA.mark()
  await withTimeout(waitSettles(evA, aMark, 2, "场景A"), 240000, "场景A 双 settled").catch((e) =>
    console.log(`等待异常: ${e instanceof Error ? e.message : String(e)}`),
  )
  console.log("turn1→排队回合 全部 settled，事件时间线：")
  evA.dump(settleMark, evA.all.length, "场景A")
  const afterAll = diskGrep(sFile, "Q-FOLLOWUP-A1")
  console.log(`落定后磁盘: ${JSON.stringify(afterAll)}`)
  out.scenarioA = { ack: ackA, diskBeforeQueue: before, diskAfterAck: afterAck, diskAfterSettle: afterAll }

  // ---- 场景 B：steer 插队 ----
  section("场景 B：流式中 steer 插队")
  const bMark = await startTurnAnd_stream(a, evA, LONG_TASK, "B-turn1")
  const updBefore = evA.updates
  const ackB = await promptWithBehavior(a, "回复：Q-STEER-B1", "steer", "prompt(steer)")
  console.log(`steer 回执: ${JSON.stringify(ackB)}（此前 message_update=${updBefore}）`)
  const bWindowMark = evA.mark()
  await new Promise((r) => setTimeout(r, 8000))
  const updAfter = evA.updates
  console.log(`steer 后 8s 窗口: message_update 增量=${updAfter - updBefore}，事件：`)
  evA.dump(bWindowMark, evA.all.length, "场景B 窗口")
  const bSettleMark = evA.mark()
  await withTimeout(waitSettles(evA, bMark, 2, "场景B"), 240000, "场景B 双 settled").catch((e) =>
    console.log(`等待异常: ${e instanceof Error ? e.message : String(e)}`),
  )
  console.log("steer 场景全部 settled，事件时间线：")
  evA.dump(bSettleMark, evA.all.length, "场景B")
  const diskB = diskGrep(sFile, "Q-STEER-B1")
  console.log(`磁盘核对 Q-STEER-B1: ${JSON.stringify(diskB)}`)
  out.scenarioB = { ack: ackB, updates8sWindow: updAfter - updBefore, disk: diskB }

  // ---- 场景 C：同文本双条 followUp + 队列查询 ----
  section("场景 C：同文本双条排队 + 队列查询")
  const cMark = await startTurnAnd_stream(a, evA, LONG_TASK, "C-turn1")
  const ackC1 = await promptWithBehavior(a, "回复：Q-DUP-C", "followUp", "prompt(dup#1)")
  const ackC2 = await promptWithBehavior(a, "回复：Q-DUP-C", "followUp", "prompt(dup#2)")
  console.log(`双条回执: #1=${JSON.stringify(ackC1)} #2=${JSON.stringify(ackC2)}`)
  let steering: unknown
  let followUps: unknown
  try {
    steering = await withTimeout((a as unknown as { getSteeringMessages: () => Promise<string[]> }).getSteeringMessages(), 15000, "getSteering")
    followUps = await withTimeout((a as unknown as { getFollowUpMessages: () => Promise<string[]> }).getFollowUpMessages(), 15000, "getFollowUp")
  } catch (e) {
    steering = `查询失败: ${e instanceof Error ? e.message : String(e)}`
  }
  console.log(`队列查询: steering=${JSON.stringify(steering)} followUp=${JSON.stringify(followUps)}`)
  const cSettleMark = evA.mark()
  await withTimeout(waitSettles(evA, cMark, 2, "场景C"), 240000, "场景C 两 settled").catch((e) =>
    console.log(`等待异常: ${e instanceof Error ? e.message : String(e)}`),
  )
  const thirdSettle = await waitExtraSettle(evA, cMark, 90000)
  console.log(`第 3 个 settled 是否出现（true=双条各起一轮；false=疑似去重）: ${thirdSettle}`)
  console.log("双条排队全部落定，事件时间线：")
  evA.dump(cSettleMark, evA.all.length, "场景C")
  const diskC = diskGrep(sFile, "Q-DUP-C")
  console.log(`磁盘核对 Q-DUP-C（去重边界：user 条目 1 条=去重，2 条=不去重）: ${JSON.stringify(diskC)}`)
  out.scenarioC = { ack1: ackC1, ack2: ackC2, queueQuery: { steering, followUps }, disk: diskC }

  // ---- 场景 D：clearQueue 撤单 + abort 连带 ----
  section("场景 D1：clearQueue 撤销已排队 followUp")
  const dMark = await startTurnAnd_stream(a, evA, LONG_TASK, "D-turn1")
  const ackD = await promptWithBehavior(a, "回复：Q-UNDO-D", "followUp", "prompt(undo)")
  console.log(`排队回执: ${JSON.stringify(ackD)}`)
  let cleared: unknown
  try {
    cleared = await withTimeout(
      (a as unknown as { clearQueue: (o?: { abortWillFollow?: boolean }) => Promise<unknown> }).clearQueue(),
      15000,
      "clearQueue",
    )
  } catch (e) {
    cleared = `clearQueue 失败: ${e instanceof Error ? e.message : String(e)}`
  }
  console.log(`clearQueue 结果: ${JSON.stringify(cleared)}`)
  await withTimeout(waitSettles(evA, dMark, 1, "场景D"), 240000, "场景D turn1 settled").catch((e) =>
    console.log(`等待异常: ${e instanceof Error ? e.message : String(e)}`),
  )
  await new Promise((r) => setTimeout(r, 5000))
  const settlesD1 = evA.count("agent_settled", dMark)
  const diskD = diskGrep(sFile, "Q-UNDO-D")
  console.log(`turn1 settled 后 5s：settled 总数=${settlesD1}（撤单成功=1，无第二轮），磁盘 Q-UNDO-D=${JSON.stringify(diskD)}`)
  out.scenarioD1 = { ack: ackD, cleared, settlesAfterClear: settlesD1, disk: diskD }

  section("场景 D2：abort 是否连带取消已排队消息")
  const d2Mark = await startTurnAnd_stream(a, evA, LONG_TASK, "D2-turn1")
  const ackD2 = await promptWithBehavior(a, "回复：Q-ABORT-E", "followUp", "prompt(abort+queue)")
  console.log(`排队回执: ${JSON.stringify(ackD2)}`)
  await withTimeout(a.abort(), 15000, "abort(D2)").catch(() => undefined)
  await new Promise((r) => setTimeout(r, 10000))
  const settlesD2 = evA.count("agent_settled", d2Mark)
  const diskD2 = diskGrep(sFile, "Q-ABORT-E")
  let queueAfterAbort: unknown
  try {
    queueAfterAbort = await withTimeout((a as unknown as { getFollowUpMessages: () => Promise<string[]> }).getFollowUpMessages(), 15000, "getFollowUp(D2)")
  } catch (e) {
    queueAfterAbort = `查询失败: ${e instanceof Error ? e.message : String(e)}`
  }
  console.log(`abort 后 10s：settled=${settlesD2}（1=仅原回合中止，2=排队回合仍执行），磁盘 Q-ABORT-E=${JSON.stringify(diskD2)}，残留队列=${JSON.stringify(queueAfterAbort)}`)
  out.scenarioD2 = { ack: ackD2, settlesAfterAbort: settlesD2, disk: diskD2, queueAfterAbort }

  // ---- 场景 F：409 边界（跨进程带 streamingBehavior） ----
  section("场景 F：跨进程 prompt 带 streamingBehavior（A 流式中，B open 同文件）")
  const fMark = await startTurnAnd_stream(a, evA, LONG_TASK, "F-turn1")
  console.log(`A 已流式（message_update=${evA.updates}）`)
  const b = newClient()
  const evB = new Log()
  b.onEvent((e) => evB.add(e))
  await withTimeout(b.start(), 60000, "start(B)")
  await withTimeout(b.setClientInfo(80, ["extension_events"]), 20000, "sci(B)")
  await waitUntilReady(b, "B")
  let openB = ""
  try {
    const ob = await withTimeout(b.openSession({ sessionPath: sFile, thinkingLevel: THINKING }), 60000, "open(B)")
    openB = ob.sessionId
    console.log(`B 打开成功 durable=${openB}`)
  } catch (e) {
    console.log(`B 打开被拒: ${e instanceof Error ? e.message : String(e)}`)
  }
  // F1：B 跨进程带 followUp prompt（B 自身实例空闲）
  const ackF1 = await promptWithBehavior(b, "回复：FROM-B-FU", "followUp", "prompt(B·followUp)")
  console.log(`B 带 followUp 跨进程回执: ${JSON.stringify(ackF1)}`)
  // F2：B 起了回合后再 prompt（同进程内）不带 behavior → 期望 already processing 报错
  await new Promise((r) => setTimeout(r, 2000))
  const bUpdatesBefore = evB.updates
  const ackF2WithBehavior = await promptWithBehavior(b, "回复：FROM-B-QUEUED", "followUp", "prompt(B·二连带behavior)")
  console.log(`B 二连带 behavior 回执: ${JSON.stringify(ackF2WithBehavior)}`)
  let ackF3NoBehavior: { ackMs: number; disposition: string; error?: string }
  const t0F3 = Date.now()
  try {
    const d = await withTimeout(b.prompt("回复：FROM-B-NOBEHAVIOR2", { thinkingLevel: THINKING }), 30000, "prompt(B·无behavior)")
    ackF3NoBehavior = { ackMs: Date.now() - t0F3, disposition: String(d) }
  } catch (e) {
    ackF3NoBehavior = { ackMs: Date.now() - t0F3, disposition: "", error: e instanceof Error ? e.message : String(e) }
  }
  console.log(`B 二连无 behavior 回执: ${JSON.stringify(ackF3NoBehavior)}`)
  await new Promise((r) => setTimeout(r, 8000))
  console.log(`B 窗口事件（非 update）：`)
  evB.dump(0, evB.all.length, "场景B进程事件")
  console.log(`B message_update 增量=${evB.updates - bUpdatesBefore}`)
  out.scenarioF = { openB, bFollowUpCrossProcess: ackF1, bSecondWithBehavior: ackF2WithBehavior, bSecondNoBehavior: ackF3NoBehavior }
  await new Promise((r) => setTimeout(r, 4000))
  const diskF = { fromB: diskGrep(sFile, "FROM-B-FU"), bQueued: diskGrep(sFile, "FROM-B-QUEUED"), noBehavior: diskGrep(sFile, "FROM-B-NOBEHAVIOR") }
  console.log(`磁盘核对: ${JSON.stringify(diskF)}`)
  out.scenarioFDisk = diskF

  // ---- 清理 ----
  try {
    await withTimeout(a.abort(), 10000, "abort(final A)").catch(() => undefined)
  } catch {
    // 忽略
  }
  await stopClient(b)
  await stopClient(a)
  await new Promise((r) => setTimeout(r, 1500))
  const left = listEngineProcesses()
  for (const p of left) {
    try {
      process.kill(p.pid, "SIGKILL")
    } catch {
      // 已退出
    }
  }
  await new Promise((r) => setTimeout(r, 800))
  out.leftProcesses = listEngineProcesses().length
  console.log(`清扫后剩余=${out.leftProcesses}`)
  console.log(`\nB2-spike 结论=${JSON.stringify(out, null, 2)}`)
  console.log("B2 SPIKE DONE")
}

main().catch((e) => {
  console.error(`B2 spike FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  for (const p of listEngineProcesses()) {
    try {
      process.kill(p.pid, "SIGKILL")
    } catch {
      // 已退出
    }
  }
  process.exitCode = 2
})
