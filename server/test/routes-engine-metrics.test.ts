/**
 * 引擎指标采样接口单测（engine-ux-visibility 任务 1）：GET /api/engines/metrics。
 *
 * 覆盖：
 * - ProcMetricsSampler 树采样（可注入 /proc 源）：RSS/树合计/子进程数/CPU 累计/
 *   IO 合计；cpuPct 首次 null、二次差分有值；死 pid 全 null 不抛
 * - parseProcStat/parseProcIo 纯函数（comm 含空格括号）
 * - deriveRecentErrors：mod/级别/引擎键过滤 + 尾 5 + detail 三态
 * - parseSessionLead：header id / 首条用户消息（跳过 toolResult）/ 截断半行
 * - makeBoundSessionResolver：标题链与列表同源、文件不存在 null、文件大小
 * - buildMetricsRow：starting 进行中 startupMs 差分、ready 上次完成值、无 pid 行
 * - 路由 stale_state：引擎全无 → 200 + { engines: [] }（不是错误）
 * - 冷态零 spawn：真 EngineProcessManager + 计数 clientFactory，冷调接口
 *   spawn 计数 === 0
 * - 生命周期跟踪（真 manager）：ready 落 lastStartupMs、崩溃换件 restartCount+1
 *   且成功后不清零（区别于 consecutiveRestarts）
 * - 探活窗暴露（engine-ux-visibility 任务 2）：deriveActivityWindowExposure 纯函数
 *   假时钟全分支（递减/重置/四判据豁免/正常档/never/not_ready/关窗回落）；
 *   真 manager + 假时钟端到端（倒计时数值递减、活动重置、running_turn/never 豁免）
 *
 * 对抗面：misleading_success_output——断言具体字段值（计数/数值/尾部内容），
 * 不以「响应 200 无异常」当作通过。
 */

import { describe, expect, test, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ProcMetricsSampler,
  parseProcIo,
  parseProcStat,
  type EngineProcSample,
  type ProcMetricsSource,
  type ProcPidIo,
  type ProcPidStat,
} from "../src/engine/proc-metrics"
import {
  buildMetricsRow,
  createEngineMetricsRoutes,
  deriveActivityWindowExposure,
  deriveRecentErrors,
  makeBoundSessionResolver,
  parseSessionLead,
  type BoundSessionMetaSource,
} from "../src/api/routes-engine-metrics"
import { EngineProcessManager, type EngineReclaimFacts, type EngineStatusSnapshot } from "../src/engine/process-manager"
import { FakeRpcClient, MemProbe } from "./mocks"
import { log, type LogEntry } from "../src/obs/logger"

/** 内存 /proc 度量表（可变：测试中途推进 ticks 模拟 CPU 累积） */
class FakeProcSource implements ProcMetricsSource {
  readonly procs = new Map<number, { ppid: number; rssPages: number; utime: number; stime: number; io?: ProcPidIo }>()

  add(pid: number, info: { ppid: number; rssPages: number; utime: number; stime: number; io?: ProcPidIo }): void {
    this.procs.set(pid, info)
  }

  stat(pid: number): ProcPidStat | undefined {
    const p = this.procs.get(pid)
    if (!p) return undefined
    return { ppid: p.ppid, rssBytes: p.rssPages * 4096, utimeTicks: p.utime, stimeTicks: p.stime }
  }

  io(pid: number): ProcPidIo | undefined {
    return this.procs.get(pid)?.io
  }

  listPids(): number[] {
    return [...this.procs.keys()]
  }

  clockTicksPerSec(): number {
    return 100
  }

  pageSize(): number {
    return 4096
  }
}

/** 样例进程树：100(引擎) → 110, 111；110 → 120；999 无关进程（ppid=1） */
function sampleTree(): FakeProcSource {
  const src = new FakeProcSource()
  src.add(100, { ppid: 1, rssPages: 10, utime: 100, stime: 50 })
  src.add(110, { ppid: 100, rssPages: 20, utime: 200, stime: 100, io: { readBytes: 1000, writeBytes: 2000 } })
  src.add(111, { ppid: 100, rssPages: 5, utime: 10, stime: 5 })
  src.add(120, { ppid: 110, rssPages: 8, utime: 40, stime: 20, io: { readBytes: 500, writeBytes: 500 } })
  src.add(999, { ppid: 1, rssPages: 999, utime: 999, stime: 999 })
  return src
}

