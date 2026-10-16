/**
 * W18 B9 spike：技能与用户提示枚举通道实证（docs08-r3 计划任务 18）。
 *
 * 三组通道逐一实跑（结论供任务 19 斜杠提示下拉直接引用）：
 *   (a) 引擎命令：RPC get_commands 的适配层可调用形态（open_session 前后差异）；
 *   (b) 技能枚举：senpi RPC 面（get_commands / get_loaded_surfaces 原始发送）、
 *       agent 目录定义文件实测（含 pi 包目录）、omo 扩展状态；
 *   (c) 用户提示（prompt 模板）：agent 目录 prompts / 项目级约定目录 / pi 包目录实测，
 *       及调用契约实证——prompt("/name ...") 直发后引擎侧展开还是原样入会话。
 *
 * 只读保证：AGENT_DIR 只读复用；会话写盘用 PI_CODING_AGENT_SESSION_DIR 隔离到
 * /tmp/opencode/w18-sessions，脚本收尾核验 agent 目录 sessions 无本项目残留。
 * 项目级约定目录样例建在 /tmp/opencode/w18-proj（.pi/prompts + .agents/skills）。
 *
 * 运行：bun run server/spike/w18-b9-channels.ts
 * 引擎：生产同源 resolveEngineCliPath 形态（omo-ai@5.1.0 内嵌 senpi 2026.9.28-7）
 *       + --extension omo 插件目录 + --multi-session（senpi-adapter.ts:267-284 先例）。
 * 模型：zai-coding-cn/glm-5.3-flash，thinking off（契约实证两条 prompt，成本最低档）。
 */

import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { RpcClient } from "@code-yeongyu/senpi"

// ---- 常量 ----

const REPO = "/data/projects/ul-omo-webui"
// agent 目录解析：尊重隔离测试覆盖（UL_OMO_WEBUI_AGENT_DIR 为 server 侧语义，
// OMO_CODING_AGENT_DIR 为引擎 launcher 语义），缺省 ~/.pi/agent
const AGENT_DIR =
  process.env.UL_OMO_WEBUI_AGENT_DIR ??
  process.env.OMO_CODING_AGENT_DIR ??
  join(homedir(), ".pi", "agent")
const SESSION_DIR = "/tmp/opencode/w18-sessions" // PI_CODING_AGENT_SESSION_DIR（引擎会话写盘隔离）
const PROJ_DIR = "/tmp/opencode/w18-proj"
const PROVIDER = "zai-coding-cn"
const MODEL = "glm-5.3-flash"
const THINKING = "off" as const
const SELF_PID = process.pid
const ENGINE_ARGS = ["--extension", join(REPO, "server/node_modules/omo-ai/plugin"), "--multi-session"]

// 生产同源引擎 cli（resolveEngineCliPath 源码态候选 1，senpi-adapter.ts:111-135）
function engineCliPath(): string {
  const p = join(REPO, "node_modules/.bun/omo-ai@5.1.0/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js")
  if (!existsSync(p)) throw new Error(`生产引擎 cli 不存在: ${p}`)
  return p
}

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

/** 原始 RPC 发送（RpcClient 内部方法，adapter 就绪轮询同款用法 senpi-adapter.ts:305） */
type RawSend = (m: unknown) => Promise<{ success: boolean; data?: unknown; error?: string; errorData?: unknown }>

function listEngineProcesses(): Array<{ pid: number; cmd: string }> {
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
      try {
        return readlinkSync(`/proc/${p.pid}/cwd`) === PROJ_DIR
      } catch {
        return false
      }
    })
}

function killByPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // 已退出
  }
}

function sweepEngineProcesses(reason: string): void {
  const left = listEngineProcesses()
  if (left.length === 0) return
  console.log(`[清扫:${reason}] 发现 ${left.length} 个遗留引擎进程，按 PID 强杀`)
  for (const p of left) killByPid(p.pid)
}

// ---- 静态面：agent 目录定义文件实测（只读） ----

interface DirFinding {
  label: string
  path: string
  exists: boolean
  entries: string[]
}

function probeDir(label: string, path: string, mdOnly = false): DirFinding {
  if (!existsSync(path)) return { label, path, exists: false, entries: [] }
  let entries = readdirSync(path)
  if (mdOnly) entries = entries.filter((e) => e.endsWith(".md"))
  return { label, path, exists: true, entries: entries.sort() }
}

