/**
 * W4 todo 24 命令支持度实证 spike。
 *
 * 逐个探测 /compact /clear /new /undo（外加一个确定不存在的 /xyz-unknown 对照）：
 *   - getCommands 全量清单落盘 + 目标命令命中检查；
 *   - 先发一条真实短 prompt 物化会话（/undo 需要有消息可撤销）；
 *   - 每个 /命令 fire-and-forget prompt + 自动应答对话框兜底（P0-2：命令类 prompt
 *     响应可能拖到对话框落定），观察 45s 窗口内的事件与响应；
 *   - 每步前后 get_state 对比 sessionId（/new 可能切会话）+ 磁盘 jsonl 行数对比。
 *
 * 运行：bun run server/spike/w4-24-commands.ts
 * 模型：zai-coding-cn/glm-5.3-flash thinking low（token 预算规则）。
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { RpcClient } from "@code-yeongyu/senpi"

const AGENT_DIR = "/root/.pi/agent"
const PROVIDER = "zai-coding-cn"
const MODEL = "glm-5.3-flash"
const THINKING = "low"
const PROJ_DIR = "/tmp/opencode/w4-24-proj"
const REPO = "/data/projects/ul-omo-webui"
const SELF_PID = process.pid
const PROBES = ["/undo", "/clear", "/new", "/compact", "/xyz-unknown"] as const

function engineCli(): string {
  const base = join(REPO, "node_modules/.bun")
  if (existsSync(base)) {
    for (const dir of readdirSync(base)) {
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

// ---- 工具（沿用 W1/W2 spike 形态） ----

type AnyEvent = Record<string, unknown> & { _t?: number }

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

function brief(value: unknown, max = 500): string {
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

async function waitUntilReady(client: RpcClient): Promise<boolean> {
  const send = (client as unknown as { send: (m: unknown) => Promise<{ success: boolean; data?: unknown }> }).send.bind(client)
  for (let i = 1; i <= 20; i++) {
    try {
      const r = await send({ type: "get_protocol_info" })
      if (r.success) {
        console.log(`引擎就绪（第 ${i} 次探测）`)
        return true
      }
    } catch {
      /* 重试 */
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

class EventLog {
  readonly all: AnyEvent[] = []
  add(e: unknown): void {
    this.all.push({ ...(e as AnyEvent), _t: Date.now() })
  }
  mark(): number {
    return this.all.length
  }
  slice(fromIndex: number): AnyEvent[] {
    return this.all.slice(fromIndex)
  }
  async waitFor(type: string, timeoutMs: number, fromIndex: number, filter?: (e: AnyEvent) => boolean): Promise<AnyEvent> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.all.find((e, i) => i >= fromIndex && e.type === type && (!filter || filter(e)))
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`等待事件 ${type} 超时 ${timeoutMs}ms`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

/** 对话框自动应答兜底（select/confirm/input/editor 全部按默认放行，防命令弹窗阻塞） */
function autoRespondDialogs(client: RpcClient, label: string): void {
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

/** 当前会话 jsonl（按 state.sessionFile 或回退扫描项目会话目录取最新） */
function sessionLines(state: Record<string, unknown>): { file: string; rows: AnyEvent[] } {
  let file = String(state.sessionFile ?? "")
  if (!file || !existsSync(file)) {
    const dir = join(AGENT_DIR, "sessions", `--${PROJ_DIR.replace(/^\//, "").replaceAll("/", "-")}--`)
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      files.sort((a, b) => statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs)
      if (files.length > 0) file = join(dir, files[files.length - 1])
    }
  }
  if (!file || !existsSync(file)) return { file: "", rows: [] }
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AnyEvent)
  return { file, rows }
}

async function getState(client: RpcClient): Promise<Record<string, unknown>> {
  const st = (await withTimeout(client.getState(), 15000, "get_state")) as Record<string, unknown>
  return st
}

// ---- 主流程 ----

