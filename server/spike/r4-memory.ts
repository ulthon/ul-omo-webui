/**
 * 记忆-spike：记忆三面数据源钉死（docs08-r4 任务 3，Blocks: 12,13）。
 *
 * 场景：
 *   A  hash 推算    ：sha256(resolve(cwd))[:8] + basename 清洗 slug，对照 ~/.omo/memory/agents/ 实存目录
 *   B  共库实测     ：/tmp throwaway 项目——Phase1 直接引擎 RPC（CLI 等价）跑一轮建库；
 *                     Phase2 隔离 webui（临时 DATA_DIR、17902）注册同目录跑一轮，核对同一库目录
 *   C  标记条目     ：两阶段父会话 JSONL 枚举 memory 相关 customType + SSE 抓包核对到达形态
 *   D  数据源排查   ：root-94a6b447 的 receipts/final.json/notices/sidecar 键集合（只读）
 * 运行：cd /data/projects/senpi-webui && bun run server/spike/r4-memory.ts
 */

import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import { RpcClient } from "@code-yeongyu/senpi"

const REPO = "/data/projects/senpi-webui"
const AGENT_DIR = "/root/.pi/agent"
const PROVIDER = "zai-coding-cn"
const MODEL = "glm-5.3-flash"
const THINKING = "low" as const
const PROJ_DIR = "/tmp/opencode/r4-mem-proj"
const WEBUI_DIR = "/tmp/opencode/r4-mem-webui-data"
const WEBUI_PORT = 17902
const WEBUI_BASE = `http://127.0.0.1:${WEBUI_PORT}`
const WEBUI_PASSWORD = "r4mem-spike-only"
const SELF_PID = process.pid
const PROMPT_TEXT = "只回复两个字母: OK"

function engineCli(): string {
  const p = `${REPO}/node_modules/.bun/omo-ai@5.1.0/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js`
  if (!existsSync(p)) throw new Error(`引擎 cli 不存在: ${p}`)
  return p
}
const PLUGIN_DIR = `${REPO}/server/node_modules/omo-ai/plugin`
const MEMORY_HOME = join(homedir(), ".omo", "memory")

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
      if ((await send({ type: "get_protocol_info" })).success) return
    } catch {
      // 重试
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`[${label}] 引擎就绪探测失败`)
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

async function killEngineOrphans(): Promise<number> {
  for (const p of listEngineProcesses()) {
    try {
      process.kill(p.pid, "SIGKILL")
    } catch {
      // 已退出
    }
  }
  await new Promise((r) => setTimeout(r, 800))
  return listEngineProcesses().length
}

// ---------- Part A：hash 推算 ----------

/** 仿 omo.js resolveMemoryIdentity：sha256(resolve(cwd))[:8]，slug=basename 清洗（非字母数字折叠 '-'、截 40）。 */
function predictLibId(cwd: string): { id: string; hash: string; slug: string } {
  const abs = resolve(cwd)
  const hash = createHash("sha256").update(abs, "utf8").digest("hex").slice(0, 8)
  let slug = basename(abs)
    .normalize("NFKD")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .normalize("NFC")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")
  if (slug === "") slug = "agent"
  return { id: `${slug}-${hash}`, hash, slug }
}

function partA(): Record<string, unknown> {
  section("Part A：库路径 hash 推算核对")
  const cands = ["/root", "/", "/data/projects/senpi-webui", PROJ_DIR]
  const out: Record<string, unknown> = {}
  for (const cwd of cands) {
    const pred = predictLibId(cwd)
    const exists = existsSync(join(MEMORY_HOME, "agents", pred.id))
    console.log(`  cwd=${cwd} → ${pred.id}  ${exists ? "【存在】" : "【不存在】"}`)
    out[cwd] = { predicted: pred.id, exists }
  }
  return out
}

// ---------- 会话 JSONL 枚举（Part C 数据面） ----------

const MEMORY_CUSTOM_RE = /^(senpi-memory[.:]|omo-memory:|omo-kibitzer:|omo-memorian:)/

interface CustomFinding {
  customType: string
  count: number
  sample: string
}

