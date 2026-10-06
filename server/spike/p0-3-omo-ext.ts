/**
 * P0-3: omo 扩展在纯 RPC 模式下的存活验证（docs/06 P0 第 3 条）
 *
 * 验证内容：
 * 1. spawn senpi --mode rpc 并挂 omo 扩展（--extension <omo-ai>/plugin，照 omo launcher 源码语义：
 *    bin/lib/launcher.js spawnSenpi 的 finalArgs = ["--extension", pluginRoot, ...args]）
 * 2. 枚举注册的工具列表与扩展命令（RPC 无原生 tools/list；工具清单从会话 system/assistant
 *    message 的 tools 字段 + getCommands() 扩展命令侧证）
 * 3. 确认 omo 的 todo/task/team 工具存在
 * 4. 触发一次 todo 工具调用，收结构化结果（toolcall 事件 + 工具结果留样）
 * 5. 观察 omo-senpi status UI 在 RPC 模式的 widget 形态（extension_ui_request
 *    method=setWidget 的 widgetLines 字符串数组）并留样
 *
 * 运行：bun run server/spike/p0-3-omo-ext.ts
 * 输出：stdout 摘要 + /tmp/opencode/p0-3-proj/p0-3-samples.json（完整样本）
 */
import { RpcClient } from "@code-yeongyu/senpi"
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const HOME = process.env.HOME ?? "/root"
const AGENT_DIR = `${HOME}/.pi/agent` // W1 spawn 规范（verification/00-env.md）
const OMO_ROOT = new URL("../node_modules/omo-ai/", import.meta.url).pathname
const PLUGIN_DIR = join(OMO_ROOT, "plugin")
// omo-ai@5.1.0 官配引擎（package.json 内锁 @code-yeongyu/senpi 2026.9.28-7，
// postinstall senpi-patch 已对它打 .omo-engine-prepared stamp = 5.1.0）。
// bun isolated 布局下它装在 .bun/omo-ai@5.1.0/node_modules/ 旁路，不走提升解析
// （createRequire 从 omo-ai 出发会被解析到根直锁的 2026.10.10，不是官配对）。
function resolveOmoSenpiCli(): string {
  const omoReal = realpathSync(OMO_ROOT) // .bun/omo-ai@5.1.0/node_modules/omo-ai
  const candidates = [
    join(omoReal, "..", "@code-yeongyu", "senpi", "dist", "bundle", "cli.js"),
    join(OMO_ROOT, "node_modules", "@code-yeongyu", "senpi", "dist", "bundle", "cli.js"),
  ]
  for (const cli of candidates) {
    if (existsSync(cli)) return cli
  }
  throw new Error(`omo-ai 官配 senpi bundle 缺失: ${candidates.join(" / ")}`)
}
const SENPI_CLI = resolveOmoSenpiCli()
const PROJ_DIR = "/tmp/opencode/p0-3-proj"
const PROVIDER = "zai-coding-cn"
const MODEL = "glm-5.3-flash"
const PROMPT_TIMEOUT_MS = 180_000
const READY_PROBES = 5

interface AnyEvent {
  type: string
  [k: string]: unknown
}

function truncate(v: unknown, max = 2000): unknown {
  const s = JSON.stringify(v)
  if (s === undefined) return String(v)
  if (s.length <= max) return v
  return `${s.slice(0, max)}...[truncated ${s.length} bytes total]`
}

// 工具调用相关事件的紧凑投影（留样用）
function projectToolEvent(e: AnyEvent): unknown {
  if (e.type === "message_update") {
    const ame = e.assistantMessageEvent as AnyEvent | undefined
    if (ame?.type === "toolcall_start") {
      return {
        type: "message_update/toolcall_start",
        raw: truncate(ame, 1200),
      }
    }
    return null
  }
  if (e.type === "tool_execution_start" || e.type === "tool_execution_end") {
    return { type: e.type, raw: truncate(e, 1500) }
  }
  if (e.type === "message_start" || e.type === "message_end") {
    const msg = e.message as AnyEvent | undefined
    if (msg?.role === "toolResult" || msg?.role === "tool_result") {
      return {
        type: e.type,
        role: msg.role,
        toolName: msg.toolName ?? msg.tool_name,
        raw: truncate(msg, 2500),
      }
    }
    const tools = msg?.tools as AnyEvent[] | undefined
    return {
      type: e.type,
      role: msg?.role,
      toolNames: tools?.map((t) => t.name) ?? undefined,
      toolsCount: tools?.length,
      stopReason: msg?.stopReason,
    }
  }
  return e
}

