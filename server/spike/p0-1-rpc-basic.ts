/**
 * P0-1 RPC 基本链路验证 spike（todo 3，W1 go/no-go 门）。
 *
 * 一次运行走完整链路：spawn 引擎 RPC 子进程 -> 官方 RpcClient 连接 -> 列/建会话
 * -> 发短 prompt -> 收集 AgentSessionEvent 流样本 -> 消息分页读取 -> abort。
 * 附带两项关键实测：
 *   (a) 同一子进程并发第二个会话并发消息（多会话复用，决定 W2 进程模型）；
 *   (b) 会话列表查询返回行的字段形态（parent/血缘字段与 agent 字段，决定 W3 钻取方案）。
 *
 * 运行：bun run server/spike/p0-1-rpc-basic.ts
 * 模型：zai-coding-cn/glm-5.3-flash（todo 2 选定；thinking 取 off 档）。
 * spawn 前置：HOME 继承当前用户；OMO_CODING_AGENT_DIR=/root/.pi/agent（00-env.md 结论）。
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { RpcClient } from "@code-yeongyu/senpi"

// ---- 常量（全部来自 00-env.md / 计划约束） ----

const AGENT_DIR = "/root/.pi/agent" // OMO_CODING_AGENT_DIR 指向实际凭证目录（只读复用）
const PROVIDER = "zai-coding-cn"
const MODEL = "glm-5.3-flash"
const THINKING = "off" as const
const PROJ_DIR = "/tmp/opencode/p0-1-proj"
const SELF_PID = process.pid

// 候选入口，按序试（计划指定顺序）：omo-ai 包 bin `omo`；其内 senpi bin `senpi --mode rpc`。
function embeddedSenpiCli(): string | null {
  // bun isolated installs：omo-ai 5.1.0 内嵌 @code-yeongyu/senpi 2026.9.28-7，位于根 .bun 目录
  const base = "/data/projects/ul-omo-webui/node_modules/.bun"
  if (!existsSync(base)) return null
  for (const dir of readdirSync(base)) {
    if (!dir.startsWith("@code-yeongyu+senpi@2026.9.28-7")) continue
    const p = join(base, dir, "node_modules", "@code-yeongyu", "senpi", "dist", "bundle", "cli.js")
    if (existsSync(p)) return p
  }
  return null
}

const senpiCli = embeddedSenpiCli()
const CANDIDATES: Array<{ name: string; cliPath: string }> = [
  {
    name: "omo-ai 包 bin `omo`（launcher 注入 omo 扩展与品牌 env）",
    cliPath: "/data/projects/ul-omo-webui/server/node_modules/omo-ai/bin/omo.js",
  },
]
if (senpiCli) {
  CANDIDATES.push({ name: "omo-ai 内嵌 senpi bin（senpi --mode rpc，无 omo 扩展）", cliPath: senpiCli })
}

// omo 扩展注册的命令（plugin/extensions/omo.js 实读），getCommands 命中任一即扩展存活
const OMO_COMMANDS = ["computer", "doctor", "dream", "facts", "memfs", "palace", "people", "search", "sleeptime", "memory"]

// ---- 通用工具 ----

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

function jsonBrief(value: unknown, max = 600): string {
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

function prepareProject(): void {
  mkdirSync(PROJ_DIR, { recursive: true })
  const readme = join(PROJ_DIR, "README.md")
  if (!existsSync(readme)) writeFileSync(readme, "# P0-1 RPC 测试项目\n\nul-omo-webui spike 隔离测试目录。\n")
}

interface EngineProc {
  pid: number
  cmd: string
}

/** 探测本脚本 spawn 的引擎 RPC 子进程：cmdline 含 rpc 特征且 /proc cwd 等于本测试项目目录。
 *  cwd 过滤是硬约束：并行 P0 任务各有自己的 /tmp/opencode/p0-x-proj，绝不波及。 */
function listEngineProcesses(): EngineProc[] {
  const r = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8", timeout: 5000 })
  if (r.status !== 0 || !r.stdout) return []
  return r.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2] }))
    .filter((p) => {
      if (p.pid === SELF_PID) return false
      if (!/--mode rpc|--multi-session/.test(p.cmd)) return false
      const cwd = readlinkSync(`/proc/${p.pid}/cwd`)
      return cwd === PROJ_DIR
    })
}

function killByPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // 已退出
  }
}

/** stop() 失败时的兜底清扫：杀全部遗留引擎 RPC 进程 */
function sweepEngineProcesses(reason: string): void {
  const left = listEngineProcesses()
  if (left.length === 0) return
  console.log(`[清扫:${reason}] 发现 ${left.length} 个遗留引擎进程，按 PID 强杀`)
  for (const p of left) killByPid(p.pid)
}