function enumMemoryCustoms(sessionFile: string): { total: number; memory: CustomFinding[] } {
  let total = 0
  const byType = new Map<string, CustomFinding>()
  try {
    const lines = readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.trim())
    for (const line of lines) {
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (obj.type === "custom") total += 1
      const ct = typeof obj.customType === "string" ? obj.customType : ""
      if (!ct || !MEMORY_CUSTOM_RE.test(ct)) continue
      const found = byType.get(ct) ?? { customType: ct, count: 0, sample: "" }
      if (found.count === 0) found.sample = line.length > 600 ? `${line.slice(0, 600)}…` : line
      found.count += 1
      byType.set(ct, found)
    }
  } catch (e) {
    console.log(`  读取失败 ${sessionFile}: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { total, memory: [...byType.values()] }
}

function printCustoms(label: string, sessionFile: string): CustomFinding[] {
  section(`${label}：${sessionFile}`)
  if (!existsSync(sessionFile)) {
    console.log("  会话文件不存在")
    return []
  }
  const { total, memory } = enumMemoryCustoms(sessionFile)
  console.log(`  custom 条目总数=${total}，memory 相关=${memory.length} 类`)
  for (const f of memory) {
    console.log(`  ── ${f.customType} ×${f.count}`)
    console.log(`     样例: ${f.sample}`)
  }
  return memory
}

// ---------- SSE 抓包（Part C 通道面） ----------

interface SseFrame {
  event: string
  id: string
  data: string
}

async function captureSse(cookie: string, stop: Promise<void>): Promise<SseFrame[]> {
  const frames: SseFrame[] = []
  const ac = new AbortController()
  try {
    const res = await fetch(`${WEBUI_BASE}/api/events`, {
      headers: { Cookie: cookie },
      signal: ac.signal,
    })
    if (!res.body) return frames
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    const pump = async (): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const f: SseFrame = { event: "message", id: "", data: "" }
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) f.event = line.slice(6).trim()
            else if (line.startsWith("id:")) f.id = line.slice(3).trim()
            else if (line.startsWith("data:")) f.data += line.slice(5).trim()
          }
          frames.push(f)
        }
      }
    }
    const racing = Promise.race([pump(), stop])
    void racing.then(() => ac.abort()).catch(() => ac.abort())
  } catch (e) {
    console.log(`  SSE 连接失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  return frames
}

function analyzeSseMemory(frames: SseFrame[]): Array<Record<string, unknown>> {
  const hits: Array<Record<string, unknown>> = []
  for (const f of frames) {
    let wire: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(f.data) as { event?: Record<string, unknown> }
      wire = parsed.event ?? null
    } catch {
      continue
    }
    if (!wire) continue
    const wireType = String(wire.type ?? "")
    const msg = wire.message as Record<string, unknown> | undefined
    const role = typeof msg?.role === "string" ? msg.role : ""
    const entry = wire.entry as Record<string, unknown> | undefined
    const entryType = typeof entry?.type === "string" ? entry.type : ""
    const customType =
      (typeof msg?.customType === "string" ? msg.customType : "") ||
      (typeof entry?.customType === "string" ? entry.customType : "") ||
      (typeof wire.customType === "string" ? wire.customType : "")
    if (MEMORY_CUSTOM_RE.test(customType) || entryType === "custom" || role === "custom") {
      hits.push({ sseEvent: f.event, wireType, role, entryType, customType, id: f.id })
    }
  }
  return hits
}

// ---------- Phase 2：隔离 webui ----------

