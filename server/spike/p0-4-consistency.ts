/**
 * P0-4 HOME/cwd 数据一致性验证 spike（todo 6）。
 *
 * 双向互通实证（docs/06 P0 第 4 条；docs/03「数据一致性模型」）：
 *  - 正向：宿主 spawn 引擎 RPC 子进程（继承 HOME + OMO_CODING_AGENT_DIR，cwd=隔离测试项目），
 *    建会话发一条短消息；会话应落进 OMO_CODING_AGENT_DIR/sessions/<cwd 编码目录>/，
 *    终端侧 omo CLI（同 HOME 同 env 同 cwd）resume 列表可见（终端侧确认由 bash 步骤执行并入档）。
 *  - 反向：从 spike 侧列出一个终端创建的既有会话（引擎 session store 中 mtime 早于本 spike 的
 *    会话文件），经 RPC openSession + getEntries 游标分页读取其消息，证明引擎读路径对终端
 *    会话原样可用。
 *
 * 全程不向任何既有会话发送消息；引擎子进程用完即 stop()，并打印 PID 供 bash 复核。
 *
 * 运行：OMO_CODING_AGENT_DIR=/root/.pi/agent bun run server/spike/p0-4-consistency.ts
 * 模型：zai-coding-cn/glm-5.3-flash（00-env.md 选定，低 thinking 档，短 prompt）
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { RpcClient, type RpcClientEvent } from "@code-yeongyu/senpi"

const HOME = process.env.HOME ?? ""
const AGENT_DIR = process.env.OMO_CODING_AGENT_DIR?.trim() || ""
const TEST_PROJECT = "/tmp/opencode/p0-4-proj"
const MODEL_PROVIDER = "zai-coding-cn"
const MODEL_ID = "glm-5.3-flash"
// 反向读取目标：用户既有历史项目（2026-08-13 终端 pi 使用期创建的会话，早于本 spike）
const LEGACY_PROJECT_DIR = join(AGENT_DIR, "sessions", "--data-projects-pool-business-demo-docker--")
const PAGE_SIZE = 10

if (!HOME || !AGENT_DIR) {
  console.error("缺少 HOME 或 OMO_CODING_AGENT_DIR，拒绝在未知 agent 目录下运行")
  process.exit(1)
}

// omo-ai 包根与插件目录：spike 位于 server/spike/，omo-ai 在 server/node_modules/omo-ai
const omoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "node_modules", "omo-ai")
const pluginPath = join(omoRoot, "plugin")
// omo-ai launcher 的 resolveSenpi 语义：从 omo-ai 包内解析其锁定的 @code-yeongyu/senpi，
// cli 优先 bundle/cli.js，回退 dist/cli.js（照抄 bin/lib/package-paths.js 的判定顺序）。
// bun 隔离布局下 omo-ai 是 node_modules/.bun 里的符号链接，必须用 realpath 解析，
// 否则会解析到宿主直依赖的 2026.10.10 而不是 omo-ai 锁定的引擎版本。
const omoRequire = createRequire(join(omoRoot, "package.json"))
const senpiPackageJson = omoRequire.resolve("@code-yeongyu/senpi/package.json", {
  paths: [realpathSync(omoRoot)],
})
const senpiDist = join(senpiPackageJson, "..", "dist")
const senpiCli = existsSync(join(senpiDist, "bundle", "cli.js"))
  ? join(senpiDist, "bundle", "cli.js")
  : join(senpiDist, "cli.js")
const omoVersion = omoRequire(join(omoRoot, "package.json")).version
const senpiVersion = omoRequire(senpiPackageJson).version

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

/** cwd -> 引擎 session store 子目录名（实测规则：去前导 /，其余 / -> -，整体包在 --...-- 中） */
function cwdToSessionDir(cwd: string): string {
  return `--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`
}

interface LegacySessionFile {
  path: string
  file: string
  id: string
  cwd: string
  mtimeMs: number
  size: number
  lines: number
}

/** 列出既有历史项目的会话文件（只读：目录列举 + 首行 header 解析），选消息量适中且早于本 spike 的一条 */
function listLegacySessions(): LegacySessionFile[] {
  const now = Date.now()
  const out: LegacySessionFile[] = []
  for (const file of readdirSync(LEGACY_PROJECT_DIR)) {
    if (!file.endsWith(".jsonl")) continue
    const path = join(LEGACY_PROJECT_DIR, file)
    const st = statSync(path)
    if (now - st.mtimeMs < 24 * 3600 * 1000) continue // 只认早于 24h 的文件 = 非本 spike 创建
    const firstLine = readFileSync(path, "utf8").split("\n")[0] ?? ""
    const header = JSON.parse(firstLine) as { type?: string; id?: string; cwd?: string }
    if (header.type !== "session" || !header.id || !header.cwd) continue
    const lines = readFileSync(path, "utf8").trim().split("\n").length
    out.push({ path, file, id: header.id, cwd: header.cwd, mtimeMs: st.mtimeMs, size: st.size, lines })
  }
  return out.sort((a, b) => a.lines - b.lines)
}

