/**
 * Q1 提问卡片（ask_user_question）wire 往返验证 spike。
 *
 * 目标：对真实 omo/senpi 引擎（RPC 模式）实证 method:"question" 的
 * extension_ui_request 全生命周期，为 webUI 提问卡片开发锁定协议事实：
 *
 *  - r1 waitForAnswer=true：帧到达（字段齐全 + sessionId 归属）、未应答时回合
 *    阻塞、应答 {answers, comment} 后 question_resolved(outcome=answered)、
 *    回合继续落定、工具结果携带答案；
 *  - r2 waitForAnswer=false：帧到达后回合照常 agent_settled（跨回合存活）、
 *    getState().pendingQuestions 快照包含未决问题、应答后 question_resolved、
 *    答案以 user message 形态回投并触发新回合；
 *  - r3 多问题 + multiSelect：一次 ask 携带两问（其一 multiSelect=true），
 *    应答 answers 键为 question.id、selected 为 label 数组；
 *  - r4 取消路径：应答 {cancelled:true} → question_resolved(outcome=cancelled)，
 *    回合以"用户未答"语义继续。
 *
 * 运行：node spike/q1-question.ts [round1,round2,...]（server/ 目录下）
 * 证据：事件流水与汇总 JSON 落 /tmp/opencode/q1-proj/。
 */

import { RpcClient } from "@code-yeongyu/senpi"
import type { RpcExtensionUIResponse } from "@code-yeongyu/senpi"
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, "..", "..")
const OMO_BIN = join(REPO_ROOT, "node_modules", "omo-ai", "bin", "omo.js")

const PROJECT_DIR = "/tmp/opencode/q1-proj"
const AGENT_DIR = "/root/.pi/agent"
const PROVIDER = "zai-coding-cn"
const MODEL = "glm-5.3-flash"

interface QuestionFrame {
  type: "extension_ui_request"
  method: "question"
  id: string
  sessionId?: string
  requestId: string
  toolCallId: string
  waitForAnswer: boolean
  questions: Array<{
    id: string
    header: string
    question: string
    options: Array<{ label: string; description?: string }>
    multiSelect: boolean
  }>
  timeout: number
  askedAtMs: number
  deadlineAtMs: number
  remainingMs: number
}

interface Record_ {
  t: number
  dir: "event" | "send" | "info" | "error"
  payload: unknown
}

const transcript: Record_[] = []
const transcriptPath = join(PROJECT_DIR, "q1-transcript.jsonl")

