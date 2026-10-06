/**
 * SenpiAdapter 真实引擎冒烟（todo 7 QA）：sessions.list + messages + prompt + abort。
 * 运行：cd /data/projects/senpi-webui && bun run server/spike/adapter-smoke.ts
 * 证据：.omo/qa/W2/adapter-smoke.log
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SenpiAdapter } from "../src/adapter/senpi-adapter"
import type { EngineEvent } from "../src/adapter/engine-adapter"

const AGENT_DIR = "/root/.pi/agent"
const PROJ_DIR = "/tmp/opencode/w2-7-proj"
const LOG_PATH = "/data/projects/senpi-webui/.omo/qa/W2/adapter-smoke.log"

const lines: string[] = []
function log(s: string): void {
  console.log(s)
  lines.push(s)
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

async function main(): Promise<number> {
  mkdirSync(join(PROJ_DIR), { recursive: true })
  log(`=== SenpiAdapter 真实引擎冒烟 ${new Date().toISOString()} ===`)
  log(`模型=zai-coding-cn/glm-5.3-flash thinking=low cwd=${PROJ_DIR}`)

  const adapter = new SenpiAdapter({
    projectDir: PROJ_DIR,
    agentDir: AGENT_DIR,
    provider: "zai-coding-cn",
    modelId: "glm-5.3-flash",
  })
  log(`capabilities=${JSON.stringify(adapter.capabilities)}`)

  // 1) sessions.list（SDK 直读，含 fork 血缘）
  const sessions = await adapter.sessionsList(PROJ_DIR)
  log(`[1] sessionsList=${sessions.length} 行；含 parentSessionPath=${sessions.filter((s) => s.parentSessionPath).length} 行`)

  // 2) 启动引擎 + 打开新会话
  const t0 = Date.now()
  await adapter.start()
  log(`[2] start 就绪（${Date.now() - t0}ms）`)
  const active = await adapter.openSession({ provider: "zai-coding-cn", modelId: "glm-5.3-flash", thinkingLevel: "low" })
  log(`[2] openSession durable=${active.sessionId} path=${active.sessionPath}`)

  // 3) prompt + 流式事件 + 落定
  const events: EngineEvent[] = []
  adapter.events((e) => events.push(e))
  const mark = events.length
  const receipt = await adapter.prompt({ text: "回复：OK", thinkingLevel: "low" })
  log(`[3] prompt disposition=${receipt.disposition}`)
  await withTimeout(
    (async () => {
      for (;;) {
        if (events.slice(mark).some((e) => e.type === "agent_settled")) return
        await new Promise((r) => setTimeout(r, 100))
      }
    })(),
    180000,
    "agent_settled",
  )
  const updates = events.slice(mark).filter((e) => e.type === "message_update").length
  log(`[3] 事件流：message_update=${updates} agent_settled=${events.slice(mark).filter((e) => e.type === "agent_settled").length}`)

  // 4) messages 分页 + 游标
  const page1 = await adapter.messages()
  log(`[4] messages=${page1.entries.length} 条 leafId=${page1.leafId} cursor=${page1.cursor}`)
  const page2 = await adapter.messages(page1.cursor ?? undefined)
  log(`[4] messages(cursor) 增量=${page2.entries.length} 条（0=游标语义成立）`)
  const userMsg = page1.entries.find((e) => JSON.stringify(e).includes('"role":"user"'))
  log(`[4] 首条 user entry 含 prompt 文本=${JSON.stringify(userMsg).includes("回复：OK")}`)

  // 5) abort：运行中打断
  const mark2 = events.length
  void adapter.prompt({ text: "请从 1 数到 40，每个数字单独一行，不要任何解释", thinkingLevel: "low" }).catch(() => undefined)
  for (;;) {
    if (events.slice(mark2).some((e) => e.type === "message_update")) break
    await new Promise((r) => setTimeout(r, 100))
  }
  await withTimeout(adapter.abort(), 20000, "abort")
  for (;;) {
    if (events.slice(mark2).some((e) => e.type === "agent_end")) break
    await new Promise((r) => setTimeout(r, 100))
  }
  const halfUpdates = events.slice(mark2).filter((e) => e.type === "message_update").length
  log(`[5] abort：中断前 message_update=${halfUpdates}，agent_end 已到`)

  // 6) 附带面：usage / todo / 模型 / thinking 档
  const usage = await adapter.usage()
  log(`[6] usage: totalTokens=${usage.tokens.total} cost=${usage.cost.toFixed(6)} contextUsage=${usage.contextUsage?.percent?.toFixed(2)}%`)
  const todo = await adapter.todoState()
  log(`[6] todoState=${todo ? `${todo.phases.length} phase(s)` : "null（本会话未用 todo 工具）"}`)
  const models = await adapter.modelsList()
  log(`[6] modelsList=${models.length} 条（首条 ${models[0]?.provider}/${models[0]?.id}）`)
  log(`[6] thinkingLevels=${JSON.stringify(await adapter.thinkingLevels())}`)

  // 7) 收尾
  await adapter.closeSession()
  await adapter.stop()
  log(`[7] closeSession + stop 完成`)
  log("=== SMOKE PASS ===")
  return 0
}

main()
  .then((code) => {
    mkdirSync("/data/projects/senpi-webui/.omo/qa/W2", { recursive: true })
    writeFileSync(LOG_PATH, lines.join("\n") + "\n")
    process.exit(code)
  })
  .catch((e) => {
    log(`SMOKE FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    mkdirSync("/data/projects/senpi-webui/.omo/qa/W2", { recursive: true })
    writeFileSync(LOG_PATH, lines.join("\n") + "\n")
    process.exit(2)
  })