function spawnEnv(): Record<string, string> {
  return { OMO_CODING_AGENT_DIR: AGENT_DIR, SENPI_CODING_AGENT_DIR: AGENT_DIR }
}

/** 登记已创建的客户端：任何一步失败退出前也要把引擎子进程杀干净（MUST DO 约束） */
const activeClients = new Set<RpcClient>()

function makeClient(options: ConstructorParameters<typeof RpcClient>[0]): RpcClient {
  const client = new RpcClient(options)
  activeClients.add(client)
  return client
}

function childPid(client: RpcClient): number | undefined {
  return (client as unknown as { process?: { pid?: number } }).process?.pid
}

async function stopAndVerify(client: RpcClient, label: string): Promise<void> {
  const pid = childPid(client)
  await client.stop()
  // stop() 发 SIGTERM 后等 1s 才 SIGKILL 并立即 resolve；这里轮询 /proc 复核真的退出了
  let alive = false
  for (let i = 0; i < 20 && pid; i++) {
    alive = existsSync(`/proc/${pid}`)
    if (!alive) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (alive && pid) {
    process.kill(pid, "SIGKILL")
    console.log(`  [${label}] 引擎子进程 pid=${pid} stop() 后仍存活，已补 SIGKILL`)
  } else {
    console.log(`  [${label}] 引擎子进程 pid=${pid} 已退出`)
  }
}

// ---------------------------------------------------------------- 正向
// 单会话 RPC 模式（经典模式）不受理 open_session（拒绝码 multi_session_disabled）：
// 进程即会话，provider/model/name 用 CLI 参数在启动时给定，promptAndWait 直接驱动。
async function forward(): Promise<void> {
  console.log("\n=== 正向：宿主 spawn 引擎 -> 建会话发消息（web 姿势） ===")
  mkdirSync(TEST_PROJECT, { recursive: true })
  const readme = join(TEST_PROJECT, "README.md")
  if (!existsSync(readme)) writeFileSync(readme, "# P0-4 一致性验证测试项目\n\n隔离目录，仅用于 spike。\n")

  const client = makeClient({
    cliPath: senpiCli,
    args: ["--extension", pluginPath, "--provider", MODEL_PROVIDER, "--model", MODEL_ID, "--name", "P0-4 一致性验证"],
    cwd: TEST_PROJECT,
    env: spawnEnv(),
  })
  const eventTypes = new Map<string, number>()
  const samples: string[] = []
  client.onEvent((event: RpcClientEvent) => {
    eventTypes.set(event.type, (eventTypes.get(event.type) ?? 0) + 1)
    if (samples.length < 3 && (event.type === "message_start" || event.type === "message_update" || event.type === "agent_start")) {
      samples.push(JSON.stringify(event).slice(0, 220))
    }
  })

  console.log(`spawn: node ${senpiCli} --extension ${pluginPath} --mode rpc --provider ${MODEL_PROVIDER} --model ${MODEL_ID}`)
  console.log(`  HOME=${HOME}  OMO_CODING_AGENT_DIR=${AGENT_DIR}  cwd=${TEST_PROJECT}`)
  await client.start()
  console.log(`  引擎子进程 pid=${childPid(client)}`)

  const t0 = Date.now()
  await client.promptAndWait("回复：OK", undefined, 120_000)
  console.log(`  promptAndWait("回复：OK") 完成，耗时 ${Date.now() - t0}ms`)
  const last = await client.getLastAssistantText()
  console.log(`  末条助手消息: ${JSON.stringify(last)}`)
  const state = await client.getState()
  const sessionId = state.sessionId
  console.log(`  state.sessionId=${sessionId}`)
  console.log(`  state.sessionFile=${state.sessionFile}`)
  console.log(`  state.model=${state.model?.provider}/${state.model?.id}  sessionName=${state.sessionName}`)
  console.log(`  事件类型统计: ${JSON.stringify(Object.fromEntries([...eventTypes.entries()].sort()))}`)
  for (const s of samples) console.log(`  事件样本: ${s}`)

  await stopAndVerify(client, "正向")
  if (!sessionId) throw new Error("正向失败：getState 未返回 sessionId")

  // 落盘核对：会话文件应出现在 agentDir/sessions/<cwd 编码>/
  const dir = join(AGENT_DIR, "sessions", cwdToSessionDir(TEST_PROJECT))
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : []
  console.log(`  落盘核对: ${dir}`)
  console.log(`  会话文件 ${files.length} 个: ${files.join(", ") || "（无）"}`)
  const hit = files.find((f) => f.includes(sessionId))
  if (!hit) throw new Error(`正向失败：会话 ${sessionId} 未落进预期 store 目录`)
  console.log(`  正向 PASS：sessionId=${sessionId} 已写入引擎 store（文件 ${hit}）`)
}

// ---------------------------------------------------------------- 反向
async function reverse(): Promise<void> {
  console.log("\n=== 反向：spike 侧列出并分页读取终端创建的既有会话 ===")
  const sessions = listLegacySessions()
  console.log(`store 目录 ${LEGACY_PROJECT_DIR} 中早于 24h 的会话 ${sessions.length} 个：`)
  for (const s of sessions) {
    console.log(
      `  ${s.id}  lines=${s.lines} size=${s.size} cwd=${s.cwd} mtime=${new Date(s.mtimeMs).toISOString()}`,
    )
  }
  // 挑消息行数适中（8~40 行）的最早会话；全部超界则取行数最少者
  const candidate =
    sessions.find((s) => s.lines >= 8 && s.lines <= 40) ?? sessions[0]
  if (!candidate) throw new Error("反向失败：store 中没有早于 24h 的既有会话")
  console.log(
    `选中: ${candidate.id}（${candidate.file}，lines=${candidate.lines}，mtime=${new Date(candidate.mtimeMs).toISOString()}，早于本 spike，为终端创建）`,
  )

  const before = { sha: sha256(candidate.path), size: statSync(candidate.path).size }
  // 单会话模式用 --session 打开既有会话（cwd 沿用会话记录的项目目录，避免 rebind 语义介入）
  const client = makeClient({
    cliPath: senpiCli,
    args: ["--extension", pluginPath, "--session", candidate.path],
    cwd: candidate.cwd,
    env: spawnEnv(),
  })
  console.log(`spawn: cwd=${candidate.cwd}，--session <文件路径> 只读打开既有会话`)
  await client.start()
  console.log(`  引擎子进程 pid=${childPid(client)}`)
  const state = await client.getState()
  console.log(`  state.sessionId=${state.sessionId}  sessionFile=${state.sessionFile}`)
  if (state.sessionId !== candidate.id) {
    throw new Error(`反向失败：打开的会话 ID ${state.sessionId} 与目标 ${candidate.id} 不一致`)
  }

  // 分页读取：getEntries() 全量后按 PAGE_SIZE 切第一页，再以 since=页尾 entry id 取第二页
  const all = await client.getEntries()
  console.log(`  getEntries(): entries=${all.entries.length} leafId=${all.leafId}`)
  const page1 = all.entries.slice(0, PAGE_SIZE)
  const page2 = await client.getEntries(page1[page1.length - 1]?.id)
  console.log(`  第 1 页（since 缺省）: ${page1.length} 条`)
  for (const e of page1) {
    const text =
      "text" in e && typeof (e as { text?: unknown }).text === "string"
        ? JSON.stringify((e as { text: string }).text).slice(0, 80)
        : ""
    console.log(`    [${e.type}] id=${e.id}${text ? ` text=${text}` : ""}`)
  }
  console.log(`  第 2 页（since=${page1[page1.length - 1]?.id}）: ${page2.entries.length} 条`)
  for (const e of page2.entries.slice(0, PAGE_SIZE)) {
    const text =
      "text" in e && typeof (e as { text?: unknown }).text === "string"
        ? JSON.stringify((e as { text: string }).text).slice(0, 80)
        : ""
    console.log(`    [${e.type}] id=${e.id}${text ? ` text=${text}` : ""}`)
  }
  const messageEntries = all.entries.filter((e) => e.type === "message")
  console.log(`  会话消息条目共 ${messageEntries.length} 条（type=message）`)
  const firstUser = messageEntries.find((e) => (e as { message?: { role?: string } }).message?.role === "user")
  if (firstUser) {
    console.log(`  首条用户消息样本: ${JSON.stringify(firstUser).slice(0, 300)}`)
  }

  await stopAndVerify(client, "反向")

  const after = { sha: sha256(candidate.path), size: statSync(candidate.path).size }
  const mutated = before.sha !== after.sha
  console.log(
    `  只读核对: sha256 前=${before.sha.slice(0, 12)} 后=${after.sha.slice(0, 12)} -> ${mutated ? "文件内容有变化（如实记录）" : "未变化"}`,
  )
  console.log(`  反向 PASS：终端创建的既有会话 ${candidate.id} 经 RPC 分页读取成功`)
}

// ---------------------------------------------------------------- 主流程
async function main(): Promise<void> {
  console.log("=== P0-4 HOME/cwd 数据一致性验证 ===")
  console.log(`HOME=${HOME}`)
  console.log(`OMO_CODING_AGENT_DIR=${AGENT_DIR}`)
  console.log(`omo-ai=${omoVersion}  引擎 @code-yeongyu/senpi=${senpiVersion}`)
  console.log(`senpiCli=${senpiCli}`)
  console.log(`测试模型=${MODEL_PROVIDER}/${MODEL_ID}（低 thinking 档，短 prompt）`)
  console.log(`store 存在性: ${join(AGENT_DIR, "sessions")} -> ${existsSync(join(AGENT_DIR, "sessions"))}`)

  await forward()
  await reverse()

  console.log("\n=== P0-4 双向引擎侧操作全部完成（终端侧确认见 bash 步骤与 verification 文档） ===")
}

main().catch(async (error) => {
  // 失败路径同样必须清干净引擎子进程，再以非零码退出（P0-4 FAILED 语义）
  for (const client of activeClients) {
    try {
      await client.stop()
    } catch {
      // 忽略停止失败，交给 bash 步骤按 PID 复核
    }
  }
  console.error(`P0-4 FAILED: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