function staticFace(): void {
  section("静态面：agent 目录与约定位置实测（只读）")
  const probes = [
    probeDir("agent 全局 skills 目录", join(AGENT_DIR, "skills")),
    probeDir("agent 全局 prompts 目录", join(AGENT_DIR, "prompts")),
    probeDir("用户级 ~/.agents/skills", join(homedir(), ".agents", "skills")),
    probeDir("项目级 .pi/skills", join(PROJ_DIR, ".pi", "skills")),
    probeDir("项目级 .pi/prompts", join(PROJ_DIR, ".pi", "prompts")),
    probeDir("项目级 .agents/skills", join(PROJ_DIR, ".agents", "skills")),
    // pi 包安装目录（settings.json packages 机制的实际落点）
    probeDir("pi 包 oh-my-pi skills 目录", join(AGENT_DIR, "npm/node_modules/oh-my-pi/skills"), true),
    probeDir("pi 包 oh-my-pi prompts 目录", join(AGENT_DIR, "npm/node_modules/oh-my-pi/prompts"), true),
  ]
  for (const p of probes) {
    console.log(`[${p.exists ? "有" : "无"}] ${p.label}: ${p.path}`)
    if (p.exists) console.log(`     ${p.entries.length} 项: ${p.entries.join(", ") || "(空)"}`)
  }
  // settings.json 的 packages 声明（技能/提示经包机制进入引擎的注册源）
  const settingsPath = join(AGENT_DIR, "settings.json")
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: string[] }
      console.log(`settings.json packages 声明: ${JSON.stringify(s.packages ?? [])}`)
    } catch {
      console.log(`settings.json 解析失败（不中断）`)
    }
  }
  // 项目信任态（决定项目级约定目录在 RPC 模式是否被加载）
  const trustPath = join(AGENT_DIR, "trust.json")
  console.log(`trust.json 存在: ${existsSync(trustPath) ? "是" : "否（无任何项目信任决策）"}`)
}

