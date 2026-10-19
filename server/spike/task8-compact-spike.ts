/**
 * docs08-r5 任务 8 spike：/compact 通道实测（隔离实例，零污染真实会话库）。
 *
 * 用法：cd /data/projects/senpi-webui && bun server/spike/task8-compact-spike.ts <evidenceDir>
 * 通道假设：RpcClient.compact(customInstructions?) -> 引擎 {type:"compact"} RPC ->
 * session.compact()（agent-session.js "manual entry point used by /compact, RPC, and extensions"）。
 * 验证四件事：
 * 1. get_commands 枚举（隔离实例重核）：是否含 compact（预期不含——枚举源只收
 *    extension/prompts/skills，rpc-command-surface.js）。
 * 2. 真实压缩：构造 >keepRecentTokens(20000) 上下文后调 compact()，对比前后
 *    getSessionStats().contextUsage 水位 + CompactionResult.tokensBefore。
 * 3. 落盘证据：getEntries() 出现 type:"compaction" 条目。
 * 4. 失败形态：紧凑后二次 compact -> "Already compacted" 错误消息（端点映射依据）。
 * 教训（首跑）：必须用类型化 openSession——RpcClient 客户端内部记录 routing sessionId
 * 并自动附加到后续命令；裸 send({type:"open_session"}) 不登记，get_commands 被拒
 * missing_session_id（与 adapter 注释「需活跃会话」同源）。
 */
import { RpcClient } from "@code-yeongyu/senpi"
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const evidenceDir = process.argv[2] ?? "/tmp/ul-omo-webui-task8/evidence"
const workDir = "/tmp/ul-omo-webui-task8"
const agentDir = join(workDir, "agent")
const projectDir = join(workDir, "project")
const realAgent = join(process.env.HOME ?? "/root", ".omo", "agent")
const cliPath = "/data/projects/senpi-webui/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js"
const pluginDir = "/data/projects/senpi-webui/node_modules/omo-ai/plugin"

const log: string[] = []
const say = (line: string) => {
  console.log(line)
  log.push(line)
}

rmSync(workDir, { recursive: true, force: true })
mkdirSync(agentDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
mkdirSync(evidenceDir, { recursive: true })
for (const f of ["auth.json", "models.json", "models-store.json"]) {
  try {
    cpSync(join(realAgent, f), join(agentDir, f))
    say(`copied ${f}`)
  } catch {
    say(`MISSING ${f} (跳过)`)
  }
}
// 重试设置压缩（spike 专用）：真实 settings 的 maxRetries=50 + probeBackMaxMs 6h
// 会在 provider 抖动时把回合挂起极长时间；spike 只需快速失败重试。
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ retry: { enabled: true, maxRetries: 6, probeBackMaxMs: 20000 } }),
)
say("settings.json 已重写（spike 快速失败重试）")

const client = new RpcClient({
  cliPath,
  cwd: projectDir,
  args: ["--extension", pluginDir, "--multi-session"],
  env: {
    OMO_CODING_AGENT_DIR: agentDir,
    SENPI_CODING_AGENT_DIR: agentDir,
    OMO_NATIVE: "1",
    PI_OFFLINE: "1",
  } as Record<string, string>,
})

interface CtxUsage {
  tokens?: number
  contextWindow?: number
  percent?: number
}