describe("parseProcStat / parseProcIo 纯函数", () => {
  test("comm 含空格与嵌套括号仍按最后一个 ) 切分字段", () => {
    // ) 后字段序：state pgrp session tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itreal starttime vsize rss
    const line = `100 (omo engine (rpc)) R 1 0 0 0 0 0 0 0 0 0 100 50 0 0 0 0 1 0 0 123456 10`
    const st = parseProcStat(line)
    expect(st).toEqual({ ppid: 1, rssBytes: 10 * 4096, utimeTicks: 100, stimeTicks: 50 })
  })

  test("畸形 stat（缺字段）返回 undefined", () => {
    expect(parseProcStat("100 (x) R 1")).toBeUndefined()
  })

  test("io 解析只取 read_bytes/write_bytes 两行", () => {
    const io = parseProcIo("rchar: 1\nread_bytes: 1024\nwchar: 2\nwrite_bytes: 512\n")
    expect(io).toEqual({ readBytes: 1024, writeBytes: 512 })
    expect(parseProcIo("read_bytes: abc\nwrite_bytes: 1\n")).toBeUndefined()
  })
})

describe("ProcMetricsSampler 树采样", () => {
  test("RSS/树合计/子进程数/CPU 累计/IO 合计（树口径，无关进程不计入）", () => {
    const sampler = new ProcMetricsSampler(sampleTree())
    const s = sampler.sample(100, 10_000)
    expect(s.pid).toBe(100)
    expect(s.rssBytes).toBe(10 * 4096)
    expect(s.treeRssBytes).toBe((10 + 20 + 5 + 8) * 4096)
    expect(s.childCount).toBe(3) // 110/111/120，不含自身，不含 999
    expect(s.cpuTotalMs).toBe(((100 + 50) + (200 + 100) + (10 + 5) + (40 + 20)) / 100 * 1000)
    expect(s.ioBytes).toEqual({ readBytes: 1500, writeBytes: 2500 })
  })

  test("cpuPct 首次采样 null，二次差分有值", () => {
    const src = sampleTree()
    const sampler = new ProcMetricsSampler(src)
    const first = sampler.sample(100, 10_000)
    expect(first.cpuPct).toBeNull()
    // 推进 100 ticks（=1000ms CPU），墙钟推进 10000ms → 10%
    const p = src.procs.get(110)!
    p.utime += 100
    const second = sampler.sample(100, 20_000)
    expect(second.cpuTotalMs).toBe(first.cpuTotalMs! + 1000)
    expect(second.cpuPct).toBe(10)
  })

  test("cpuPct 基线随 pid 隔离：另一引擎独立首采仍 null", () => {
    const sampler = new ProcMetricsSampler(sampleTree())
    expect(sampler.sample(100, 1000).cpuPct).toBeNull()
    expect(sampler.sample(999, 1000).cpuPct).toBeNull()
  })

  test("死 pid（/proc 无该进程）全 null、childCount 0、不抛", () => {
    const sampler = new ProcMetricsSampler(sampleTree())
    const s = sampler.sample(424242, 1000)
    expect(s).toMatchObject({
      pid: 424242,
      rssBytes: null,
      treeRssBytes: null,
      childCount: 0,
      cpuTotalMs: null,
      cpuPct: null,
      ioBytes: null,
    })
  })

  test("io 全不可读时 ioBytes 为 null（不误报 0）", () => {
    const src = new FakeProcSource()
    src.add(100, { ppid: 1, rssPages: 1, utime: 1, stime: 1 }) // 无 io
    const s = new ProcMetricsSampler(src).sample(100, 1000)
    expect(s.ioBytes).toBeNull()
  })
})

describe("deriveRecentErrors 日志环派生", () => {
  const mk = (lvl: LogEntry["lvl"], ev: string, f: Record<string, unknown> | undefined, t: string): LogEntry =>
    ({ t, lvl, seq: 0, mod: "engine", ev, f: f as never, line: "" }) as unknown as LogEntry

  test("只收 engine 模块 warn/error 且 sess 匹配，取尾 5 条", () => {
    const entries: LogEntry[] = [
      mk("info", "state", { proj: "p", sess: "/s1" }, "t0"),
      mk("warn", "probe_gate", { proj: "p", sess: "/s2" }, "t1"),
      ...Array.from({ length: 7 }, (_, i) => mk("error", "crash", { proj: "p", sess: "/s1", pid: 1 + i }, `t${i + 2}`)),
    ]
    const out = deriveRecentErrors(entries, "/s1")
    expect(out).toHaveLength(5)
    // 尾 5 条 = 第 3~7 条 crash（pid 3..7），不是前 5 条
    expect(out.map((e) => e.t)).toEqual(["t4", "t5", "t6", "t7", "t8"])
    expect(out.every((e) => e.ev === "crash")).toBe(true)
  })

  test("detail 优先 msg，其次 reason，否则结构化字段拼 k=v", () => {
    const entries: LogEntry[] = [
      mk("warn", "warmup_fail", { proj: "p", sess: "/s1", msg: "warmup 挂了" }, "t1"),
      mk("error", "unavailable", { proj: "p", sess: "/s1", reason: "连续失败 5 次" }, "t2"),
      mk("warn", "crash", { proj: "p", sess: "/s1", pid: 42, code: 1, signal: "-" }, "t3"),
    ]
    const out = deriveRecentErrors(entries, "/s1")
    expect(out[0]).toMatchObject({ ev: "warmup_fail", detail: "warmup 挂了" })
    expect(out[1]).toMatchObject({ ev: "unavailable", detail: "连续失败 5 次" })
    expect(out[2]).toMatchObject({ ev: "crash", detail: "pid=42 code=1 signal=-" })
  })

  test("无匹配返回空数组", () => {
    expect(deriveRecentErrors([mk("warn", "x", { sess: "/other" }, "t")], "/s1")).toEqual([])
  })
})