async function startWebui(): Promise<{ child: ReturnType<typeof spawn>; cookie: string }> {
  mkdirSync(WEBUI_DIR, { recursive: true })
  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: join(REPO, "server"),
    env: {
      ...process.env,
      SENPI_WEBUI_DATA_DIR: WEBUI_DIR,
      SENPI_WEBUI_PORT: String(WEBUI_PORT),
      SENPI_WEBUI_HOST: "127.0.0.1",
      SENPI_WEBUI_PASSWORD: WEBUI_PASSWORD,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.on("data", (d: Buffer) => console.log(`  [webui] ${d.toString().trimEnd().slice(0, 200)}`))
  child.stderr?.on("data", (d: Buffer) => console.log(`  [webui:err] ${d.toString().trimEnd().slice(0, 200)}`))

  // 轮询登录就绪
  let cookie = ""
  for (let i = 1; i <= 45; i++) {
    try {
      const res = await fetch(`${WEBUI_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: WEBUI_PASSWORD }),
      })
      if (res.status === 200) {
        const setCookie = res.headers.get("set-cookie") ?? ""
        cookie = setCookie.split(";")[0] ?? ""
        console.log(`  webui 就绪（第 ${i} 次探测），cookie=${cookie.slice(0, 30)}…`)
        return { child, cookie }
      }
    } catch {
      // 未就绪
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  child.kill("SIGKILL")
  throw new Error("webui 登录就绪超时（45s）")
}

async function apiJson(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${WEBUI_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let json: Record<string, unknown> = {}
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    // 空响应
  }
  return { status: res.status, json }
}

async function stopWebui(child: ReturnType<typeof spawn> | null): Promise<void> {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null) return
    await new Promise((r) => setTimeout(r, 500))
  }
  child.kill("SIGKILL")
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  mkdirSync(PROJ_DIR, { recursive: true })
  const out: Record<string, unknown> = {}

  // ---- Part A ----
  out.partA = partA()

  // ---- Part B Phase 1：CLI 等价引擎一轮 ----
  section("Part B Phase 1：直接引擎（CLI 等价）在 /tmp 项目跑一轮")
  const cli = engineCli()
  const a = new RpcClient({
    cliPath: cli,
    args: ["--extension", PLUGIN_DIR, "--multi-session"],
    cwd: PROJ_DIR,
    env: { OMO_CODING_AGENT_DIR: AGENT_DIR, SENPI_CODING_AGENT_DIR: AGENT_DIR, OMO_NATIVE: "1", PI_OFFLINE: "1" },
    provider: PROVIDER,
    model: MODEL,
  })
  let phase1SessionFile = ""
  try {
    await withTimeout(a.start(), 60000, "start(P1)")
    await withTimeout(a.setClientInfo(80, ["extension_events"]), 20000, "sci(P1)")
    await waitUntilReady(a, "P1")
    const open = await withTimeout(
      a.openSession({ provider: PROVIDER, modelId: MODEL, thinkingLevel: THINKING }),
      60000,
      "open(P1)",
    ).then((r) => r as unknown as { sessionId: string; state: Record<string, unknown> })
    phase1SessionFile = String(open.state.sessionFile ?? "")
    console.log(`  会话 durable=${open.sessionId} file=${phase1SessionFile}`)
    const settled = new Promise<void>((res) => {
      a.onEvent((e) => {
        if ((e as { type?: string }).type === "agent_settled") res()
      })
    })
    await withTimeout(a.prompt(PROMPT_TEXT, { thinkingLevel: THINKING }), 120000, "prompt(P1)")
    await withTimeout(settled, 180000, "settled(P1)")
    console.log("  回合落定，等 memory 管线 12s…")
    await new Promise((r) => setTimeout(r, 12000))
  } finally {
    await a.stop().catch(() => undefined)
  }
  const p1Lib = join(MEMORY_HOME, "agents", predictLibId(PROJ_DIR).id)
  console.log(`  期望库目录: ${p1Lib}  存在=${existsSync(p1Lib)}`)
  if (existsSync(p1Lib)) {
    console.log(`  库目录树: ${readdirSync(p1Lib).join(", ")}`)
    const runtime = join(p1Lib, "runtime")
    if (existsSync(runtime)) console.log(`  runtime/: ${readdirSync(runtime).join(", ")}`)
    const sidecars = join(runtime, "recall", "sidecars")
    if (existsSync(sidecars)) console.log(`  recall/sidecars/: ${readdirSync(sidecars).join(", ").slice(0, 300)}`)
  }
  out.phase1 = { libDir: p1Lib, libExists: existsSync(p1Lib), sessionFile: phase1SessionFile }
  const p1Customs = phase1SessionFile ? printCustoms("Part C Phase1 会话 JSONL", phase1SessionFile) : []
  out.phase1Customs = p1Customs

  // ---- Part B Phase 2：隔离 webui 注册同目录跑一轮 ----
  section("Part B Phase 2：隔离 webui（DATA_DIR=/tmp、17902）注册同目录跑一轮")
  let webui: { child: ReturnType<typeof spawn>; cookie: string } | null = null
  try {
    webui = await startWebui()
    const { cookie } = webui
    const addRes = await apiJson("POST", "/api/projects", cookie, { path: PROJ_DIR })
    console.log(`  POST /api/projects → ${addRes.status}`)
    const sesRes = await apiJson("POST", "/api/sessions", cookie, { project: PROJ_DIR })
    const session = sesRes.json.session as { id?: string } | undefined
    const sessionId = String(session?.id ?? "")
    console.log(`  POST /api/sessions → ${sesRes.status} id=${sessionId}`)
    if (!sessionId) throw new Error(`webui 建会话失败: ${JSON.stringify(sesRes.json).slice(0, 300)}`)

    // SSE 抓包与 prompt 并行
    let stopCapture: (() => void) | null = null
    const stopPromise = new Promise<void>((res) => {
      stopCapture = res
    })
    const sseDone = captureSse(cookie, stopPromise)
    const promptRes = await apiJson("POST", `/api/sessions/${sessionId}/prompt`, cookie, {
      text: `${PROMPT_TEXT}（webui 侧）`,
      thinkingLevel: THINKING,
    })
    console.log(`  POST prompt → ${promptRes.status} ${JSON.stringify(promptRes.json).slice(0, 200)}`)

    // 轮询消息直到 assistant 回复落盘
    let done = false
    for (let i = 1; i <= 120; i++) {
      const m = await apiJson("GET", `/api/sessions/${sessionId}/messages`, cookie)
      const entries = (m.json.entries ?? []) as Array<Record<string, unknown>>
      const hasAssistant = entries.some((e) => {
        const msg = e.message as { role?: string } | undefined
        return msg?.role === "assistant"
      })
      if (hasAssistant && i > 3) {
        done = true
        break
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    console.log(`  webui 会话回合落定=${done}，等 memory 管线 15s…`)
    await new Promise((r) => setTimeout(r, 15000))
    stopCapture?.()

    const frames = await sseDone
    console.log(`  SSE 帧总数=${frames.length}`)
    const memFrames = analyzeSseMemory(frames)
    console.log(`  SSE 中 memory/custom 相关帧=${memFrames.length}`)
    for (const h of memFrames.slice(0, 20)) console.log(`  ── ${JSON.stringify(h)}`)
    const wireCounts = new Map<string, number>()
    for (const f of frames) {
      try {
        const w = (JSON.parse(f.data) as { event?: { type?: string } }).event
        const t = String(w?.type ?? f.event)
        wireCounts.set(t, (wireCounts.get(t) ?? 0) + 1)
      } catch {
        // 跳过非 JSON 帧
      }
    }
    console.log(`  SSE wireType 分布: ${JSON.stringify(Object.fromEntries([...wireCounts.entries()].sort()))}`)

    // Phase2 会话文件定位：webui 元库记录的 sessionPath 或按 AGENT_DIR sessions 目录扫描
    let phase2SessionFile = ""
    const sesDir = join(AGENT_DIR, "sessions")
    if (existsSync(sesDir)) {
      outer: for (const dir of readdirSync(sesDir)) {
        const d = join(sesDir, dir)
        if (!statSync(d).isDirectory()) continue
        for (const f of readdirSync(d)) {
          if (!f.endsWith(".jsonl")) continue
          const full = join(d, f)
          try {
            const head = readFileSync(full, "utf8").slice(0, 2000)
            if (head.includes(`"${PROJ_DIR}"`) && head.includes("r4-mem-proj")) {
              phase2SessionFile = full
              break outer
            }
          } catch {
            // 跳过
          }
        }
      }
    }
    console.log(`  Phase2 会话文件（扫描定位）: ${phase2SessionFile || "未找到"}`)
    const libAfter = existsSync(p1Lib) ? readdirSync(p1Lib).join(", ") : "(无)"
    const runtimeAfter = existsSync(join(p1Lib, "runtime")) ? readdirSync(join(p1Lib, "runtime")).join(", ") : "(无)"
    const sidecarsAfter = existsSync(join(p1Lib, "runtime", "recall", "sidecars"))
      ? readdirSync(join(p1Lib, "runtime", "recall", "sidecars"))
      : []
    console.log(`  共库核对: 库目录=${p1Lib}`)
    console.log(`  Phase2 后库目录内容: ${libAfter}`)
    console.log(`  Phase2 后 runtime/: ${runtimeAfter}`)
    console.log(`  Phase2 后 sidecars 数=${sidecarsAfter.length}: ${sidecarsAfter.join(", ").slice(0, 400)}`)
    const receipts = join(p1Lib, "runtime", "receipts.jsonl")
    if (existsSync(receipts)) {
      const lines = readFileSync(receipts, "utf8").split("\n").filter((l) => l.trim())
      console.log(`  receipts.jsonl 行数=${lines.length}`)
      for (const l of lines.slice(0, 8)) console.log(`    ${l.slice(0, 260)}`)
    }
    out.phase2 = {
      sessionId,
      sessionFile: phase2SessionFile,
      libDir: p1Lib,
      sidecarsCount: sidecarsAfter.length,
      sseFrameTotal: frames.length,
      sseMemoryFrames: memFrames,
      sharedLibConfirmed: existsSync(p1Lib) && sidecarsAfter.length >= 2,
    }
    const p2Customs = phase2SessionFile ? printCustoms("Part C Phase2 会话 JSONL", phase2SessionFile) : []
    out.phase2Customs = p2Customs
  } finally {
    await stopWebui(webui?.child ?? null)
  }

  // ---- Part D：root-94a6b447 数据源排查（只读） ----
  section("Part D：root-94a6b447 管线工件键集合（只读排查）")
  const R = join(MEMORY_HOME, "agents", "root-94a6b447")
  const d: Record<string, unknown> = {}
  const receiptsFile = join(R, "runtime", "receipts.jsonl")
  if (existsSync(receiptsFile)) {
    const lines = readFileSync(receiptsFile, "utf8").split("\n").filter((l) => l.trim())
    const keys = new Set<string>()
    const kinds = new Set<string>()
    for (const l of lines) {
      try {
        const o = JSON.parse(l) as Record<string, unknown>
        Object.keys(o).forEach((k) => keys.add(k))
        if (typeof o.kind === "string") kinds.add(o.kind)
      } catch {
        // 跳过
      }
    }
    const hasSessionKey = [...keys].some((k) => /session/i.test(k))
    console.log(`  receipts.jsonl 行数=${lines.length} 键集合=${[...keys].sort().join(",")} kinds=${[...kinds].join(",")}`)
    console.log(`  含 session 关联键=${hasSessionKey}`)
    d.receipts = { lines: lines.length, keys: [...keys].sort(), kinds: [...kinds], hasSessionKey }
  }
  const runsDir = join(R, "runtime", "facts", "runs")
  if (existsSync(runsDir)) {
    const finals: string[] = []
    for (const run of readdirSync(runsDir)) {
      const f = join(runsDir, run, "final.json")
      if (existsSync(f)) finals.push(readFileSync(f, "utf8"))
    }
    const keys = new Set<string>()
    for (const f of finals) {
      try {
        Object.keys(JSON.parse(f) as Record<string, unknown>).forEach((k) => keys.add(k))
      } catch {
        // 跳过
      }
    }
    const hasSessionKey = [...keys].some((k) => /session/i.test(k))
    console.log(`  facts/runs/*/final.json 份数=${finals.length} 键集合=${[...keys].sort().join(",")} 含 session 关联键=${hasSessionKey}`)
    d.finalJson = { count: finals.length, keys: [...keys].sort(), hasSessionKey }
  }
  const notices = join(R, "runtime", "notices")
  if (existsSync(notices)) {
    console.log(`  notices/: ${readdirSync(notices).join(", ")}`)
    d.notices = readdirSync(notices)
  }
  const sidecarsDir = join(R, "runtime", "recall", "sidecars")
  if (existsSync(sidecarsDir)) {
    const sids = readdirSync(sidecarsDir)
    console.log(`  recall/sidecars/ 共 ${sids.length} 个（目录名为 base64 会话 id 样例: ${sids[0] ?? "-"}）`)
    const first = join(sidecarsDir, sids[0] ?? "")
    const jsonls = existsSync(first) ? readdirSync(first).filter((f) => f.endsWith(".jsonl")) : []
    if (jsonls[0]) {
      const head = readFileSync(join(first, jsonls[0]), "utf8").split("\n")[0] ?? ""
      console.log(`  sidecar JSONL 首行: ${head.slice(0, 300)}`)
      d.sidecarFirstLine = head.slice(0, 300)
    }
    d.sidecarsCount = sids.length
  }
  out.partD = d

  // ---- 清理 ----
  section("清理")
  const leftEngines = await killEngineOrphans()
  console.log(`  引擎孤儿清扫后剩余=${leftEngines}`)
  out.leftEngineProcesses = leftEngines

  console.log(`\n记忆-spike 结论=${JSON.stringify(out, null, 2)}`)
  console.log("R4 MEMORY SPIKE DONE")
}

main().catch(async (e) => {
  console.error(`记忆-spike FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  await killEngineOrphans()
  process.exitCode = 2
})