let exitCode = 0
const eventLog: string[] = []
let settleWaiters: Array<() => void> = []
try {
  await client.start()
  // 就绪轮询（verification/03 坑 1）；send 为类内私有，与 adapter 同款结构转型
  const rawSend = (client as unknown as { send: (m: unknown) => Promise<{ success?: boolean; data?: unknown }> }).send.bind(client)
  let ready = false
  for (let i = 1; i <= 20; i++) {
    try {
      const info = await rawSend({ type: "get_protocol_info" })
      if (info?.success) {
        ready = true
        say(`PROTOCOL-INFO ${JSON.stringify(info.data).slice(0, 300)}`)
        break
      }
    } catch {
      /* 继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!ready) throw new Error("引擎就绪探测失败")

  // 类型化 openSession（客户端登记 routing sessionId；默认模型链走 settings.json）
  const opened = (await (client as unknown as {
    openSession: (o?: { provider?: string; modelId?: string }) => Promise<{ sessionId?: string; state?: { sessionId?: string; sessionFile?: string } }>
  }).openSession()) as { sessionId?: string; state?: { sessionId?: string; sessionFile?: string } }
  say(`OPEN-SESSION routing=${opened.sessionId} durable=${opened.state?.sessionId} file=${opened.state?.sessionFile}`)

  // 1) get_commands 枚举重核
  const cmds = (await (client as unknown as { getCommands: () => Promise<Array<Record<string, unknown>>> }).getCommands()) as Array<Record<string, unknown>>
  const names = cmds.map((c) => String(c.name ?? ""))
  say(`GET-COMMANDS count=${cmds.length}`)
  say(`GET-COMMANDS has-compact=${names.includes("compact")}`)
  writeFileSync(join(evidenceDir, "get-commands.json"), JSON.stringify(cmds, null, 2))

  // 思考档选最低（构造上下文不需要思考；glm 系实测无 off，最低 low）
  let levels: string[] = []
  try {
    levels = (await (client as unknown as { getAvailableThinkingLevels: () => Promise<string[]> }).getAvailableThinkingLevels()) as string[]
  } catch { /* 忽略 */ }
  say(`THINKING-LEVELS ${JSON.stringify(levels)}`)
  const level = levels.includes("low") ? "low" : undefined

  // 事件流全程记录（compaction_start/end 帧也是证据；agent_settled 用于回合收尾等待）；
  // 自动应答引擎 UI 对话框（首跑迁移向导 select 等会阻塞 prompt 落定——verification/02
  // 结论 4「prompt 响应拖到对话框落定」；spike 无人工，取首选项/确认/空文本自动过）。
  ;(client as unknown as { onEvent: (l: (e: Record<string, unknown>) => void) => void }).onEvent((e) => {
    const type = String(e.type ?? "")
    eventLog.push(`${new Date().toISOString()} ${type} ${JSON.stringify(e).slice(0, 200)}`)
    if (type === "agent_settled" || type === "agent_end" || type === "agent_idle") {
      for (const w of settleWaiters.splice(0)) w()
    }
    if (type === "extension_ui_request") {
      const method = String((e as { method?: unknown }).method ?? "")
      const id = (e as { id?: unknown }).id
      if (typeof id !== "string" || !id) return
      let reply: Record<string, unknown> | null = null
      if (method === "select") {
        const options = (e as { options?: unknown }).options
        const first = Array.isArray(options) ? (options[0] as { label?: unknown } | string | undefined) : undefined
        const label = typeof first === "string" ? first : (first as { label?: unknown } | undefined)?.label
        if (typeof label === "string") reply = { type: "extension_ui_response", id, value: label }
      } else if (method === "confirm") {
        reply = { type: "extension_ui_response", id, confirmed: false }
      } else if (method === "input" || method === "editor") {
        reply = { type: "extension_ui_response", id, value: "" }
      }
      if (reply) {
        say(`UI-DIALOG-AUTO-REPLY method=${method} id=${id.slice(0, 8)}`)
        void (client as unknown as { sendExtensionUIResponse: (r: Record<string, unknown>) => Promise<void> }).sendExtensionUIResponse(reply).catch(() => {})
      }
    }
  })

  /** 等 agent_settled（上限 timeoutMs）；返回是否等到 */
  const waitSettle = (timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        settleWaiters = settleWaiters.filter((w) => w !== done)
        resolve(false)
      }, timeoutMs)
      const done = () => {
        clearTimeout(timer)
        resolve(true)
      }
      settleWaiters.push(done)
    })

  /** prompt 韧性发送：ack 在 preflight 即回（回合仍在跑），超时/忙时降级等 settle。
   *  返回前必定等到 agent_settled——下一轮 prompt 与 stats 都需空闲态（标题生成
   *  回合也占用 processing，重试消化）。 */
  const promptResilient = async (text: string) => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await (client as unknown as { prompt: (m: string, o?: { thinkingLevel?: string }) => Promise<unknown> }).prompt(text, level ? { thinkingLevel: level } : undefined)
        await waitSettle(600_000)
        await new Promise((r) => setTimeout(r, 5000))
        return "ack"
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!message.includes("Timeout waiting for response") && !message.includes("already processing")) throw err
        say(`PROMPT-RETRY-${attempt}（${message.includes("already processing") ? "引擎忙（含标题生成回合）" : "RPC 30s 超时"}，等 settle 后重试）`)
        await waitSettle(300_000)
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
    throw new Error("prompt 四次重试后仍失败")
  }

  const stats = async (label: string) => {
    const raw = (await (client as unknown as { getSessionStats: () => Promise<Record<string, unknown>> }).getSessionStats()) as Record<string, unknown>
    const ctx = raw.contextUsage as CtxUsage | undefined
    say(`${label} contextUsage=${JSON.stringify(ctx)} tokens=${JSON.stringify(raw.tokens).slice(0, 160)}`)
    return raw
  }

  // 2) 构造 >keepRecentTokens(20000) 的可切分上下文：每轮 ~22KB 噪声（估 ~5.5k token）。
  //  教训（前几跑）：(a) 单轮巨块无条目可切（保留窗盖全部）→ 需 ≥3 轮交换；
  //  (b) provider 429 频率限流（zai code 1302）——轮间节流 60s，回合内 auto_retry 消化。
  const filler = (n: number) =>
    `这是压缩水位 spike 的填充材料第 ${n} 批。${"SENSIBLE-FILLER-TOKEN-0042 ".repeat(900)}\n收到后请只回复：第 ${n} 批已收到。`
  for (let round = 1; round <= 5; round++) {
    if (round > 1) {
      say(`PACING-60S（轮间节流避开频率限流窗口）`)
      await new Promise((r) => setTimeout(r, 60_000))
    }
    const how = await promptResilient(filler(round))
    const raw = (await (client as unknown as { getSessionStats: () => Promise<Record<string, unknown>> }).getSessionStats()) as Record<string, unknown>
    const ctx = raw.contextUsage as CtxUsage | undefined
    say(`ROUND-${round} via=${how} contextUsage=${JSON.stringify(ctx)}`)
    if (round >= 4 && ctx && typeof ctx.tokens === "number" && ctx.tokens > 30000) break
  }
  await stats("STATS-BEFORE")

  // 3) 真实压缩（前先等 5s 观察在途回合是否收尾：引擎 manual compact 会先 abort 活动回合）
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000)
    settleWaiters.push(() => {
      clearTimeout(timer)
      resolve()
    })
  })
  const compactSent = Date.now()
  const compactRes = await (client as unknown as { compact: () => Promise<unknown> }).compact()
  say(`COMPACT ms=${Date.now() - compactSent}`)
  say(`COMPACT-RESULT ${JSON.stringify(compactRes).slice(0, 1200)}`)
  writeFileSync(join(evidenceDir, "compact-result.json"), JSON.stringify(compactRes, null, 2))
  await stats("STATS-AFTER")

  // 4) 落盘证据：compaction 条目
  const entries = (await (client as unknown as { getEntries: () => Promise<{ entries: Array<{ type?: string; id?: string }> }> }).getEntries()) as { entries: Array<{ type?: string; id?: string }> }
  const compactionEntries = (entries.entries ?? []).filter((e) => e?.type === "compaction")
  say(`ENTRIES total=${entries.entries?.length ?? 0} compaction=${compactionEntries.length}`)
  say(`COMPACTION-ENTRY ${JSON.stringify(compactionEntries[0] ?? null).slice(0, 600)}`)

  // 5) 失败形态：无更多可压缩内容时再压
  try {
    const again = await (client as unknown as { compact: () => Promise<unknown> }).compact()
    say(`COMPACT-AGAIN resolved=${JSON.stringify(again).slice(0, 300)}`)
  } catch (err) {
    say(`COMPACT-AGAIN threw: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`)
  }

  say("SPIKE-DONE")
} catch (err) {
  say(`SPIKE-ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  exitCode = 1
} finally {
  try {
    writeFileSync(join(evidenceDir, "event-log.txt"), eventLog.join("\n") + "\n")
  } catch { /* 忽略 */ }
  try {
    await client.stop()
  } catch { /* 忽略 */ }
  writeFileSync(join(evidenceDir, "spike-log.txt"), log.join("\n") + "\n")
  // 清理隔离实例工作目录（证据已先落 evidenceDir）
  rmSync(workDir, { recursive: true, force: true })
  say("CLEANED")
}
process.exit(exitCode)
