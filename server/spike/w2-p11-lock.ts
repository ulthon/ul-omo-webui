/**
 * P2-11 并发锁语义 专项复测（w2-p1-findings run3 的锁阶段被 fork 换 context 污染，本脚本干净重测）。
 *
 * 场景：
 *   阶段 1（运行中）：A open 新会话并流式长任务 → B open 同一 sessionPath → B prompt → 观测双方事件
 *   阶段 2（空闲）  ：A 保持 open（已 settled）→ B 再 prompt 同一会话 → 观测
 * 运行：cd /data/projects/ul-omo-webui && bun run server/spike/w2-p11-lock.ts
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
const PROJ_DIR = "/tmp/opencode/w2-7-proj"
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

class Log {
  all: AnyEvent[] = []
  add(e: unknown): void {
    this.all.push(e as AnyEvent)
  }
  count(type: string, from = 0): number {
    return this.all.filter((e, i) => i >= from && e.type === type).length
  }
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

async function main(): Promise<void> {
  mkdirSync(PROJ_DIR, { recursive: true })
  const out: Record<string, unknown> = {}

  const a = newClient()
  const evA = new Log()
  a.onEvent((e) => evA.add(e))
  await withTimeout(a.start(), 60000, "start(A)")
  await withTimeout(a.setClientInfo(80, ["extension_events"]), 20000, "sci(A)")
  await waitUntilReady(a, "A")
  const openA = await withTimeout(a.openSession({ provider: PROVIDER, modelId: MODEL, thinkingLevel: THINKING }), 60000, "open(A)")
  const sFile = String((openA.state as Record<string, unknown>).sessionFile)
  console.log(`A 会话 durable=${openA.sessionId} file=${sFile}`)
  out.sessionFile = sFile

  // ---- 阶段 1：A 流式中，B 打开并 prompt 同一会话 ----
  section("阶段 1：A 流式运行中，B 打开同一会话")
  const aMark = evA.all.length
  void a.prompt("请从 1 数到 60，每个数字单独一行，不要任何解释", { thinkingLevel: THINKING }).catch(() => undefined)
  await withTimeout(
    (async () => {
      for (;;) {
        if (evA.count("message_update", aMark) > 0) return
        await new Promise((r) => setTimeout(r, 100))
      }
    })(),
    60000,
    "A 进入流式",
  )
  console.log(`A 已流式（message_update=${evA.count("message_update", aMark)}）`)

  const b = newClient()
  const evB = new Log()
  b.onEvent((e) => evB.add(e))
  await withTimeout(b.start(), 60000, "start(B)")
  await withTimeout(b.setClientInfo(80, ["extension_events"]), 20000, "sci(B)")
  await waitUntilReady(b, "B")
  try {
    const openB = await withTimeout(b.openSession({ sessionPath: sFile, thinkingLevel: THINKING }), 60000, "open(B 同文件·A运行中)")
    out.runningOpenByB = { result: "success", durable: openB.sessionId }
    console.log(`B 打开成功 durable=${openB.sessionId}`)
  } catch (e) {
    out.runningOpenByB = { result: "refused", error: e instanceof Error ? e.message : String(e) }
    console.log(`B 打开被拒: ${out.runningOpenByB && (out.runningOpenByB as Record<string, unknown>).error}`)
  }
  // B prompt（30s 上限）
  try {
    const d = await withTimeout(b.prompt("回复：FROM-B", { thinkingLevel: THINKING }), 30000, "prompt(B·A运行中)")
    out.runningPromptByB = { disposition: String(d) }
    console.log(`B prompt disposition=${String(d)}`)
  } catch (e) {
    out.runningPromptByB = { rejected: e instanceof Error ? e.message : String(e) }
    console.log(`B prompt 被拒: ${out.runningPromptByB && (out.runningPromptByB as Record<string, unknown>).rejected}`)
  }
  // 8 秒窗口观测双方事件
  const bMark = evB.all.length
  await new Promise((r) => setTimeout(r, 8000))
  out.runningWindow = {
    aMessageUpdates: evA.count("message_update", aMark),
    bMessageUpdates: evB.count("message_update", bMark),
    bAgentStart: evB.count("agent_start", bMark),
    bAgentSettled: evB.count("agent_settled", bMark),
  }
  console.log(`8s 窗口: A message_update=${out.runningWindow && (out.runningWindow as Record<string, unknown>).aMessageUpdates}；B message_update=${out.runningWindow && (out.runningWindow as Record<string, unknown>).bMessageUpdates} B agent_start=${out.runningWindow && (out.runningWindow as Record<string, unknown>).bAgentStart}`)
  await withTimeout(a.abort(), 15000, "abort(A)").catch(() => undefined)
  await new Promise((r) => setTimeout(r, 1500))

  // ---- 阶段 2：A 空闲（settled），B 再 prompt 同一会话 ----
  section("阶段 2：A 空闲但保持 open，B prompt 同一会话")
  try {
    const d2 = await withTimeout(b.prompt("回复：FROM-B-IDLE", { thinkingLevel: THINKING }), 30000, "prompt(B·A空闲)")
    out.idlePromptByB = { disposition: String(d2) }
    console.log(`B prompt disposition=${String(d2)}`)
    const bMark2 = evB.all.length
    const idleDeadline = Date.now() + 60000
    while (evB.count("agent_settled", bMark2) === 0) {
      if (Date.now() > idleDeadline) throw new Error("等待 B 轮 settled 超时 60s")
      await new Promise((r) => setTimeout(r, 200))
    }
    console.log("B 空闲轮 settled 完成")
  } catch (e) {
    out.idlePromptByB = { rejected: e instanceof Error ? e.message : String(e) }
    console.log(`B prompt 被拒: ${out.idlePromptByB && (out.idlePromptByB as Record<string, unknown>).rejected}`)
  }
  await new Promise((r) => setTimeout(r, 8000))
  // B 落定后 A 再写同一会话（同文件双进程交替写）
  try {
    const d3 = await withTimeout(a.prompt("回复：FROM-A-AFTER", { thinkingLevel: THINKING }), 30000, "prompt(A·B写后)")
    out.aWriteAfterB = { disposition: String(d3) }
    console.log(`A 在 B 写入后 prompt disposition=${String(d3)}`)
  } catch (e) {
    out.aWriteAfterB = { rejected: e instanceof Error ? e.message : String(e) }
    console.log(`A prompt 被拒: ${out.aWriteAfterB && (out.aWriteAfterB as Record<string, unknown>).rejected}`)
  }
  await new Promise((r) => setTimeout(r, 12000))

  // 磁盘核对
  try {
    const lines = readFileSync(sFile, "utf8").split("\n").filter((l) => l.trim())
    const fromB = lines.filter((l) => l.includes("FROM-B")).length
    const fromBIdle = lines.filter((l) => l.includes("FROM-B-IDLE")).length
    const fromAAfter = lines.filter((l) => l.includes("FROM-A-AFTER")).length
    out.diskCheck = { totalLines: lines.length, fromB, fromBIdle, fromAAfter }
    console.log(`磁盘核对: 总行=${lines.length} FROM-B=${fromB} FROM-B-IDLE=${fromBIdle} FROM-A-AFTER=${fromAAfter}`)
  } catch (e) {
    out.diskCheck = { error: String(e) }
  }

  await stopClient(b)
  await stopClient(a)
  await new Promise((r) => setTimeout(r, 1000))
  const left = listEngineProcesses()
  for (const p of left) {
    try {
      process.kill(p.pid, "SIGKILL")
    } catch {
      // 已退出
    }
  }
  console.log(`清扫后剩余=${listEngineProcesses().length}`)
  out.leftProcesses = listEngineProcesses().length
  console.log(`\nP2-11 专项结论=${JSON.stringify(out, null, 2)}`)
  console.log("LOCK SPIKE DONE")
}

main().catch((e) => {
  console.error(`P2-11 spike FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  for (const p of listEngineProcesses()) {
    try {
      process.kill(p.pid, "SIGKILL")
    } catch {
      // 已退出
    }
  }
  process.exitCode = 2
})