describe("parseSessionLead jsonl 首块解析", () => {
  test("header id + 首条用户消息（跳过 toolResult 与 assistant）", () => {
    const text = [
      JSON.stringify({ type: "session", version: 3, id: "durable-1", cwd: "/p" }),
      JSON.stringify({ type: "model_change", id: "m1" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "不应取" }] } }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "第一条用户消息" }, { type: "image", url: "x" }] } }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "第二条不取" }] } }),
      `{"type":"message","message":{"role":"user","content":[{"type":"text","te`, // 截断半行
    ].join("\n")
    const lead = parseSessionLead(text)
    expect(lead.id).toBe("durable-1")
    expect(lead.firstMessage).toBe("第一条用户消息")
  })

  test("session-info custom 条目提取会话名", () => {
    const text = [
      JSON.stringify({ type: "session", id: "d-2" }),
      JSON.stringify({ type: "custom", customType: "session-info", data: { name: "调试会话" } }),
    ].join("\n")
    expect(parseSessionLead(text).name).toBe("调试会话")
  })

  test("空文本/全损坏行安全返回", () => {
    const lead = parseSessionLead("")
    expect(lead.firstMessage).toBe("")
    expect(lead.id).toBeUndefined()
  })
})

describe("makeBoundSessionResolver 绑定会话解析", () => {
  const dir = mkdtempSync(join(tmpdir(), "euv-metrics-"))
  const sessionPath = join(dir, "s1.jsonl")

  function writeSession(text: string): void {
    writeFileSync(sessionPath, text)
  }

  const meta: BoundSessionMetaSource = {
    getSessionMeta: (id) =>
      id === "durable-1" ? { renamedTitle: "手工改名" } : null,
    getSessionGeneratedTitle: (id) => (id === "durable-2" ? "自动生成标题" : null),
  }
  const resolve = makeBoundSessionResolver(meta)

  test("标题链与 /api/sessions 同源：renamedTitle > name > generatedTitle > firstMessage 截断 80", () => {
    writeSession(
      [
        JSON.stringify({ type: "session", id: "durable-1", cwd: "/p" }),
        JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] } }),
      ].join("\n") + "\n",
    )
    const bound = resolve(sessionPath)
    expect(bound?.id).toBe("durable-1")
    expect(bound?.title).toBe("手工改名")
    expect(bound?.fileSizeBytes).toBeGreaterThan(0)
  })

  test("无 renamed 时回退 generated，再回退首条消息截断 80", () => {
    writeSession(
      [
        JSON.stringify({ type: "session", id: "durable-2" }),
        JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "y".repeat(120) }] } }),
      ].join("\n") + "\n",
    )
    expect(resolve(sessionPath)?.title).toBe("自动生成标题")
    writeSession(
      [
        JSON.stringify({ type: "session", id: "durable-3" }),
        JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "z".repeat(120) }] } }),
      ].join("\n") + "\n",
    )
    const title = resolve(sessionPath)?.title
    expect(title).toBe("z".repeat(80))
  })

  test("文件不存在返回 null（starting 早期未落盘是合法态）", () => {
    expect(resolve(join(dir, "never.jsonl"))).toBeNull()
  })

  test("header 无 id 返回 null", () => {
    writeSession(JSON.stringify({ type: "message", message: { role: "user", content: [] } }) + "\n")
    expect(resolve(sessionPath)).toBeNull()
  })

  test.afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("buildMetricsRow 行组装", () => {
  const base: EngineStatusSnapshot = {
    projectPath: "/proj/a",
    sessionPath: "/proj/a/s1.jsonl",
    state: "ready",
    pid: 100,
    consecutiveRestarts: 0,
    restartCount: 2,
    lastError: undefined,
    startedAt: 90_000,
    lastStartupMs: 4_200,
    startingAt: 85_800,
    lastActivityAt: 95_000,
    runningSessions: ["rpc-1"],
    pendingPermissions: [],
  }
  /** 回收事实（探活窗档默认：5min 窗 / 10min 正常档） */
  const facts = (over: Partial<EngineReclaimFacts> = {}): EngineReclaimFacts => ({
    userPrompted: false,
    agentRunningCount: 0,
    activityWindowMs: 300_000,
    idleTimeoutMs: 600_000,
    ...over,
  })

  test("ready 行：startupMs 取上次完成值，uptimeMs 现算；排队深度命中豁免（queued_work）", () => {
    const row = buildMetricsRow(base, null, {
      boundSession: { id: "d-1", title: "t", fileSizeBytes: 42 },
      recentErrors: [{ t: "t1", ev: "crash", detail: "pid=1" }],
      rpcQueueDepth: 3,
      reclaimFacts: facts(),
      backgroundRunning: false,
      now: 200_000,
    })
    expect(row.state).toBe("ready")
    expect(row.pid).toBe(100)
    expect(row.startupMs).toBe(4_200)
    expect(row.lastStartupMs).toBe(4_200)
    expect(row.uptimeMs).toBe(110_000)
    expect(row.workerRestartCount).toBe(2)
    expect(row.rpcQueueDepth).toBe(3)
    expect(row.recentErrors).toEqual([{ t: "t1", ev: "crash", detail: "pid=1" }])
    expect(row.boundSession).toEqual({ id: "d-1", title: "t", fileSizeBytes: 42 })
    // 探活窗暴露（任务 2）：队列深度 3 > 0 → 第四判据豁免，无倒计时
    expect(row.remainingIdleMs).toBeNull()
    expect(row.activityWindowExempt).toBe(true)
    expect(row.exemptReason).toBe("queued_work")
  })

  test("starting 行：startupMs 为进行中差值（now - startingAt）；非 ready 豁免 not_ready", () => {
    const row = buildMetricsRow(
      { ...base, state: "starting", pid: undefined, startedAt: undefined, startingAt: 150_000, lastStartupMs: undefined },
      null,
      { boundSession: null, recentErrors: [], rpcQueueDepth: 0, reclaimFacts: facts(), backgroundRunning: false, now: 152_500 },
    )
    expect(row.startupMs).toBe(2_500)
    expect(row.lastStartupMs).toBeNull()
    expect(row.uptimeMs).toBeNull()
    expect(row.pid).toBeNull()
    expect(row.rssBytes).toBeNull()
    expect(row.treeRssBytes).toBeNull()
    expect(row.childCount).toBe(0)
    expect(row.remainingIdleMs).toBeNull()
    expect(row.activityWindowExempt).toBe(true)
    expect(row.exemptReason).toBe("not_ready")
  })

  test("proc 采样 pid 与快照 pid 不一致时丢弃（换代竞态不误挂新进程数据）；空闲倒计时数值现算", () => {
    const staleProc: EngineProcSample = {
      pid: 999,
      rssBytes: 1,
      treeRssBytes: 2,
      childCount: 1,
      cpuTotalMs: 3,
      cpuPct: 4,
      ioBytes: { readBytes: 5, writeBytes: 6 },
    }
    const row = buildMetricsRow(base, staleProc, {
      boundSession: null,
      recentErrors: [],
      rpcQueueDepth: 0,
      reclaimFacts: facts(),
      backgroundRunning: false,
      now: 200_000,
    })
    expect(row.rssBytes).toBeNull()
    expect(row.treeRssBytes).toBeNull()
    expect(row.cpuTotalMs).toBeNull()
    expect(row.childCount).toBe(0)
    // 空闲倒计时：elapsed = 200_000 - 95_000 = 105_000 → 300_000 - 105_000 = 195_000
    expect(row.remainingIdleMs).toBe(195_000)
    expect(row.activityWindowExempt).toBe(false)
    expect(row.exemptReason).toBeUndefined()
  })
})

