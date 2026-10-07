/**
 * W2 后续加固诊断 spike：引擎个别回合收尾 wire 事件缺席（todo 16 实测）根因定位。
 *
 * 两阶段：
 *   A. 基线批量：单会话连发 12 个短 prompt，逐回合记录事件尾形态
 *      （agent_end / agent_settled / turn_end / assistant message_end 是否到齐），
 *      结束时 get_state 复核 isStreaming——区分「引擎没发」vs「桥丢了」。
 *   B. 切换压力：回合进行中 open 另一会话（webui 切聊天就是 open_session 切焦点），
 *      观察原会话收尾事件是否仍投递（todo 16 缺席发生在"已恢复继续"场景的猜想）。
 *      注意：切焦点后 get_state 反映的是焦点会话（B），A 的判定以收尾事件是否到达为准。
 *
 * 运行：bun run server/spike/w2-wire-repro.ts
 * 模型：zai-coding-cn/glm-5.3-flash，thinking low（token 预算规则）。
 */

import { mkdirSync } from "node:fs"
import { RpcClient } from "@code-yeongyu/senpi"
import { SenpiAdapter, type SenpiRpcClient } from "../src/adapter/senpi-adapter"

const AGENT_DIR = "/root/.pi/agent"
const PROVIDER = "zai-coding-cn"
const MODEL = "glm-5.3-flash"
const PROJ_DIR = "/tmp/opencode/w2-wire-repro"
const ROUND_TIMEOUT_MS = 45_000

interface Collected {
  types: string[]
  agentEnd: boolean
  agentSettled: boolean
  turnEnd: boolean
  assistantMessageEnd: boolean
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

function newSeen(): Collected {
  return { types: [], agentEnd: false, agentSettled: false, turnEnd: false, assistantMessageEnd: false }
}

function collectInto(seen: Collected) {
  return (event: { type?: string; message?: { role?: string }; [k: string]: unknown }): void => {
    const type = typeof event.type === "string" ? event.type : "?"
    seen.types.push(type)
    if (type === "agent_end") seen.agentEnd = true
    if (type === "agent_settled") seen.agentSettled = true
    if (type === "turn_end") seen.turnEnd = true
    if (type === "message_end" && event.message && (event.message as { role?: string }).role === "assistant") {
      seen.assistantMessageEnd = true
    }
  }
}

async function getState(captured: RpcClient): Promise<string> {
  const raw = captured as unknown as { getState?: () => Promise<Record<string, unknown>> }
  if (typeof raw.getState !== "function") return "get_state 不可用"
  try {
    const state = await raw.getState()
    return `isStreaming=${String(state.isStreaming)} msgCount=${String(state.messageCount)}`
  } catch (err) {
    return `get_state 失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** 等一回合收尾（agent_end 或 agent_settled）；到点未到即记缺席。始终退订。 */
async function waitRound(
  seen: Collected,
  subscription: { unsubscribe(): void },
  label: string,
  captured: RpcClient,
): Promise<boolean> {
  const deadline = Date.now() + ROUND_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (seen.agentEnd || seen.agentSettled) break
    await Bun.sleep(200)
  }
  const settled = seen.agentEnd || seen.agentSettled
  subscription.unsubscribe()
  const state = settled ? "" : ` | get_state(焦点会话): ${await getState(captured)}`
  console.log(
    `[${label}] settled=${settled} agent_end=${seen.agentEnd} agent_settled=${seen.agentSettled} turn_end=${seen.turnEnd} assistant_msg_end=${seen.assistantMessageEnd}${state}`,
  )
  if (!settled) {
    console.log(`  收尾缺席！事件序列：${seen.types.join(",")}`)
  }
  return settled
}

async function main(): Promise<void> {
  mkdirSync(PROJ_DIR, { recursive: true })
  let captured: RpcClient | null = null
  const adapter = new SenpiAdapter({
    projectDir: PROJ_DIR,
    agentDir: AGENT_DIR,
    provider: PROVIDER,
    modelId: MODEL,
    clientFactory: (o) => {
      captured = new RpcClient(o)
      return captured as unknown as SenpiRpcClient
    },
  })
  await adapter.start()
  const client = captured as RpcClient
  console.log(`引擎就绪（项目 ${PROJ_DIR}）`)

  // ---- A. 基线批量：单会话 12 回合 ----
  section("A. 基线批量（单会话 12 回合）")
  const opened = await adapter.openSession({ provider: PROVIDER, modelId: MODEL, thinkingLevel: "low" })
  console.log(`会话 ${opened.sessionId} path=${opened.sessionPath}`)
  let baselineMissing = 0
  for (let i = 1; i <= 12; i++) {
    const seen = newSeen()
    const sub = adapter.events(collectInto(seen))
    await adapter.prompt({ text: `只回复两个字：就绪${i}` })
    const ok = await waitRound(seen, sub, `A#${i}`, client)
    if (!ok) baselineMissing++
    await Bun.sleep(500)
  }
  console.log(`基线缺席率：${baselineMissing}/12`)

  // ---- B. 切换压力：回合进行中切焦点到另一会话 ----
  section("B. 切换压力（回合进行中 open 另一会话切焦点）")
  const pathA = opened.sessionPath
  const switchMissing: number[] = []
  for (let i = 1; i <= 4; i++) {
    const seen = newSeen()
    const sub = adapter.events(collectInto(seen))
    await adapter.prompt({ text: `从 1 数到 20，每个数字单独一行（第 ${i} 次）` })
    await Bun.sleep(1500)
    // 回合进行中切焦点：同一连接 open 新会话 B（webui 切聊天同款操作）
    const b = await adapter.openSession({ provider: PROVIDER, modelId: MODEL, thinkingLevel: "low" })
    console.log(`[B#${i}] 已切焦点 → 会话 ${b.sessionId}（A 流式中，观察 A 收尾是否投递）`)
    const ok = await waitRound(seen, sub, `B#${i}`, client)
    if (!ok) switchMissing.push(i)
    // 切回 A 再跑下一轮
    await adapter.openSession({ sessionPath: pathA })
    await Bun.sleep(500)
  }
  console.log(`切换缺席：${switchMissing.length}/4（轮次 ${switchMissing.join(",") || "无"}）`)

  await adapter.stop()
  section("结论")
  console.log(`基线缺席 ${baselineMissing}/12；切换压力缺席 ${switchMissing.length}/4`)
  process.exit(0)
}

main().catch((err) => {
  console.error("spike 失败：", err)
  process.exit(1)
})