function pickToolResults(entries: AnyEvent[]): AnyEvent[] {
  // 工具执行结果是独立消息（role=toolResult），或在 assistant content 的结果块
  const out: AnyEvent[] = []
  for (const e of entries) {
    if (e.type !== "message_start" && e.type !== "message_end") continue
    const msg = e.message as AnyEvent | undefined
    if (!msg) continue
    if (msg.role === "toolResult" || msg.role === "tool_result") out.push(msg)
    if (msg.role === "assistant") {
      const content = msg.content as AnyEvent[] | undefined
      for (const block of content ?? []) {
        if (block.type === "toolResult" || block.type === "tool_result") out.push(block)
      }
    }
  }
  return out
}

async function waitUntilReady(client: RpcClient): Promise<Record<string, unknown> | null> {
  // 引擎冷启动（扩展 bundle + skills 扫描）可能超过单请求 30s deadline；
  // 超时的请求只会 reject 该次 pending，进程仍可用，故轮询重试。
  for (let i = 1; i <= READY_PROBES; i++) {
    try {
      const r = await (client as unknown as {
        send: (m: unknown) => Promise<AnyEvent>
      }).send({ type: "get_protocol_info" })
      if (r.success) {
        console.log(`[p0-3] 引擎就绪（第 ${i} 次探测）`)
        return r.data as Record<string, unknown>
      }
    } catch {
      console.log(`[p0-3] 就绪探测 ${i}/${READY_PROBES} 超时，重试...`)
    }
  }
  return null
}