/** 构造隔离测试项目：项目级约定目录样例（只在 /tmp，绝不触碰 agent 目录） */
function prepareProject(): { promptFile: string; skillDir: string } {
  mkdirSync(join(PROJ_DIR, ".pi", "prompts"), { recursive: true })
  mkdirSync(join(PROJ_DIR, ".agents", "skills", "w18-mini"), { recursive: true })
  const promptFile = join(PROJ_DIR, ".pi", "prompts", "w18-spike.md")
  writeFileSync(
    promptFile,
    `---\ndescription: W18 spike 契约验证模板\nargument-hint: "<任意参数>"\n---\nW18-模板展开验证。请只回复一行：模板正文已展开（参数=$1）。\n`,
  )
  const skillDir = join(PROJ_DIR, ".agents", "skills", "w18-mini")
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: w18-mini\ndescription: W18 spike 契约验证技能（回复固定标记）\n---\n收到本技能后，只回复一行：W18-SKILL-OK\n`,
  )
  const readme = join(PROJ_DIR, "README.md")
  if (!existsSync(readme)) writeFileSync(readme, "# W18 B9 spike 隔离测试项目\n")
  return { promptFile, skillDir }
}

// ---- 会话 JSONL 读取（契约判定证据） ----

function readUserTexts(sessionFile: string): string[] {
  if (!existsSync(sessionFile)) return []
  return readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null)
    .filter((e) => e.type === "message" && (e.message as { role?: string } | undefined)?.role === "user")
    .map((e) => {
      const msg = e.message as { content?: unknown }
      const c = msg.content
      if (typeof c === "string") return c
      if (Array.isArray(c)) {
        return c
          .map((p) => (p as { type?: string; text?: string }).type === "text" ? (p as { text?: string }).text ?? "" : "")
          .join("\n")
      }
      return ""
    })
}

async function waitSessionFile(sessionFile: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(sessionFile) && readFileSync(sessionFile, "utf8").trim().length > 0) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return existsSync(sessionFile)
}

// ---- 单引擎运行（两阶段共用） ----

interface EngineRun {
  client: RpcClient
  rawSend: RawSend
}

async function startEngine(label: string, extraArgs: string[]): Promise<EngineRun> {
  const client = new RpcClient({
    cliPath: engineCliPath(),
    args: [...ENGINE_ARGS, ...extraArgs],
    cwd: PROJ_DIR,
    env: {
      OMO_CODING_AGENT_DIR: AGENT_DIR,
      SENPI_CODING_AGENT_DIR: AGENT_DIR,
      PI_CODING_AGENT_SESSION_DIR: SESSION_DIR,
      OMO_NATIVE: "1",
    },
    provider: PROVIDER,
    model: MODEL,
  })
  await withTimeout(client.start(), 60000, `${label} start`)
  await withTimeout(client.setClientInfo(80, ["extension_events"]), 15000, `${label} set_client_info`)
  const rawSend = (client as unknown as { send: (m: unknown) => Promise<{ success: boolean }> }).send.bind(client) as RawSend
  return { client, rawSend }
}

async function stopEngine(run: EngineRun, label: string): Promise<void> {
  try {
    await withTimeout(run.client.stop(), 10000, `${label} stop`)
  } catch {
    sweepEngineProcesses(label)
  }
}

interface CommandRow {
  name: string
  description?: string
  source?: string
  syntax?: string
  sourceInfo?: { path?: string; scope?: string }
}

function summarizeCommands(cmds: CommandRow[], label: string): void {
  const bySource = new Map<string, CommandRow[]>()
  for (const c of cmds) {
    const k = String(c.source ?? "(无source字段)")
    if (!bySource.has(k)) bySource.set(k, [])
    bySource.get(k)!.push(c)
  }
  console.log(`[${label}] 总数=${cmds.length}；按 source 分布: ${JSON.stringify(Object.fromEntries([...bySource.entries()].map(([k, v]) => [k, v.length])))}`)
  for (const k of ["extension", "prompt", "skill"]) {
    const rows = bySource.get(k)
    if (!rows) continue
    const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name))
    console.log(`  source=${k}（${rows.length} 条）全量名单:`)
    console.log(`    ${sorted.map((r) => r.name).join(", ")}`)
    console.log(`  source=${k} 样例前 3（含完整字段面）:`)
    for (const r of sorted.slice(0, 3)) {
      console.log(`    ${jsonBrief(r, 420)}`)
    }
  }
  if (bySource.has("(无source字段)")) {
    console.log(`  无 source 字段样例前 5（老引擎字段面差异证据）:`)
    for (const r of bySource.get("(无source字段)")!.slice(0, 5)) console.log(`    ${jsonBrief(r, 300)}`)
  }
}

// ---- 主流程 ----

async function main(): Promise<void> {
  console.log("=== W18 B9 spike：技能与用户提示枚举通道实证 ===")
  console.log(
    `AGENT_DIR=${AGENT_DIR}（只读） SESSION_DIR=${SESSION_DIR}（会话写盘隔离） PROJ_DIR=${PROJ_DIR}`,
  )
  console.log(`引擎 cli=${engineCliPath()}`)
  const t0 = Date.now()
  staticFace()
  prepareProject()
  mkdirSync(SESSION_DIR, { recursive: true })
  console.log(`静态面耗时 ${Date.now() - t0}ms`)

  // ---- 阶段 A：生产形态枚举通道（无额外 flag，项目信任缺省） ----
  section("阶段 A：生产形态 RPC 枚举通道（--multi-session，无信任放行）")
  const runA = await startEngine("A", [])
  try {
    // 引擎版本（对照 05 笔记的官配引擎）
    try {
      const info = await withTimeout(runA.rawSend({ type: "get_protocol_info" }), 15000, "get_protocol_info")
      const d = (info.data ?? {}) as { engineVersion?: string; protocolVersion?: unknown }
      console.log(`get_protocol_info: success=${info.success} engineVersion=${String(d.engineVersion ?? "?")}`)
    } catch (e) {
      console.log(`get_protocol_info 失败: ${e instanceof Error ? e.message : e}`)
    }

    // (a)-1 open_session 前调 getCommands（05 笔记称 multi-session 下报 missing_session_id——复核）
    try {
      await withTimeout(runA.client.getCommands(), 15000, "get_commands(open 前)")
      console.log("get_commands(open 前): 竟然成功（如实记录，05 结论失效）")
    } catch (e) {
      console.log(`get_commands(open 前): 被拒——${e instanceof Error ? e.message : e}`)
    }

    // open_session 后取命令面
    const open = await withTimeout(
      runA.client.openSession({ provider: PROVIDER, modelId: MODEL, thinkingLevel: THINKING }),
      60000,
      "open_session(A)",
    )
    const sessionFileA = open.state.sessionFile ?? ""
    console.log(`open_session: durable=${open.sessionId} sessionFile=${sessionFileA || "(无)"}`)

    const tGet = Date.now()
    const cmdsA = (await withTimeout(runA.client.getCommands(), 15000, "get_commands(A)")) as CommandRow[]
    console.log(`get_commands 调用耗时 ${Date.now() - tGet}ms`)
    summarizeCommands(cmdsA, "A")

    // (b) senpi RPC 面 capabilities/list 类：get_loaded_surfaces 原始发送
    try {
      const surfaces = await withTimeout(runA.rawSend({ type: "get_loaded_surfaces" }), 15000, "get_loaded_surfaces")
      const d = (surfaces.data ?? {}) as Record<string, unknown>
      console.log(
        `get_loaded_surfaces: success=${surfaces.success} keys=${JSON.stringify(Object.keys(d))} 摘录=${jsonBrief(d, 400)}`,
      )
      console.log(
        `  → surfaces 是否含 skills 键: ${"skills" in d ? "是（通道存在）" : "否（技能不在此通道，与 rpc.md 文档一致与否以此为准）"}`,
      )
    } catch (e) {
      console.log(`get_loaded_surfaces 失败（老引擎无此命令的证据）: ${e instanceof Error ? e.message : e}`)
    }

    // (c)-1 项目级约定目录：无信任放行时是否被发现（trust 门控实证）
    const hasW18 = cmdsA.some((c) => c.name.startsWith("w18"))
    console.log(
      hasW18
        ? "项目级 w18-* 命令在无信任放行下出现（trust 门控结论需修正）"
        : "项目级 w18-* 命令未出现：RPC 模式下项目级约定目录（.pi/prompts、.agents/skills）默认被忽略（trust 门控，defaultProjectTrust 缺省 ask）",
    )

    await withTimeout(runA.client.closeSession(open.sessionId), 20000, "close_session(A)")
  } finally {
    await stopEngine(runA, "A")
  }

  // ---- 阶段 B：调用契约实证（显式 --prompt-template/--skill 装载，绕过信任门控） ----
  section("阶段 B：技能与用户提示调用契约（prompt 直发后引擎侧行为）")
  const promptFile = join(PROJ_DIR, ".pi", "prompts", "w18-spike.md")
  const skillDir = join(PROJ_DIR, ".agents", "skills", "w18-mini")
  const runB = await startEngine("B", ["--prompt-template", promptFile, "--skill", skillDir])
  let sessionFileB = ""
  try {
    const open = await withTimeout(
      runB.client.openSession({ provider: PROVIDER, modelId: MODEL, thinkingLevel: THINKING }),
      60000,
      "open_session(B)",
    )
    sessionFileB = open.state.sessionFile ?? ""
    const cmdsB = (await withTimeout(runB.client.getCommands(), 15000, "get_commands(B)")) as CommandRow[]
    summarizeCommands(cmdsB, "B")
    const w18rows = cmdsB.filter((c) => c.name.includes("w18"))
    console.log(`显式装载的 w18 命令行: ${jsonBrief(w18rows.map((r) => ({ name: r.name, source: r.source, syntax: r.syntax })), 400)}`)

    // 契约 1：prompt 模板直发——观察用户消息落盘形态（展开 vs 原样）
    const events1: unknown[] = []
    const off1 = runB.client.onEvent((e) => events1.push(e))
    await runB.client.prompt("/w18-spike W18参数X", { thinkingLevel: THINKING })
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 120000
        const poll = setInterval(() => {
          if (events1.some((e) => (e as { type?: string }).type === "agent_settled")) {
            clearInterval(poll)
            resolve()
          } else if (Date.now() > deadline) {
            clearInterval(poll)
            reject(new Error("等待 agent_settled(模板回合) 超时"))
          }
        }, 200)
      }),
      125000,
      "agent_settled(模板回合)",
    )
    off1()
    await waitSessionFile(sessionFileB, 5000)
    await new Promise((r) => setTimeout(r, 800))
    const userTexts = readUserTexts(sessionFileB)
    const templateTurn = userTexts.find((t) => t.includes("W18"))
    console.log(`模板直发后用户消息落盘（判据：展开文本 vs 原样 /w18-spike）:`)
    console.log(`  ${jsonBrief(templateTurn ?? "(未找到含 W18 的用户消息)", 500)}`)
    const expanded = templateTurn !== undefined && !templateTurn.trimStart().startsWith("/")
    console.log(
      expanded
        ? "  → 判定：引擎侧展开（命令直发契约成立，客户端无需插入展开文本）"
        : "  → 判定：原样入会话（客户端需自行展开——若如此记录）",
    )
    const lastText = await withTimeout(runB.client.getLastAssistantText(), 15000, "get_last_assistant_text(模板)")
    console.log(`  模板回合 assistant 回复: ${JSON.stringify(lastText).slice(0, 300)}`)

    // 契约 2：技能直发（/skill:name 兼容形态）。events2 自订阅起算，本回合恰 1 个 agent_settled
    const events2: unknown[] = []
    const off2 = runB.client.onEvent((e) => events2.push(e))
    await runB.client.prompt("/skill:w18-mini 请执行", { thinkingLevel: THINKING })
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 120000
        const poll = setInterval(() => {
          if (events2.some((e) => (e as { type?: string }).type === "agent_settled")) {
            clearInterval(poll)
            resolve()
          } else if (Date.now() > deadline) {
            clearInterval(poll)
            reject(new Error("等待 agent_settled(技能回合) 超时"))
          }
        }, 200)
      }),
      125000,
      "agent_settled(技能回合)",
    )
    off2()
    await new Promise((r) => setTimeout(r, 800))
    const userTexts2 = readUserTexts(sessionFileB)
    const skillTurn = userTexts2[userTexts2.length - 1] ?? ""
    console.log(`技能直发后第二条用户消息落盘:`)
    console.log(`  ${jsonBrief(skillTurn || "(空)", 500)}`)
    const skillLast = await withTimeout(runB.client.getLastAssistantText(), 15000, "get_last_assistant_text(技能)")
    console.log(`  技能回合 assistant 回复: ${JSON.stringify(skillLast).slice(0, 300)}`)
    console.log(
      JSON.stringify(skillLast ?? "").includes("W18-SKILL-OK")
        ? "  → 判定：/skill:name 直发生效（技能被加载执行，命令直发契约成立）"
        : "  → 判定：技能回合回复未含标记（需人工核对落盘形态）",
    )

    await withTimeout(runB.client.closeSession(open.sessionId), 20000, "close_session(B)")
  } finally {
    await stopEngine(runB, "B")
  }

  // ---- 只读保证核验 ----
  section("只读保证核验（会话写盘落点）")
  const projKey = "--tmp-opencode-w18-proj--"
  const realSessions = join(AGENT_DIR, "sessions")
  const leaked = existsSync(realSessions) && readdirSync(realSessions).some((d) => d === projKey)
  console.log(
    leaked
      ? `警告：${realSessions}/${projKey} 出现——PI_CODING_AGENT_SESSION_DIR 未被该引擎版本采纳，会话落回 agent 目录（引擎自写，非脚本写入；如实记录）`
      : `agent 目录 sessions 无 ${projKey} 残留：会话写盘成功隔离在 ${SESSION_DIR}`,
  )
  if (existsSync(SESSION_DIR)) {
    console.log(`${SESSION_DIR} 内容: ${readdirSync(SESSION_DIR).sort().join(", ") || "(空)"}`)
  }

  // 清扫确认
  section("进程清理确认")
  await new Promise((r) => setTimeout(r, 1000))
  const left = listEngineProcesses()
  for (const p of left) {
    console.log(`清扫遗留 ${p.pid}: ${p.cmd.slice(0, 140)}`)
    killByPid(p.pid)
  }
  await new Promise((r) => setTimeout(r, 800))
  console.log(`清扫后剩余: ${listEngineProcesses().length}`)

  // 隔离产物保留在 /tmp（可重复运行复用；不自动删，供人工核对证据）
  console.log(`\n隔离产物保留：${PROJ_DIR}、${SESSION_DIR}（可重复运行；如需彻底清理手动 rm）`)
  console.log("=== W18 spike 完成（结论见 docs/verification/06-b9-channels.md） ===")
}

main().catch((e) => {
  console.error(`\nW18 FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  sweepEngineProcesses("主流程异常")
  process.exitCode = 2
})