async function main(): Promise<void> {
  console.log("=== W4 todo 24 命令支持度实证 ===")
  console.log(`模型: ${PROVIDER}/${MODEL} thinking=${THINKING} cwd=${PROJ_DIR}`)
  mkdirSync(PROJ_DIR, { recursive: true })
  writeFileSync(join(PROJ_DIR, "README.md"), "# W4-24 命令实证项目\n")

  const client = newClient()
  const events = new EventLog()
  client.onEvent((e) => events.add(e))
  autoRespondDialogs(client, "main")

  try {
    await withTimeout(client.start(), 30000, "start")
    if (!(await waitUntilReady(client))) throw new Error("引擎 40s 未就绪")

    // 2) 打开会话 + getCommands（命令注册表需活跃会话路由，multi-session 下 open 前 missing_session_id）
    section("open_session + getCommands 清单")
    await withTimeout(client.openSession({ provider: PROVIDER, modelId: MODEL, thinkingLevel: THINKING }) as never, 60000, "open_session")
    let cmdNames: string[] = []
    try {
      const cmds = (await withTimeout(client.getCommands(), 15000, "get_commands")) as Array<{ name?: string }>
      cmdNames = cmds.map((c) => String(c.name ?? "")).filter(Boolean)
      writeFileSync(join(PROJ_DIR, "commands.json"), JSON.stringify(cmds, null, 2))
      console.log(`共 ${cmdNames.length} 条；目标命中: ${PROBES.map((p) => p.slice(1)).map((n) => `${n}=${cmdNames.includes(n)}`).join(" ")}`)
      console.log(`全量: ${cmdNames.join(",")}`)
    } catch (e) {
      console.log(`getCommands 失败: ${e instanceof Error ? e.message : e}`)
    }

    // 3) 物化 prompt（/undo 要有消息可撤）
    section("物化 prompt")
    const st0 = await getState(client)
    console.log(`会话: ${String(st0.sessionId ?? "").slice(0, 12)}… sessionFile=${String(st0.sessionFile ?? "")}`)
    const sid0 = String(st0.sessionId ?? "")
    console.log(`会话: ${sid0.slice(0, 12)}… sessionFile=${String(st0.sessionFile ?? "")}`)
    const mark0 = events.mark()
    void client.prompt("请只回复四个字：链路正常", { thinkingLevel: THINKING }).catch(() => undefined)
    await withTimeout(events.waitFor("agent_settled", 120000, mark0), 125000, "物化回合 agent_settled")
    const { rows: rows0 } = sessionLines(st0)
    console.log(`物化完成，jsonl 行数=${rows0.length}`)

    // 3) 逐个命令探针
    for (const cmd of PROBES) {
      section(`探针 ${cmd}`)
      const stBefore = await getState(client)
      const sidBefore = String(st0.sessionId ?? "") === "" ? "" : String(stBefore.sessionId ?? "")
      const { rows: rowsBefore } = sessionLines(stBefore)
      const mark = events.mark()
      let response: { ok: boolean; detail: string }
      const p = client.prompt(cmd, { thinkingLevel: THINKING }).then(
        (d) => ({ ok: true, detail: brief(d) }),
        (e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }),
      )
      const raced = await Promise.race([
        p.then((r) => ({ kind: "response" as const, r })),
        new Promise<{ kind: "timeout" }>((r) => setTimeout(() => r({ kind: "timeout" }), 45000)),
      ])
      if (raced.kind === "response") {
        response = raced.r
      } else {
        response = { ok: false, detail: "45s 无响应（可能挂起，继续下个探针前 abort）" }
        try {
          await withTimeout(client.abort(), 8000, "abort(探针超时清理)")
        } catch {
          /* 已落定 */
        }
      }
      // 观察窗口：命令副作用事件多为即时；有回合则等 agent_settled（上限再 60s）
      let settledNote = "无回合事件"
      try {
        await events.waitFor("agent_settled", 60000, mark)
        settledNote = "出现 agent_settled（触发模型回合）"
      } catch {
        /* 无回合 */
      }
      await new Promise((r) => setTimeout(r, 800))
      const stAfter = await getState(client)
      const { rows: rowsAfter } = sessionLines(stAfter)
      const window = events.slice(mark)
      const types: Record<string, number> = {}
      for (const e of window) types[String(e.type ?? "?")] = (types[String(e.type ?? "?")] ?? 0) + 1
      // 抓窗口内的 assistant 文本与错误线索
      const texts: string[] = []
      for (const e of window) {
        const msg = e.message as { role?: string; content?: unknown } | undefined
        if (e.type === "message_end" && msg?.role === "assistant") {
          const c = msg.content
          const t = Array.isArray(c)
            ? c.map((p: { type?: string; text?: string }) => (p?.type === "text" ? p.text ?? "" : "")).join("")
            : typeof c === "string"
              ? c
              : ""
          if (t.trim()) texts.push(t.trim().slice(0, 160))
        }
        if (e.type === "truncated" || /error|Unknown/i.test(String(e.type))) texts.push(`${e.type}: ${brief(e, 240)}`)
      }
      const sidAfter = String(stAfter.sessionId ?? "")
      console.log(`prompt 响应: ${response.ok ? "OK" : "ERR"} ${response.detail}`)
      console.log(`窗口事件: ${JSON.stringify(types)}`)
      console.log(`${settledNote}`)
      console.log(`assistant 文本: ${texts.length > 0 ? JSON.stringify(texts) : "无"}`)
      console.log(
        `状态: sessionId ${sidBefore === sidAfter ? "未变" : `变更 ${sidBefore.slice(0, 8)}→${sidAfter.slice(0, 8)}`}；jsonl 行数 ${rowsBefore.length}→${rowsAfter.length}`,
      )
      console.log(
        `getCommands 命中: ${cmdNames.includes(cmd.slice(1))}`,
      )
    }
  } finally {
    section("清理")
    try {
      await withTimeout(client.stop(), 8000, "stop")
      console.log("client.stop() 完成")
    } catch {
      console.log("client.stop() 失败，按 PID 清扫")
    }
    for (const pid of listEngineProcesses()) {
      try {
        process.kill(pid, "SIGKILL")
        console.log(`强杀遗留 ${pid}`)
      } catch {
        /* 已退出 */
      }
    }
    const left = listEngineProcesses()
    console.log(`/proc 复核剩余引擎进程: ${left.length}`)
    process.exit(left.length > 0 ? 3 : 0)
  }
}

main().catch((e) => {
  console.error("spike 失败:", e)
  for (const pid of listEngineProcesses()) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* 已退出 */
    }
  }
  process.exit(1)
})