// ---- 事件收集 ----

type RawEvent = Record<string, unknown> & { _recvAt?: number }

class EventLog {
  readonly all: RawEvent[] = []
  readonly samples = new Map<string, RawEvent>()

  add(event: unknown): void {
    const e = { ...(event as Record<string, unknown>), _recvAt: Date.now() } as RawEvent
    this.all.push(e)
    const type = String(e.type ?? "?")
    if (!this.samples.has(type)) this.samples.set(type, e)
  }

  countOfType(type: string, sessionId?: string): number {
    return this.all.filter((e) => e.type === type && (sessionId === undefined || e.sessionId === sessionId)).length
  }

  async waitForType(type: string, timeoutMs: number, sessionId?: string): Promise<void> {
    const has = () => this.all.some((e) => e.type === type && (sessionId === undefined || e.sessionId === sessionId))
    const deadline = Date.now() + timeoutMs
    while (!has()) {
      if (Date.now() > deadline) throw new Error(`等待事件 ${type}${sessionId ? `(session=${sessionId})` : ""} 超时 ${timeoutMs}ms`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  typeList(): string[] {
    return [...this.samples.keys()]
  }
}

// ---- 候选启动 ----

async function tryStart(
  cliPath: string,
  extraArgs: string[],
): Promise<{ client: RpcClient; stderrTail: string } | { error: string }> {
  if (!existsSync(cliPath)) return { error: `cli 不存在: ${cliPath}` }
  const client = new RpcClient({
    cliPath,
    args: extraArgs,
    cwd: PROJ_DIR,
    env: { OMO_CODING_AGENT_DIR: AGENT_DIR },
    provider: PROVIDER,
    model: MODEL,
  })
  try {
    await withTimeout(client.start(), 30000, `start(${cliPath.split("/").slice(-2).join("/")})`)
    await withTimeout(client.setClientInfo(80, ["extension_events"]), 15000, "set_client_info")
    return { client, stderrTail: client.getStderr().slice(-1200) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const errText = `${msg}\n  stderr 尾部: ${client.getStderr().slice(-800).replace(/\n/g, " | ")}`
    try {
      await withTimeout(client.stop(), 5000, "stop(失败候选清理)")
    } catch {
      sweepEngineProcesses("候选失败")
    }
    return { error: errText }
  }
}

// ---- 主流程 ----

async function main(): Promise<void> {
  console.log("=== P0-1 RPC 基本链路验证（W1 go/no-go 门） ===")
  console.log(
    "版本: omo-ai=5.1.0, @code-yeongyu/senpi(宿主 RpcClient)=2026.10.10, omo-ai 内嵌 senpi 引擎=2026.9.28-7",
  )
  console.log(`bun=${process.versions.bun ?? "n/a"} HOME=${process.env.HOME} agentDir=${AGENT_DIR}`)
  console.log(`模型: ${PROVIDER}/${MODEL} thinking=${THINKING} cwd=${PROJ_DIR}`)
  prepareProject()

  // ---- 1) 候选入口按序试 ----
  let chosenName = ""
  let chosenCli = ""
  let client: RpcClient | null = null
  for (const cand of CANDIDATES) {
    section(`候选入口尝试: ${cand.name}`)
    console.log(`cliPath: ${cand.cliPath}`)
    const r = await tryStart(cand.cliPath, [])
    if ("client" in r) {
      console.log("start + set_client_info: 成功")
      if (r.stderrTail) console.log(`stderr 尾部摘录: ${r.stderrTail.split("\n").slice(-5).join(" | ")}`)
      client = r.client
      chosenName = cand.name
      chosenCli = cand.cliPath
      break
    }
    console.log(`失败:\n  ${r.error}`)
  }
  if (!client) {
    console.log("\nP0-1 FAILED: 全部候选入口都无法完成 spawn + set_client_info")
    sweepEngineProcesses("全部候选失败")
    process.exit(2)
  }
  console.log(`\n>>> 采用候选: ${chosenName}`)

  // omo 扩展存活初判：getCommands 命中 omo 注册命令（专项验证在 P0-3）
  section("omo 扩展存活初判（getCommands）")
  try {
    const cmds = await withTimeout(client.getCommands(), 15000, "get_commands")
    const names = cmds.map((c) => String((c as { name?: string }).name ?? "")).filter(Boolean)
    const hits = OMO_COMMANDS.filter((o) => names.includes(o))
    console.log(
      hits.length > 0
        ? `omo 扩展存活（getCommands 命中: ${hits.join(",")}；共 ${names.length} 条命令）`
        : `未命中 omo 命令（共 ${names.length} 条: ${names.slice(0, 30).join(",")}）`,
    )
  } catch (e) {
    console.log(`getCommands 失败: ${e instanceof Error ? e.message : e}`)
  }

  // ---- 2) 主链路（classic 单会话：会话由 spawn CLI 参数建立，open_session 在 classic 被拒） ----
  section("经典模式会话基线（get_state）")
  let classicSessionFile = ""
  try {
    const st = await withTimeout(client.getState(), 15000, "get_state(classic)")
    classicSessionFile = st.sessionFile ?? ""
    console.log(
      `state 摘录: ${jsonBrief({
        sessionId: st.sessionId,
        model: st.model ? { provider: st.model.provider, id: st.model.id } : null,
        thinkingLevel: st.thinkingLevel,
        isStreaming: st.isStreaming,
        cwd: st.cwd,
        sessionFile: st.sessionFile,
        sessionName: st.sessionName,
      })}`,
    )
  } catch (e) {
    console.log(`get_state 失败: ${e instanceof Error ? e.message : e}`)
  }

  const events = new EventLog()
  const offEvent = client.onEvent((e) => events.add(e))

  section("prompt #1（回复：OK）")
  const t0 = Date.now()
  const disp1 = await client.prompt("回复：OK", { thinkingLevel: THINKING })
  console.log(`prompt disposition=${String(disp1)} (${Date.now() - t0}ms 内被接受)`)
  await withTimeout(events.waitForType("agent_settled", 120000), 125000, "agent_settled(#1)")
  await new Promise((r) => setTimeout(r, 500))
  console.log(
    `事件总数=${events.all.length}；agent_end=${events.countOfType("agent_end")}；message_update=${events.countOfType("message_update")}；tool_execution_end=${events.countOfType("tool_execution_end")}`,
  )
  const lastText = await client.getLastAssistantText()
  console.log(`getLastAssistantText: ${JSON.stringify(lastText)}`)

  section("消息分页读取（getEntries / since 游标）")
  const page1 = await withTimeout(client.getEntries(), 15000, "get_entries(全量)")
  console.log(`全量 entries=${page1.entries.length}，leafId=${page1.leafId ?? "null"}`)
  const typeHistogram: Record<string, number> = {}
  for (const e of page1.entries) typeHistogram[e.type] = (typeHistogram[e.type] ?? 0) + 1
  console.log(`entry 类型分布: ${JSON.stringify(typeHistogram)}`)
  const firstMsg = page1.entries.find((e) => e.type === "message")
  console.log(`首条 message entry 摘录: ${jsonBrief(firstMsg, 450)}`)
  const lastId = page1.leafId ?? page1.entries[page1.entries.length - 1]?.id
  if (lastId) {
    const page2 = await withTimeout(client.getEntries(lastId), 15000, "get_entries(since)")
    console.log(`getEntries(since=leafId) 增量: ${page2.entries.length} 条（0=游标语义成立）`)
  }

  section("abort 实测（运行中打断）")
  const events2 = new EventLog()
  const off2 = client.onEvent((e) => events2.add(e))
  await client.prompt("用大约 120 字介绍一下你自己", { thinkingLevel: THINKING })
  await withTimeout(events2.waitForType("message_update", 30000), 35000, "首个 message_update(abort 段)")
  const beforeAbort = events2.countOfType("message_update")
  await withTimeout(client.abort(), 15000, "abort")
  await withTimeout(events2.waitForType("agent_end", 30000), 35000, "agent_end(abort 后)")
  await new Promise((r) => setTimeout(r, 500))
  const stateAfter = await client.getState()
  console.log(
    `abort 前 message_update=${beforeAbort}；abort 后 agent_end=${events2.countOfType("agent_end")}；isStreaming=${stateAfter.isStreaming}`,
  )
  const agentEnd = events2.all.find((e) => e.type === "agent_end")
  console.log(`agent_end 样本: ${jsonBrief(agentEnd, 400)}`)
  off2()

  section("listSessions（classic 下试探；行字段形态主要看 multi-session 段）")
  try {
    const rows = await withTimeout(client.listSessions(), 15000, "list_sessions(classic)")
    console.log(`classic list_sessions 行数=${rows.length}`)
    for (const r of rows) console.log(`  ${jsonBrief(r, 400)}`)
  } catch (e) {
    console.log(`classic list_sessions 被拒/失败: ${e instanceof Error ? e.message : e}`)
  }

  section("附带实测 a-1: 经典模式 open_session（预期 multi_session_disabled）")
  try {
    await withTimeout(
      client.openSession({ provider: PROVIDER, modelId: MODEL, thinkingLevel: THINKING }),
      15000,
      "open_session(classic)",
    )
    console.log("经典模式 open_session 竟然成功（如实记录）")
  } catch (e) {
    console.log(`经典模式 open_session 被拒: ${e instanceof Error ? e.message : e}`)
  }
  try {
    await withTimeout(client.stop(), 10000, "stop(主 client)")
  } catch {
    sweepEngineProcesses("主 client stop")
  }
  offEvent()

  // ---- 3) 附带实测 a-2: --multi-session 同一子进程双会话并发 ----
  section("附带实测 a-2: --multi-session 同一子进程双会话并发")
  const msClient = new RpcClient({
    cliPath: chosenCli,
    args: ["--multi-session"],
    cwd: PROJ_DIR,
    env: { OMO_CODING_AGENT_DIR: AGENT_DIR },
    provider: PROVIDER,
    model: MODEL,
  })
  const msEvents = new EventLog()
  msClient.onEvent((e) => msEvents.add(e))
  try {
    await withTimeout(msClient.start(), 30000, "start(--multi-session)")
    await withTimeout(msClient.setClientInfo(80, ["extension_events"]), 15000, "set_client_info(ms)")
    const openA = await withTimeout(
      msClient.openSession({ provider: PROVIDER, modelId: MODEL, thinkingLevel: THINKING }),
      30000,
      "open_session(A)",
    )
    console.log(
      `会话 A durable=${openA.sessionId} attached=${openA.attached ?? "-"} sessionFile=${openA.state.sessionFile ?? "(无)"}`,
    )
    try {
      const levels = await withTimeout(msClient.getAvailableThinkingLevels(), 15000, "get_available_thinking_levels")
      console.log(`当前模型可用 thinking 档: ${JSON.stringify(levels)}`)
    } catch (e) {
      console.log(`getAvailableThinkingLevels 失败: ${e instanceof Error ? e.message : e}`)
    }

    // 第一步：multi host 上单会话先走通一次 settled（隔离"单会话就不通"与"并发才不通"）
    const dispA0 = await msClient.prompt("回复：A-READY", { thinkingLevel: THINKING })
    console.log(`A 单会话热身 prompt disposition=${String(dispA0)}`)
    await withTimeout(msEvents.waitForType("agent_settled", 120000, openA.sessionId), 125000, "agent_settled(A 热身)")
    console.log("A 热身 settled：multi host 单会话闭环成立")

    // 第二步：并发——A 长任务运行中开 B 并 prompt
    const dispA = await msClient.prompt("请从 1 数到 30，每个数字单独一行，不要任何解释", { thinkingLevel: THINKING })
    console.log(`A 并发段 prompt disposition=${String(dispA)}；1.5s 后并发开会话 B`)
    await new Promise((r) => setTimeout(r, 1500))
    const aUpdatesAtB = msEvents.countOfType("message_update", openA.sessionId)
    const tB = Date.now()
    const openB = await withTimeout(
      msClient.openSession({ provider: PROVIDER, modelId: MODEL, thinkingLevel: THINKING }),
      30000,
      "open_session(B)",
    )
    console.log(
      `会话 B durable=${openB.sessionId} attached=${openB.attached ?? "-"} sessionFile=${openB.state.sessionFile ?? "(无)"}（open 耗时 ${Date.now() - tB}ms）`,
    )
    const dispB = await msClient.prompt("回复：B-OK", { thinkingLevel: THINKING })
    console.log(`B prompt disposition=${String(dispB)}`)
    await withTimeout(msEvents.waitForType("agent_settled", 120000, openB.sessionId), 125000, "agent_settled(B)")
    await withTimeout(msEvents.waitForType("agent_settled", 120000, openA.sessionId), 125000, "agent_settled(A 并发段)")
    await new Promise((r) => setTimeout(r, 500))
    const aUpdatesTotal = msEvents.countOfType("message_update", openA.sessionId)
    console.log(
      `A message_update: B 打开前=${aUpdatesAtB}，总计=${aUpdatesTotal}（B 打开后继续增长=并发推进证据）；B message_update=${msEvents.countOfType("message_update", openB.sessionId)}`,
    )
    const bText = msEvents.all
      .filter((e) => e.sessionId === openB.sessionId && e.type === "message_end")
      .map((e) => JSON.stringify(e))
      .at(-1)
    console.log(`B 最后 message_end: ${bText ? bText.slice(0, 300) : "(无)"}`)
    const rowsMs = await withTimeout(msClient.listSessions(), 15000, "list_sessions(ms)")
    console.log(`multi-session host list_sessions 行数=${rowsMs.length}:`)
    for (const r of rowsMs) console.log(`  ${jsonBrief(r, 400)}`)
    // 并发时间重叠：A 与 B 的事件到达区间
    const span = (sid: string) => {
      const ts = msEvents.all.filter((e) => e.sessionId === sid).map((e) => e._recvAt ?? 0).filter((t) => t > 0)
      return ts.length ? `${new Date(Math.min(...ts)).toISOString().slice(11, 19)}~${new Date(Math.max(...ts)).toISOString().slice(11, 19)}` : "(无)"
    }
    console.log(`事件到达区间 A=[${span(openA.sessionId)}] B=[${span(openB.sessionId)}]（重叠=并发）`)
    await withTimeout(msClient.closeSession(openA.sessionId), 20000, "close_session(A)")
    await withTimeout(msClient.closeSession(openB.sessionId), 20000, "close_session(B)")
  } catch (e) {
    console.log(`multi-session 实测失败: ${e instanceof Error ? e.message : e}`)
  } finally {
    try {
      await withTimeout(msClient.stop(), 8000, "stop(ms)")
    } catch {
      sweepEngineProcesses("ms stop")
    }
  }

  // ---- 4) 附带实测 b：磁盘会话行字段形态（血缘/agent） ----
  section("附带实测 b: 磁盘 session store 会话行字段形态")
  const sessionRoot = join(AGENT_DIR, "sessions")
  if (existsSync(sessionRoot)) {
    const dirs = readdirSync(sessionRoot).filter((d) => d.includes("p0-1-proj"))
    console.log(`session root=${sessionRoot}；匹配本测试 cwd 的目录: ${JSON.stringify(dirs)}`)
    for (const dir of dirs.slice(0, 2)) {
      const full = join(sessionRoot, dir)
      const files = readdirSync(full).filter((f) => f.endsWith(".jsonl"))
      console.log(`目录 ${dir}: ${files.length} 个会话文件（展示最新 3 个的 header 与 agent 字段探测）`)
      for (const f of files.slice(-3)) {
        const lines = readFileSync(join(full, f), "utf8").split("\n").filter((l) => l.trim())
        if (lines.length === 0) continue
        const header = JSON.parse(lines[0]) as Record<string, unknown>
        console.log(`  ${f}: header=${jsonBrief(header, 400)}`)
        const probe = lines.slice(0, 20).join("\n")
        const agentHits = probe.match(/"(agent|agentName|agent_name|persona|parentSession|parentSessionPath|parent)"\s*:\s*("[^"]*"|null)/g)
        console.log(`    前 20 行血缘/agent 类字段: ${agentHits ? agentHits.slice(0, 6).join(" | ") : "（无）"}`)
      }
    }
  } else {
    console.log(`session root 不存在: ${sessionRoot}`)
  }

  // ---- 5) 事件类型清单 ----
  section("事件类型清单（主链路 + abort + 多会话合并）")
  const merged = new Map<string, { count: number; sample: RawEvent }>()
  for (const [t, s] of events.samples) merged.set(t, { count: events.countOfType(t), sample: s })
  for (const [t, s] of msEvents.samples) {
    const prev = merged.get(t)
    merged.set(t, { count: (prev?.count ?? 0) + msEvents.countOfType(t), sample: prev?.sample ?? s })
  }
  console.log(`去重后 ${merged.size} 类:`)
  for (const [t, { count, sample }] of [...merged.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${t} (x${count}): ${jsonBrief(sample, 280)}`)
  }

  // ---- 6) 收尾 ----
  section("进程清理确认")
  await new Promise((r) => setTimeout(r, 1000))
  const left = listEngineProcesses()
  if (left.length === 0) {
    console.log("无遗留引擎进程")
  } else {
    for (const p of left) {
      console.log(`清扫遗留 ${p.pid}: ${p.cmd.slice(0, 140)}`)
      killByPid(p.pid)
    }
    await new Promise((r) => setTimeout(r, 800))
    console.log(`清扫后剩余: ${listEngineProcesses().length}`)
  }
  console.log("\n=== P0-1 全链路完成（结论见 docs/verification/01-rpc-basic.md） ===")
}

main()
  .catch((e) => {
    console.error(`\nP0-1 FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    sweepEngineProcesses("主流程异常")
    process.exitCode = 2
  })