async function main(): Promise<number> {
  mkdirSync(PROJ_DIR, { recursive: true })

  const report: Record<string, unknown> = {
    runAt: new Date().toISOString(),
    spawn: {
      cliPath: SENPI_CLI,
      args: [
        "--extension", PLUGIN_DIR, "--multi-session",
        "--provider", PROVIDER, "--model", MODEL,
      ],
      env: { OMO_CODING_AGENT_DIR: AGENT_DIR, SENPI_CODING_AGENT_DIR: AGENT_DIR, OMO_NATIVE: "1" },
      cwd: PROJ_DIR,
    },
  }

  const client = new RpcClient({
    cliPath: SENPI_CLI,
    cwd: PROJ_DIR,
    provider: PROVIDER,
    model: MODEL,
    args: ["--extension", PLUGIN_DIR, "--multi-session"],
    env: {
      OMO_CODING_AGENT_DIR: AGENT_DIR,
      SENPI_CODING_AGENT_DIR: AGENT_DIR,
      OMO_NATIVE: "1",
      PI_OFFLINE: "1",
    },
  })

  const events: AnyEvent[] = []
  const uiRequests: AnyEvent[] = []
  client.onEvent((e) => {
    const anyE = e as unknown as AnyEvent
    events.push(anyE)
    if (anyE.type === "extension_ui_request") uiRequests.push(anyE)
  })

  console.log(`[p0-3] spawn: node ${SENPI_CLI} --mode rpc --provider ${PROVIDER} --model ${MODEL}`)
  console.log(`[p0-3]        --extension ${PLUGIN_DIR}`)
  console.log(`[p0-3]        OMO_CODING_AGENT_DIR=${AGENT_DIR} cwd=${PROJ_DIR}`)

  await client.start()
  const proto = await waitUntilReady(client)
  report.protocolInfo = proto ? truncate(proto, 3000) : null
  if (proto) {
    const profile = (proto as AnyEvent).launch_profile as AnyEvent | undefined
    const exts = (profile?.core as AnyEvent | undefined)?.extensions
    console.log(`[p0-3] launch_profile.extensions: ${JSON.stringify(exts)}`)
    report.launchExtensions = exts
  } else {
    console.log("[p0-3] 引擎未就绪，放弃")
    await client.stop()
    return 1
  }

  const open = await client.openSession({ provider: PROVIDER, modelId: MODEL })
  console.log(`[p0-3] openSession: sessionId=${open.sessionId}`)
  report.sessionId = open.sessionId

  // ---- 1) 扩展命令枚举（omo 注册的 / 命令与 skills）----
  const commands = await client.getCommands()
  const cmdList = commands.map((c) => ({
    name: c.name,
    type: (c as unknown as AnyEvent).type,
    description: (c as unknown as AnyEvent).description,
  }))
  report.commands = { count: commands.length, list: cmdList }
  console.log(`[p0-3] getCommands: ${commands.length} 条`)
  for (const c of cmdList) console.log(`       - ${c.name} (${c.type})`)

  // ---- 2) prompt 前 UI 事件（启动阶段 widget/status 形态）----
  report.uiRequestsBeforePrompt = uiRequests.map((u) => truncate(u))
  console.log(`[p0-3] prompt 前 extension_ui_request: ${uiRequests.length} 条`)

  // ---- 3) 触发 todo 工具调用（短指令，收结构化结果）----
  console.log(`[p0-3] prompt: 触发 todo 工具...`)
  await client.prompt(
    "用 todo 工具创建一个清单，包含两项：买牛奶、寄包裹。然后把第一项标记为完成。不要做其他任何事，不要解释。",
    { thinkingLevel: "low" as never },
  )
  await client.waitForIdle(PROMPT_TIMEOUT_MS)

  // ---- 4) 汇总事件证据 ----
  const projected = events.map(projectToolEvent).filter(Boolean)
  const toolCalls = projected.filter((p) => {
    const x = p as AnyEvent
    return x.type === "message_update/toolcall_start"
  })
  const assistantMsgs = projected.filter((p) => {
    const x = p as AnyEvent
    return x.type === "message_start" && x.role === "assistant"
  })
  const toolResultBlocks = pickToolResults(events)

  // 全量工具名清单：assistant message 的 tools 数组（每次 message_start 可能带）
  const toolNameSet = new Set<string>()
  for (const m of assistantMsgs as AnyEvent[]) {
    for (const n of (m.toolNames as string[]) ?? []) toolNameSet.add(n)
  }

  // todo 调用判定走 tool_execution_start（wire 上带 toolName/args，流式增量期 toolCall 名在 partial.content）
  const toolExecStarts = events.filter((e) => e.type === "tool_execution_start") as AnyEvent[]
  const todoExec = toolExecStarts.find((e) => e.toolName === "todo")
  const todoResult = toolResultBlocks.find((b) => (b as AnyEvent).toolName === "todo")

  // 规则注入侧证：会话 transcript 的 system 消息（systemPrompt/tools 折叠进 transcript）
  let systemSample: unknown = null
  try {
    const messages = await client.getMessages()
    const sys = (messages as unknown as AnyEvent[]).find((m) => m.role === "system")
    if (sys) {
      const text = typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content)
      systemSample = {
        role: "system",
        length: text.length,
        hasOmoRules:
          text.includes("Soul rules") || text.includes("omo") || text.includes("OmO"),
        omoNativeMention: text.includes("OmO Native"),
        excerptHead: text.slice(0, 600),
      }
    } else {
      systemSample = { present: false, roles: (messages as unknown as AnyEvent[]).map((m) => m.role) }
    }
  } catch (err) {
    systemSample = { error: String(err) }
  }
  report.systemPromptSample = systemSample

  report.eventCounts = {
    total: events.length,
    types: events.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1
      return acc
    }, {}),
  }
  report.toolNamesFromMessages = [...toolNameSet].sort()
  report.toolCallsSeen = toolCalls
  report.todoCallPresent = todoExec !== undefined
  report.todoResultSample = todoResult ? truncate(todoResult, 4000) : null
  report.uiRequestsAfterPrompt = uiRequests.map((u) => truncate(u, 3000))

  // ---- 5) widget/status 形态判定 ----
  const widgetReqs = uiRequests.filter((u) => (u as AnyEvent).method === "setWidget")
  const statusReqs = uiRequests.filter((u) => (u as AnyEvent).method === "setStatus")
  report.widgetSummary = {
    setWidgetCount: widgetReqs.length,
    setStatusCount: statusReqs.length,
    widgetKeys: [...new Set(widgetReqs.map((u) => (u as AnyEvent).widgetKey as string))],
    widgetSample: widgetReqs[0] ? truncate(widgetReqs[0], 3000) : null,
  }

  // ---- 6) 判定 ----
  const names = report.toolNamesFromMessages as string[]
  const has = (n: string) => names.includes(n)
  const taskOk = has("task") || names.some((n) => n.startsWith("task"))
  const teamOk = has("team") || names.some((n) => n.startsWith("team"))
  // RPC 无 tools/list；todo 注册以"真实调用成功"为准（最强证据），
  // task/team 以命令注册（getCommands）与扩展注入消息侧证
  const cmdNames = (report.commands as { list: { name: string }[] }).list.map((c) => c.name)
  const taskCmdOk = cmdNames.includes("tasks") || cmdNames.includes("task-kill")
  const rulesOk =
    (systemSample as { hasOmoRules?: boolean })?.hasOmoRules === true ||
    events.some((e) => JSON.stringify(e).includes("pi-rules.scan"))

  console.log("\n===== 判定 =====")
  console.log(`工具清单（来自 assistant message tools）: ${names.length} 个: ${names.join(", ")}`)
  console.log(`todo 工具调用成功: ${todoExec ? "是" : "否"}；结构化结果: ${todoResult ? "是" : "否"}`)
  console.log(`task 侧证（命令注册）: ${taskCmdOk ? "是" : "未观察到"}`)
  console.log(`team 工具注册（消息侧证）: ${teamOk ? "是" : "未观察到（tools 数组不可用，见文档）"}`)
  console.log(`规则注入侧证: ${rulesOk ? "是" : "未观察到"}`)
  console.log(`system prompt 样本: ${JSON.stringify(truncate(systemSample, 400))}`)
  console.log(`setWidget 事件: ${widgetReqs.length} 条; setStatus 事件: ${statusReqs.length} 条`)
  if (widgetReqs[0]) console.log(`widget 样本: ${JSON.stringify(truncate(widgetReqs[0], 800))}`)
  console.log(`stderr 尾部: ${client.getStderr().slice(-400)}`)

  report.verdict = {
    todoRegistered: todoExec !== undefined,
    todoCallSucceeded: todoExec !== undefined,
    todoStructuredResult: todoResult !== undefined,
    taskSideEvidence: taskCmdOk,
    teamRegistered: teamOk,
    rulesInjectionEvidence: rulesOk,
    widgetObservable: widgetReqs.length > 0,
  }

  // todo 调用与结果的关键原始事件留样
  report.rawEvidence = {
    toolExecutionEvents: toolExecStarts.map((e) => truncate(e, 1500)),
    todoResultEvents: toolResultBlocks
      .filter((b) => JSON.stringify(b).includes("todo"))
      .map((b) => truncate(b, 4000)),
    streamingToolcallNames: toolCalls
      .map((t) => {
        const raw = (t as AnyEvent).raw as AnyEvent | undefined
        const partial = raw?.partial as AnyEvent | undefined
        const content = (partial?.content as AnyEvent[] | undefined)?.find(
          (c) => c.type === "toolCall",
        )
        return content ? { name: content.name, id: content.id } : null
      })
      .filter(Boolean),
  }

  const outPath = join(PROJ_DIR, "p0-3-samples.json")
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`\n[p0-3] 样本已写入 ${outPath}`)

  await client.stop()
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[p0-3] FAILED: ${err?.stack ?? err}`)
    process.exit(1)
  })
