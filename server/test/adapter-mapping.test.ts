/**
 * adapter 协议映射单测——fixture 全部来自 W1/W2 spike 对真实引擎的实录
 * （docs/verification/01-05），零 token。
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import {
  buildPermissionResponse,
  encodeCwdToSessionDirName,
  mapModelInfo,
  mapSessionSummary,
  mapUsageStats,
  parseTodoState,
  resolveEngineCliPath,
  resolvePluginDir,
} from "../src/adapter/senpi-adapter"
import type { EngineEntry } from "../src/adapter/engine-adapter"
import type { SessionInfo } from "@code-yeongyu/senpi"

const FIXTURES = new URL("./fixtures/protocol/", import.meta.url).pathname

function load(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8"))
}

describe("resolveEngineCliPath（spawn 规范：引擎 cli 本体）", () => {
  test("解析到 .bun 旁路官配 senpi 的 bundle/cli.js 且经 realpath", () => {
    const p = resolveEngineCliPath()
    expect(existsSync(p)).toBe(true)
    expect(p.endsWith("/dist/bundle/cli.js")).toBe(true)
    // 禁止 omo.js 包装器与根级直依赖 2026.10.10
    expect(p).not.toContain("omo.js")
    expect(p).toContain(".bun/")
    expect(p).not.toContain("@code-yeongyu+senpi@2026.10.10")
  })

  test("omo 插件目录存在", () => {
    expect(existsSync(resolvePluginDir())).toBe(true)
  })
})

describe("encodeCwdToSessionDirName（verification/04 实测编码）", () => {
  test("/tmp -> --tmp--", () => {
    expect(encodeCwdToSessionDirName("/tmp")).toBe("--tmp--")
  })
  test("/data/projects/x -> --data-projects-x--", () => {
    expect(encodeCwdToSessionDirName("/data/projects/x")).toBe("--data-projects-x--")
  })
  test("/tmp/opencode/w2-7-proj -> --tmp-opencode-w2-7-proj--", () => {
    expect(encodeCwdToSessionDirName("/tmp/opencode/w2-7-proj")).toBe("--tmp-opencode-w2-7-proj--")
  })
})

describe("mapSessionSummary（SDK 行 -> 摘要，含 fork 血缘）", () => {
  test("字段如实映射，parentSessionPath 保留", () => {
    const rows = load("sdk-list-rows.json") as Array<Record<string, unknown>>
    const forkRow = rows.find((r) => r.parentSessionPath)!
    const raw: SessionInfo = {
      path: String(forkRow.path),
      id: String(forkRow.id),
      cwd: String(forkRow.cwd),
      name: forkRow.name ? String(forkRow.name) : undefined,
      parentSessionPath: String(forkRow.parentSessionPath),
      created: new Date(String(forkRow.created)),
      modified: new Date(String(forkRow.modified)),
      messageCount: Number(forkRow.messageCount),
      firstMessage: String(forkRow.firstMessage),
      allMessagesText: "",
    }
    const s = mapSessionSummary(raw)
    expect(s.id).toBe(String(forkRow.id))
    expect(s.path).toBe(String(forkRow.path))
    expect(s.parentSessionPath).toBe(String(forkRow.parentSessionPath))
    expect(s.created).toBe(String(forkRow.created))
    expect(s.messageCount).toBe(Number(forkRow.messageCount))
  })
})

describe("parseTodoState（senpi.todo-state entry，verification/05 P1-2）", () => {
  test("真实落盘条目 -> phases/tasks，识别 abandoned 终态", () => {
    const fixture = load("todo-state.json") as { persistedEntries: EngineEntry[] }
    const last = fixture.persistedEntries.at(-1)!
    const state = parseTodoState(last)!
    expect(state.phases).toHaveLength(1)
    expect(state.phases[0]!.name).toBe("待办")
    expect(state.phases[0]!.tasks.map((t) => t.status)).toEqual(["abandoned", "abandoned"])
    expect(state.phases[0]!.tasks[0]!.content).toBe("买牛奶")
  })

  test("无 todo 条目 / 非 todo 条目 -> null", () => {
    expect(parseTodoState(undefined)).toBe(null)
    expect(parseTodoState({ type: "message", id: "x", parentId: null, timestamp: "" })).toBe(null)
    expect(parseTodoState({ type: "custom", customType: "omo-memory:x", id: "x", parentId: null, timestamp: "" })).toBe(null)
    expect(parseTodoState({ type: "custom", customType: "senpi.todo-state", id: "x", parentId: null, timestamp: "", data: {} })).toBe(null)
  })
})

describe("mapUsageStats（getSessionStats，verification/05 P1-4 状态条数据源）", () => {
  test("真实 stats -> tokens/cost/contextUsage 全量映射", () => {
    const raw = load("session-stats.json") as Record<string, unknown>
    const u = mapUsageStats(raw)
    expect(u.sessionId).toBe(String(raw.sessionId))
    expect(u.tokens.total).toBe(Number((raw.tokens as Record<string, number>).total))
    expect(u.cost).toBe(Number(raw.cost))
    expect(u.contextUsage?.contextWindow).toBe(1000000)
    expect(u.userMessages).toBe(1)
  })
})

describe("mapModelInfo（get_available_models，verification/05 P1-5）", () => {
  test("真实模型行映射 provider/id/contextWindow/reasoning/thinking 档", () => {
    const models = load("models.json") as Array<Record<string, unknown>>
    const m = mapModelInfo(models[0]!)
    expect(m.provider).toBe("zai-coding-cn")
    expect(m.id).toBe(String(models[0]!.id))
    expect(m.contextWindow).toBe(Number(models[0]!.contextWindow))
    expect(typeof m.reasoning).toBe("boolean")
    expect(Array.isArray(m.supportedThinkingLevels)).toBe(true)
  })
})

describe("buildPermissionResponse（verification/02 应答帧）", () => {
  test("四型样本：select/input/editor 用 value，confirm 用 confirmed，取消用 cancelled", () => {
    const samples = load("permission-roundtrips.json") as Array<{ id?: string; request: { id: string }; reply: Record<string, unknown> }>
    for (const s of samples) {
      const frame = buildPermissionResponse(s.request.id, s.reply)
      expect(frame).toEqual({ type: "extension_ui_response", id: s.request.id, ...s.reply })
    }
    const select = samples[0]!
    expect(buildPermissionResponse(select.request.id, { value: "Allow once" })).toEqual({
      type: "extension_ui_response",
      id: select.request.id,
      value: "Allow once",
    })
    const cancel = samples.at(-1)!
    expect(buildPermissionResponse(cancel.request.id, { cancelled: true })).toEqual({
      type: "extension_ui_response",
      id: cancel.request.id,
      cancelled: true,
    })
  })
})