describe("GET /api/engines/metrics 路由", () => {
  const readySnapshot: EngineStatusSnapshot = {
    projectPath: "/proj/a",
    sessionPath: "/proj/a/s1.jsonl",
    state: "ready",
    pid: 100,
    consecutiveRestarts: 0,
    restartCount: 1,
    lastError: undefined,
    startedAt: 90_000,
    lastStartupMs: 4_200,
    startingAt: 85_800,
    lastActivityAt: 95_000,
    runningSessions: [],
    pendingPermissions: [],
  }

  function makeApp(overrides: Partial<Parameters<typeof createEngineMetricsRoutes>[0]> = {}) {
    const src = sampleTree()
    const calls = { statuses: 0, proc: 0 }
    const deps = {
      listStatuses: () => {
        calls.statuses++
        return [readySnapshot]
      },
      sampler: {
        sample: (pid: number, now: number) => {
          calls.proc++
          return new ProcMetricsSampler(src).sample(pid, now)
        },
      },
      resolveBoundSession: () => ({ id: "d-1", title: "会话一", fileSizeBytes: 1234 }),
      recentErrors: () => [{ t: "t1", ev: "crash", detail: "pid=1" }],
      rpcQueueDepth: () => 2,
      reclaimFacts: () => ({ userPrompted: false, agentRunningCount: 0, activityWindowMs: 300_000, idleTimeoutMs: 600_000 }),
      backgroundRunning: () => false,
      now: () => 200_000,
      ...overrides,
    }
    return { app: createEngineMetricsRoutes(deps), calls, deps }
  }

  test("字段级断言（misleading_success 对抗：值而非无错）", async () => {
    const { app } = makeApp()
    const res = await app.request("/api/engines/metrics")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { engines: Array<Record<string, unknown>> }
    expect(body.engines).toHaveLength(1)
    const row = body.engines[0]!
    expect(row.projectPath).toBe("/proj/a")
    expect(row.sessionPath).toBe("/proj/a/s1.jsonl")
    expect(row.state).toBe("ready")
    expect(row.pid).toBe(100)
    expect(row.rssBytes).toBe(10 * 4096)
    expect(row.treeRssBytes).toBe((10 + 20 + 5 + 8) * 4096)
    expect(row.childCount).toBe(3)
    expect(row.cpuTotalMs).toBe(5250)
    expect(row.ioBytes).toEqual({ readBytes: 1500, writeBytes: 2500 })
    expect(row.workerRestartCount).toBe(1)
    expect(row.rpcQueueDepth).toBe(2)
    expect(row.uptimeMs).toBe(110_000)
    expect(row.boundSession).toEqual({ id: "d-1", title: "会话一", fileSizeBytes: 1234 })
    expect(row.recentErrors).toEqual([{ t: "t1", ev: "crash", detail: "pid=1" }])
    // 探活窗暴露（任务 2）：队列深度 2 > 0 → 第四判据豁免 queued_work（路由面注入链验证）
    expect(row.remainingIdleMs).toBeNull()
    expect(row.activityWindowExempt).toBe(true)
    expect(row.exemptReason).toBe("queued_work")
  })

  test("stale_state：引擎全无 → 200 + 空列表（不是 404/500）", async () => {
    const { app } = makeApp({ listStatuses: () => [] })
    const res = await app.request("/api/engines/metrics")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ engines: [] })
  })

  test("采样仅在请求内：一次请求每引擎恰好一次状态读取+一次 /proc 采样", async () => {
    const { app, calls } = makeApp()
    await app.request("/api/engines/metrics")
    expect(calls.statuses).toBe(1)
    expect(calls.proc).toBe(1)
  })
})