function log(dir: Record_["dir"], payload: unknown) {
  const rec = { t: Date.now(), dir, payload }
  transcript.push(rec)
  appendFileSync(transcriptPath, JSON.stringify(rec) + "\n")
  if (dir === "error") console.error("[spike:error]", JSON.stringify(payload).slice(0, 500))
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

mkdirSync(PROJECT_DIR, { recursive: true })
writeFileSync(transcriptPath, "")

let questionResolve: ((frame: QuestionFrame) => void) | null = null
let settledResolve: (() => void) | null = null
const resolvedOutcomes: Array<{ id: string; outcome: string }> = []
let startedResolve: (() => void) | null = null

async function main() {
  const only = process.argv[2]?.split(",").filter(Boolean)
  const want = (id: string) => !only || only.includes(id)

  const client = new RpcClient({
    cliPath: OMO_BIN,
    cwd: PROJECT_DIR,
    provider: PROVIDER,
    model: MODEL,
    env: {
      OMO_RUNTIME: "node",
      OMO_CODING_AGENT_DIR: AGENT_DIR,
      // stdio 宿主的能力通道（rpc-mode.js:130）：set_client_info 对 stdio 连接是
      // 静默空操作（session-command-router 无 currentConnection 直接返回 success），
      // 能力只能经此 env 下发（逗号分隔）
      SENPI_RPC_CLIENT_CAPABILITIES: "question",
    },
    args: ["--thinking", "low", "--multi-session"],
  })

  const summary: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    spawn: { cliPath: OMO_BIN, cwd: PROJECT_DIR, provider: PROVIDER, model: MODEL },
    rounds: {},
  }

  client.onEvent((event) => {
    const anyEvent = event as unknown as { type?: string; method?: string; id?: string; outcome?: string; sessionId?: string }
    log("event", event)
    if (anyEvent.type === "extension_ui_request" && anyEvent.method === "question" && questionResolve) {
      const resolve = questionResolve
      questionResolve = null
      resolve(event as unknown as QuestionFrame)
    }
    if (anyEvent.type === "question_resolved" && typeof anyEvent.id === "string") {
      resolvedOutcomes.push({ id: anyEvent.id, outcome: String(anyEvent.outcome) })
    }
    if (anyEvent.type === "agent_settled" && settledResolve) {
      const resolve = settledResolve
      settledResolve = null
      resolve()
    }
    if (anyEvent.type === "agent_start" && startedResolve) {
      const resolve = startedResolve
      startedResolve = null
      resolve()
    }
  })

  await client.start()
  // set_client_info 在 stdio 宿主上被静默丢弃（见上方 env 注释），保留仅为
  // 未来 socket 形态兼容；实际能力声明走 SENPI_RPC_CLIENT_CAPABILITIES
  await client.setClientInfo(80, ["question"])
  // multi-session 模式（与生产同构）：显式 open_session，routing handle 会以
  // tagSessionRecord 打进每帧 sessionId（前端按会话路由依赖它）
  const opened = await client.openSession({ provider: PROVIDER, modelId: MODEL })
  log("info", { step: "openSession", sessionId: opened.sessionId, stderrTail: client.getStderr().slice(-300) })
  log("info", { step: "started" })

  function waitQuestion(timeoutMs: number): Promise<QuestionFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        questionResolve = null
        reject(new Error(`等待 question 帧超时（${timeoutMs}ms）`))
      }, timeoutMs)
      questionResolve = (frame) => {
        clearTimeout(timer)
        resolve(frame)
      }
    })
  }

  function waitSettled(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (settledResolve !== null) settledResolve = null
        resolve(false)
      }, timeoutMs)
      settledResolve = () => {
        clearTimeout(timer)
        resolve(true)
      }
    })
  }

  function waitStarted(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (startedResolve !== null) startedResolve = null
        resolve(false)
      }, timeoutMs)
      startedResolve = () => {
        clearTimeout(timer)
        resolve(true)
      }
    })
  }

  async function respond(frameId: string, payload: Record<string, unknown>) {
    const reply = { type: "extension_ui_response" as const, id: frameId, ...payload }
    log("send", reply)
    await client.sendExtensionUIResponse(reply as RpcExtensionUIResponse)
  }

  async function runRound(id: string, fn: () => Promise<Record<string, unknown>>) {
    if (!want(id)) return
    console.log(`\n===== round ${id} =====`)
    try {
      const detail = await fn()
      ;(summary.rounds as Record<string, unknown>)[id] = { ok: true, ...detail }
      console.log(`[round ${id}] OK`, JSON.stringify(detail).slice(0, 400))
    } catch (error) {
      ;(summary.rounds as Record<string, unknown>)[id] = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
      console.error(`[round ${id}] FAIL:`, error instanceof Error ? error.message : error)
    }
  }

  /** 帧字段完整性断言（返回观测记录，不抛错由调用方决定严不严） */
  function frameShape(frame: QuestionFrame) {
    return {
      id: frame.id,
      hasSessionId: typeof frame.sessionId === "string" && frame.sessionId.length > 0,
      hasToolCallId: typeof frame.toolCallId === "string",
      waitForAnswer: frame.waitForAnswer,
      questions: frame.questions.map((q) => ({
        id: q.id,
        header: q.header,
        optionsCount: q.options.length,
        multiSelect: q.multiSelect,
        labels: q.options.map((o) => o.label),
      })),
      timeoutMs: frame.timeout,
      deadlineAheadMs: frame.deadlineAtMs - Date.now(),
    }
  }

  // ---- r1：waitForAnswer=true 阻塞语义 + 应答闭环 ----
  await runRound("r1-wait-blocking", async () => {
    await client.prompt(
      "Use the ask_user_question tool now with waitForAnswer=true and exactly one question: header 'Deploy' (6 chars), question 'Which environment should we deploy to?', options 'staging' and 'production', multiSelect=false. Do not create todos, do not do anything else, do not explain. Just call the tool and wait.",
    )
    const frame = await waitQuestion(300_000)
    const shape = frameShape(frame)
    if (!frame.waitForAnswer) throw new Error(`预期 waitForAnswer=true，实际 false`)
    if (!shape.hasSessionId) throw new Error("question 帧缺少 sessionId 字段")
    // 未应答观察窗口：回合应阻塞（无 agent_settled）
    const silent = await waitSettled(15_000)
    if (silent) throw new Error("waitForAnswer=true 未应答时回合却落定了")
    // getState 对账源：pendingQuestions 应含本帧
    const state = await client.getState()
    const pending = (state as unknown as { pendingQuestions?: unknown[] }).pendingQuestions ?? []
    const inSnapshot = pending.some((p) => (p as { id?: string }).id === frame.id)
    await respond(frame.id, {
      answers: { [frame.questions[0].id]: { selected: [frame.questions[0].options[0].label] } },
      comment: "spike r1: staging please",
    })
    const settled = await waitSettled(240_000)
    if (!settled) throw new Error("应答后 240s 内未 agent_settled")
    const outcome = resolvedOutcomes.find((o) => o.id === frame.id)
    return {
      frame: shape,
      pendingInStateSnapshot: inSnapshot,
      blockedWhileUnanswered: true,
      resolvedOutcome: outcome ?? null,
      assistantText: (await client.getLastAssistantText())?.slice(0, 160) ?? null,
    }
  })

  // ---- r2：waitForAnswer=false 跨回合存活 + 答案回投触发新回合 ----
  await runRound("r2-nonwait-crossturn", async () => {
    // 上一轮可能仍有未决问题挂着（waitForAnswer=true 已应答落定，此处防御性等落定）
    await waitSettled(30_000)
    await client.prompt(
      "Use the ask_user_question tool now with waitForAnswer=false and exactly one question: header 'Color' (5 chars), question 'Which color for the logo?', options 'red' and 'blue', multiSelect=false. Do not create todos, do not explain. After the tool call returns, reply with exactly 'ASKED' and finish.",
    )
    const frame = await waitQuestion(300_000)
    const shape = frameShape(frame)
    if (frame.waitForAnswer) throw new Error(`预期 waitForAnswer=false，实际 true`)
    // 回合应照常落定（问题挂着不阻塞）
    const settledWhileOpen = await waitSettled(240_000)
    if (!settledWhileOpen) throw new Error("waitForAnswer=false 时回合 240s 内未落定")
    // 快照确认未决
    const state = await client.getState()
    const pending = (state as unknown as { pendingQuestions?: unknown[] }).pendingQuestions ?? []
    const inSnapshot = pending.some((p) => (p as { id?: string }).id === frame.id)
    await respond(frame.id, {
      answers: { [frame.questions[0].id]: { selected: [frame.questions[0].options[1].label] } },
    })
    // question_resolved 应到达
    await sleep(5_000)
    const outcome = resolvedOutcomes.find((o) => o.id === frame.id)
    if (!outcome) throw new Error("应答后未见 question_resolved")
    // 答案以 user message 回投 → 新回合启动
    const newTurn = await waitStarted(60_000)
    const settledAgain = await waitSettled(240_000)
    return {
      frame: shape,
      settledWhileOpen,
      pendingInStateSnapshot: inSnapshot,
      resolvedOutcome: outcome,
      answerDeliveredAsNewTurn: newTurn,
      settledAfterDelivery: settledAgain,
      assistantTextAfterDelivery: (await client.getLastAssistantText())?.slice(0, 160) ?? null,
    }
  })

  // ---- r3：多问题 + multiSelect ----
  await runRound("r3-multi-questions", async () => {
    await client.prompt(
      "Use the ask_user_question tool now with waitForAnswer=true and exactly two questions: (1) header 'Framework', question 'Which framework?', options 'react' and 'vue', multiSelect=false; (2) header 'Features', question 'Which features to include?', options 'auth', 'dark-mode' and 'i18n', multiSelect=true. Do not create todos, do not explain. Call the tool and wait.",
    )
    const frame = await waitQuestion(300_000)
    const shape = frameShape(frame)
    if (frame.questions.length !== 2) throw new Error(`预期 2 个问题，实际 ${frame.questions.length}`)
    const multi = frame.questions.find((q) => q.multiSelect)
    if (!multi) throw new Error("未见 multiSelect=true 的问题")
    const answers: Record<string, { selected: string[] }> = {}
    for (const q of frame.questions) {
      // multiSelect 挑两项，单选挑第一项
      answers[q.id] = { selected: q.multiSelect ? q.options.slice(0, 2).map((o) => o.label) : [q.options[0].label] }
    }
    await respond(frame.id, { answers })
    const settled = await waitSettled(240_000)
    if (!settled) throw new Error("应答后 240s 内未落定")
    const outcome = resolvedOutcomes.find((o) => o.id === frame.id)
    return { frame: shape, answered: answers, resolvedOutcome: outcome ?? null }
  })

  // ---- r4：取消路径 ----
  await runRound("r4-cancel", async () => {
    await client.prompt(
      "Use the ask_user_question tool now with waitForAnswer=true and exactly one question: header 'Retry' (5 chars), question 'Retry the failed deploy?', options 'yes' and 'no', multiSelect=false. Do not create todos, do not explain. Call the tool and wait.",
    )
    const frame = await waitQuestion(300_000)
    const shape = frameShape(frame)
    await respond(frame.id, { cancelled: true })
    const settled = await waitSettled(240_000)
    if (!settled) throw new Error("取消后 240s 内未落定")
    await sleep(3_000)
    const outcome = resolvedOutcomes.find((o) => o.id === frame.id)
    if (outcome && outcome.outcome !== "cancelled") {
      throw new Error(`取消后期望 outcome=cancelled，实际 ${outcome.outcome}`)
    }
    return { frame: shape, resolvedOutcome: outcome ?? null }
  })

  await client.stop()
  log("info", { step: "stopped" })

  const rounds = summary.rounds as Record<string, { ok: boolean }>
  const finalSummary = {
    ...summary,
    finishedAt: new Date().toISOString(),
    resolvedOutcomes,
    allPassed: Object.values(rounds).every((r) => r.ok),
  }
  writeFileSync(join(PROJECT_DIR, "q1-summary.json"), JSON.stringify(finalSummary, null, 2))
  console.log("\n===== summary =====")
  console.log(JSON.stringify(finalSummary, null, 2))
  process.exit(finalSummary.allPassed ? 0 : 1)
}

main().catch((error) => {
  console.error("[spike:fatal]", error)
  process.exitCode = 1
})