describe("冷态零 spawn 与生命周期跟踪（真 EngineProcessManager）", () => {
  const PROJ = "/tmp/euv-metrics/proj"
  const SESS = "/tmp/euv-metrics/proj/s1.jsonl"

  function managerHarness() {
    let spawns = 0
    const fakes: FakeRpcClient[] = []
    const probe = new MemProbe()
    const registryPath = join(tmpdir(), `euv-metrics-registry-${Math.random().toString(36).slice(2)}.json`)
    const manager = new EngineProcessManager({
      registryPath,
      probeGate: false,
      probe,
      backoffBaseMs: 20,
      backoffMaxMs: 100,
      readyProbeIntervalMs: 5,
      stopGraceMs: 60,
      crashPollMs: 20,
      idleTimeoutMs: 60_000,
      clientFactory: (o) => {
        spawns++
        const fake = new FakeRpcClient(o)
        fakes.push(fake)
        probe.add(fake.pid, { cwd: PROJ, argv: ["node", "/fake/engine/cli.js"] })
        return fake
      },
    })
    return { manager, fakes, probe, registryPath, spawns: () => spawns }
  }

  test("冷态调用 GET /api/engines/metrics：spawn 计数 === 0 且空列表", async () => {
    const h = managerHarness()
    const app = createEngineMetricsRoutes({
      listStatuses: () => h.manager.getAllStatus(),
      sampler: new ProcMetricsSampler(sampleTree()),
      resolveBoundSession: () => null,
      recentErrors: () => [],
      rpcQueueDepth: () => 0,
      reclaimFacts: (sessionPath) => h.manager.getReclaimFacts(sessionPath),
      backgroundRunning: () => false,
      now: () => 1,
    })
    const res = await app.request("/api/engines/metrics")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ engines: [] })
    expect(h.spawns()).toBe(0)
  })

  test("warmup_fail 发射点带 sess（回归：日志环按引擎过滤可命中，pre-fix 缺 sess 必败）", async () => {
    const h = managerHarness()
    try {
      h.manager.setWarmupHook(() => {
        throw new Error("warmup boom")
      })
      await h.manager.ensureRunning(SESS, PROJ)
      // fireWarmup 为微任务 fire-and-forget，等日志落环
      await waitForFn(() => log.entries().some((e) => e.ev === "warmup_fail"))
      const entry = [...log.entries()].reverse().find((e) => e.ev === "warmup_fail")
      // 发射点自带引擎键（修复前 f.sess 为 undefined → deriveRecentErrors 过滤不到）
      expect(entry?.mod).toBe("engine")
      expect(entry?.lvl).toBe("warn")
      expect(entry?.f?.sess).toBe(SESS)
      // 端到端：真实发射的条目经 deriveRecentErrors 对该引擎可见
      const errs = deriveRecentErrors(log.entries(), SESS)
      expect(errs.some((e) => e.ev === "warmup_fail" && e.detail === "warmup boom")).toBe(true)
    } finally {
      await h.manager.stopAll()
      rmSync(h.registryPath, { force: true })
    }
  })

  test("启动落 lastStartupMs；崩溃换件 restartCount+1 且成功后不清零", async () => {
    const h = managerHarness()
    try {
      await h.manager.ensureRunning(SESS, PROJ)
      let st = h.manager.getStatus(SESS)
      expect(st?.state).toBe("ready")
      expect(st?.restartCount).toBe(0)
      expect(st?.consecutiveRestarts).toBe(0)
      expect(st?.startingAt).toBeDefined()
      expect(st?.lastStartupMs).toBeDefined()
      expect(st!.lastStartupMs!).toBeGreaterThanOrEqual(0)

      // 崩溃 → 换件调度（backoff 进入即 +1）
      h.fakes[0]!.crash()
      await waitForFn(() => h.manager.getStatus(SESS)?.state === "backoff")
      st = h.manager.getStatus(SESS)
      expect(st?.restartCount).toBe(1)
      expect(st?.consecutiveRestarts).toBe(1)

      // 退避到点重拉成功：restartCount 保持（换件累计），连续失败清零
      await waitForFn(() => h.manager.getStatus(SESS)?.state === "ready")
      st = h.manager.getStatus(SESS)
      expect(st?.restartCount).toBe(1)
      expect(st?.consecutiveRestarts).toBe(0)
      expect(st?.lastStartupMs).toBeDefined()
      expect(h.spawns()).toBe(2)
    } finally {
      await h.manager.stopAll()
      rmSync(h.registryPath, { force: true })
    }
  })
})

/** 有界轮询等待（同 process-manager.test.ts 模式，上界远小于用例超时） */
async function waitForFn(predicate: () => boolean, timeoutMs = 8000, step = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, step))
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）：条件未成立`)
}

describe("deriveActivityWindowExposure 探活窗暴露纯函数（engine-ux-visibility 任务 2，假时钟）", () => {
  const T0 = 1_000_000
  /** 快照探活窗子集（runningSessions/pendingPermissions 空为默认空闲态） */
  const mkSt = (over: Partial<Pick<EngineStatusSnapshot, "state" | "lastActivityAt" | "runningSessions" | "pendingPermissions">> = {}) => ({
    state: "ready" as const,
    lastActivityAt: T0,
    runningSessions: [],
    pendingPermissions: [],
    ...over,
  })
  const mkFacts = (over: Partial<EngineReclaimFacts> = {}): EngineReclaimFacts => ({
    userPrompted: false,
    agentRunningCount: 0,
    activityWindowMs: 300_000,
    idleTimeoutMs: 600_000,
    ...over,
  })
  const derive = (
    st: ReturnType<typeof mkSt>,
    over: { facts?: EngineReclaimFacts; queueDepth?: number; backgroundRunning?: boolean; now?: number } = {},
  ) =>
    deriveActivityWindowExposure(st, {
      facts: over.facts ?? mkFacts(),
      queueDepth: over.queueDepth ?? 0,
      backgroundRunning: over.backgroundRunning ?? false,
      now: over.now ?? T0,
    })

  test("空闲倒计时随假时钟精确递减（数值断言，非存在性）：+60s→240000，+120s→180000", () => {
    expect(derive(mkSt(), { now: T0 }).remainingIdleMs).toBe(300_000)
    expect(derive(mkSt(), { now: T0 + 60_000 }).remainingIdleMs).toBe(240_000)
    expect(derive(mkSt(), { now: T0 + 120_000 }).remainingIdleMs).toBe(180_000)
    const idle = derive(mkSt(), { now: T0 + 60_000 })
    expect(idle.activityWindowExempt).toBe(false)
    expect(idle.exemptReason).toBeUndefined()
  })

  test("越窗钳 0 不出负值", () => {
    expect(derive(mkSt(), { now: T0 + 300_000 }).remainingIdleMs).toBe(0)
    expect(derive(mkSt(), { now: T0 + 400_000 }).remainingIdleMs).toBe(0)
  })

  test("活动即重置：lastActivityAt 前移后倒计时回到满窗", () => {
    // 活动钟在 T0+100_000 被刷新（wire 帧/report），现在 T0+160_000
    expect(derive(mkSt({ lastActivityAt: T0 + 100_000 }), { now: T0 + 160_000 }).remainingIdleMs).toBe(240_000)
  })

  test("豁免优先序镜像源判定序：真实回合 > 挂起权限 > 排队 > 后台（探活窗档）", () => {
    expect(derive(mkSt(), { facts: mkFacts({ agentRunningCount: 1 }), now: T0 })).toEqual({
      remainingIdleMs: null,
      activityWindowExempt: true,
      exemptReason: "running_turn",
    })
    expect(derive(mkSt({ pendingPermissions: ["ui-1"] }), { now: T0 }).exemptReason).toBe("pending_permissions")
    expect(derive(mkSt(), { queueDepth: 3, now: T0 }).exemptReason).toBe("queued_work")
    expect(derive(mkSt(), { backgroundRunning: true, now: T0 }).exemptReason).toBe("background_task")
    // 多判据同时命中取首个（源序短路）
    expect(
      derive(mkSt({ pendingPermissions: ["ui-1"] }), { facts: mkFacts({ agentRunningCount: 1 }), queueDepth: 2, now: T0 }).exemptReason,
    ).toBe("running_turn")
    expect(derive(mkSt({ pendingPermissions: ["ui-1"] }), { queueDepth: 2, now: T0 }).exemptReason).toBe("pending_permissions")
  })

  test("点亮会话不豁免探活窗档（GAP-5 口径：open ≠ run，静默满窗照收）", () => {
    const lit = derive(mkSt({ runningSessions: ["rpc-9"] }), { now: T0 + 60_000 })
    expect(lit.remainingIdleMs).toBe(240_000)
    expect(lit.activityWindowExempt).toBe(false)
  })

  test("正常档（发过消息）：点亮会话计忙（active_sessions）；空闲按 idleTimeoutMs 倒计时", () => {
    expect(
      derive(mkSt({ runningSessions: ["rpc-9"] }), { facts: mkFacts({ userPrompted: true }), now: T0 }).exemptReason,
    ).toBe("active_sessions")
    expect(derive(mkSt(), { facts: mkFacts({ userPrompted: true }), now: T0 + 60_000 }).remainingIdleMs).toBe(540_000)
  })

  test("never 总逃生口（idleTimeoutMs<=0 两档全停）：豁免 never 且优先于忙判据", () => {
    expect(derive(mkSt(), { facts: mkFacts({ idleTimeoutMs: 0, agentRunningCount: 1 }), now: T0 })).toEqual({
      remainingIdleMs: null,
      activityWindowExempt: true,
      exemptReason: "never",
    })
  })

  test("关窗（activityWindowMs=0）：未发消息引擎回落正常档倒计时（非豁免）", () => {
    expect(derive(mkSt(), { facts: mkFacts({ activityWindowMs: 0 }), now: T0 + 60_000 })).toEqual({
      remainingIdleMs: 540_000,
      activityWindowExempt: false,
    })
  })

  test("非 ready 态：豁免 not_ready（回收定时器未武装），优先于一切", () => {
    for (const state of ["starting", "backoff", "stopping", "unavailable", "stopped"] as const) {
      expect(derive(mkSt({ state }), { facts: mkFacts({ agentRunningCount: 1 }), queueDepth: 1, now: T0 })).toEqual({
        remainingIdleMs: null,
        activityWindowExempt: true,
        exemptReason: "not_ready",
      })
    }
  })
})

describe("探活窗暴露端到端（真 manager + 假时钟 + 路由，engine-ux-visibility 任务 2）", () => {
  const PROJ2 = "/tmp/euv-metrics/proj"
  const SESS2 = "/tmp/euv-metrics/proj/s1.jsonl"

  function makeFakeClockHarness() {
    const probe = new MemProbe()
    const fakes: FakeRpcClient[] = []
    const registryPath = join(tmpdir(), `euv-metrics-fc-registry-${Math.random().toString(36).slice(2)}.json`)
    const manager = new EngineProcessManager({
      registryPath,
      probeGate: false, // 首次 ping 即就绪：ensureRunning 纯微任务落定，无需推进定时器
      probe,
      idleTimeoutMs: 10 * 60_000, // 正常档 10min（与探活窗 5min 错开）
      activityWindowMs: 5 * 60_000,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 10,
      stopGraceMs: 60,
      crashPollMs: 60_000,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        fakes.push(fake)
        probe.add(fake.pid, { cwd: PROJ2 })
        // 同 process-manager.test.ts tier harness：stop 后从探针进程表摘除，
        // 否则 shutdownProcess 的 waitForExit 在冻结假时钟下永不推进（挂起）
        const origStop = fake.stop.bind(fake)
        fake.stop = async () => {
          await origStop()
          probe.procs.delete(fake.pid)
        }
        return fake
      },
    })
    const app = createEngineMetricsRoutes({
      listStatuses: () => manager.getAllStatus(),
      sampler: {
        sample: (pid: number) => ({ pid, rssBytes: 1, treeRssBytes: 1, childCount: 0, cpuTotalMs: 0, cpuPct: null, ioBytes: null }),
      },
      resolveBoundSession: () => null,
      recentErrors: () => [],
      rpcQueueDepth: () => 0,
      reclaimFacts: (sessionPath) => manager.getReclaimFacts(sessionPath),
      backgroundRunning: () => false,
      now: () => Date.now(), // 假时钟：Date.now 与定时器同源假化
    })
    return { manager, fakes, app, registryPath }
  }

  test("空闲倒计时数值递减 → 活动重置 → running_turn 豁免 → 回合落定恢复 → never 档豁免", async () => {
    vi.useFakeTimers()
    const h = makeFakeClockHarness()
    try {
      await h.manager.ensureRunning(SESS2, PROJ2)
      const readRow = async (): Promise<Record<string, unknown>> => {
        const res = await h.app.request("/api/engines/metrics")
        expect(res.status).toBe(200)
        const body = (await res.json()) as { engines: Array<Record<string, unknown>> }
        expect(body.engines).toHaveLength(1)
        return body.engines[0]!
      }
      // ready 即采样：elapsed = 0 → 满窗 300000
      let row = await readRow()
      expect(row.state).toBe("ready")
      expect(row.remainingIdleMs).toBe(300_000)
      expect(row.activityWindowExempt).toBe(false)
      expect(row.exemptReason).toBeUndefined()
      // 假时钟推进 60s：精确递减
      await vi.advanceTimersByTimeAsync(60_000)
      row = await readRow()
      expect(row.remainingIdleMs).toBe(240_000)
      await vi.advanceTimersByTimeAsync(60_000)
      row = await readRow()
      expect(row.remainingIdleMs).toBe(180_000)
      // wire 流式帧刷新活动钟：倒计时回满窗
      h.fakes[0]!.emit({ type: "message_start", sessionId: "rpc-9" } as never)
      row = await readRow()
      expect(row.remainingIdleMs).toBe(300_000)
      // 真实回合（agent_start）：豁免 running_turn，无倒计时
      h.fakes[0]!.emit({ type: "agent_start", sessionId: "rpc-9" } as never)
      row = await readRow()
      expect(row.remainingIdleMs).toBeNull()
      expect(row.activityWindowExempt).toBe(true)
      expect(row.exemptReason).toBe("running_turn")
      // 回合落定（agent_settled）：回倒计时（活动钟同步刷新）
      h.fakes[0]!.emit({ type: "agent_settled", sessionId: "rpc-9" } as never)
      row = await readRow()
      expect(row.remainingIdleMs).toBe(300_000)
      expect(row.activityWindowExempt).toBe(false)
      // never 总逃生口：两档全停，豁免 never
      h.manager.setIdleTimeoutMs(0)
      row = await readRow()
      expect(row.remainingIdleMs).toBeNull()
      expect(row.activityWindowExempt).toBe(true)
      expect(row.exemptReason).toBe("never")
    } finally {
      await h.manager.stopAll().catch(() => {})
      vi.useRealTimers()
      rmSync(h.registryPath, { force: true })
    }
  })

  test("冷态：引擎全无 → 空行且探活窗字段随行缺席（字段不凭空出现）", async () => {
    vi.useFakeTimers()
    const h = makeFakeClockHarness()
    try {
      const res = await h.app.request("/api/engines/metrics")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ engines: [] })
    } finally {
      await h.manager.stopAll().catch(() => {})
      vi.useRealTimers()
      rmSync(h.registryPath, { force: true })
    }
  })
})
