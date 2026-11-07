/**
 * 引擎子进程管理器状态机单测（mock 子进程事件，零真实引擎依赖）。
 * 覆盖：spawn 规范、崩溃重启、指数退避与 unavailable 上限、空闲回收
 * （含挂起权限/运行会话的忙判定）、优雅关停与兜底强杀、warmup 钩子、事件订阅面。
 */

import { describe, expect, test, vi } from "vitest"

// 负载下 fork pool 启动风暴会冻结 worker 数秒：等待上界 12s，用例超时 30s（上界远小于 runner 超时）
vi.setConfig({ testTimeout: 30_000 })
import { rmSync, mkdtempSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EngineProcessManager, isRegistrableProjectPath, parseProbeGateEnv, resolveEnginePaths, type EngineManagerEvent } from "../src/engine/process-manager"
import { PidRegistry } from "../src/engine/pid-registry"
import { RPC_CLIENT_CAPABILITIES_ENV } from "../src/engine/rpc-capabilities"
import { FakeRpcClient, MemProbe } from "./mocks"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待条件成立；超时抛错（fail-fast），有界且小于 vitest 默认用例超时。 */
async function waitFor(predicate: () => boolean, timeoutMs = 12000, step = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(step)
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）：条件未成立`)
}

/** 负向观察窗口：在 durationMs 内持续断言不变式成立（状态保持不变），破坏即抛错。 */
async function holdInvariant(invariant: () => boolean, durationMs: number, step = 25): Promise<void> {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    if (!invariant()) throw new Error("观察窗口内不变式被破坏")
    await sleep(step)
  }
}

const PROJ = "/tmp/opencode/w2-pm-test/proj-a"
const PROJ_B = "/tmp/opencode/w2-pm-test/proj-b"
// T1（multi-session-parallel）键迁移：引擎键 = sessionPath（每会话一引擎实例）；
// spawn cwd 与权限预设等附加参数仍按 projectPath 取值（IS-6 取值面不变）
const SESS_A1 = "/tmp/opencode/w2-pm-test/proj-a/s-a1.jsonl"
const SESS_A2 = "/tmp/opencode/w2-pm-test/proj-a/s-a2.jsonl"
const SESS_B1 = "/tmp/opencode/w2-pm-test/proj-b/s-b1.jsonl"

interface Harness {
  manager: EngineProcessManager
  fakes: FakeRpcClient[]
  probe: MemProbe
  events: EngineManagerEvent[]
  registryPath: string
}

function makeHarness(opts: { maxConsecutiveFailures?: number; probeMaxAttempts?: number } = {}): Harness {
  const fakes: FakeRpcClient[] = []
  const probe = new MemProbe()
  const events: EngineManagerEvent[] = []
  const registryPath = `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`
  const manager = new EngineProcessManager({
    registryPath,
    idleTimeoutMs: 80,
    // 任务 7：本套件到的是正常档（idleTimeoutMs）回收梯——探活窗档关闼（同灰度
    // 逃生口开关），双门档由专属「探活窗双门」describe 以假时钟覆盖
    activityWindowMs: 0,
    backoffBaseMs: 20,
    backoffMaxMs: 100,
    maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 5,
    readyProbeIntervalMs: 5,
    readyProbeMaxAttempts: opts.probeMaxAttempts ?? 10,
    stopGraceMs: 60,
    crashPollMs: 20,
    probe,
    clientFactory: (o) => {
      const fake = new FakeRpcClient(o)
      fakes.push(fake)
      return wireProbe(fake, probe)
    },
  })
  manager.onEvent((e) => events.push(e))
  return { manager, fakes, probe, events, registryPath }
}

/** 模拟真实 spawn 的 /proc 生命周期：spawn 后进程存在于进程表，stop/crash 后消失。 */
function wireProbe(fake: FakeRpcClient, probe: MemProbe, cwd = PROJ): FakeRpcClient {
  probe.add(fake.pid, { cwd, argv: ["node", "/fake/engine/cli.js", "--mode", "rpc"] })
  const origStop = fake.stop.bind(fake)
  fake.stop = async () => {
    await origStop()
    probe.procs.delete(fake.pid)
  }
  const origCrash = fake.crash.bind(fake)
  fake.crash = (reason?: string) => {
    origCrash(reason)
    probe.procs.delete(fake.pid)
  }
  return fake
}

function cleanup(h: Harness): void {
  try {
    rmSync(h.registryPath)
  } catch {
    // 已删除
  }
}

describe("spawn 规范（verification/01、03 实证）", () => {
  test("cli 本体、--multi-session、--extension plugin、agent env、cwd=项目路径", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      expect(h.fakes.length).toBe(1)
      const opts = h.fakes[0].spawnOpts
      expect(opts.cliPath?.endsWith(joinCheck("dist", "bundle", "cli.js"))).toBe(true)
      expect(opts.cwd).toBe(PROJ)
      expect(opts.args).toContain("--multi-session")
      const extIdx = opts.args?.indexOf("--extension") ?? -1
      expect(extIdx).toBeGreaterThanOrEqual(0)
      expect(opts.args?.[extIdx + 1]?.endsWith("/plugin")).toBe(true)
      expect(opts.env?.OMO_CODING_AGENT_DIR).toContain(".pi/agent")
      expect(opts.env?.SENPI_CODING_AGENT_DIR).toBe(opts.env?.OMO_CODING_AGENT_DIR)
      expect(opts.env?.OMO_NATIVE).toBe("1")
      expect(opts.env?.PI_OFFLINE).toBe("1")
      // docs08-r6 任务 5：生产 spawn 路径必须携带能力声明 env（引擎 rpc-mode 启动
      // 读一次；stdio 下 set_client_info 能力面是静默空操作，env 是唯一通道）
      expect(opts.env?.SENPI_RPC_CLIENT_CAPABILITIES).toBe(RPC_CLIENT_CAPABILITIES_ENV.SENPI_RPC_CLIENT_CAPABILITIES)
      expect(opts.env?.SENPI_RPC_CLIENT_CAPABILITIES).toContain("question")
      expect(typeof opts.onDisconnect).toBe("function")
    } finally {
      await h.manager.stopAll()
      cleanup(h)
    }
  })

  test("会话级逐出档 env 注入：max(idleTimeoutMs,30min)、永不档 MAX_SAFE_INTEGER、改档仅影响新 spawn", async () => {
    // engine-open-read-batch 任务 3：env 名 SENPI_RPC_SESSION_IDLE_EVICTION_MS 实证见
    // @code-yeongyu/senpi dist/modes/rpc/host-idle-policy.js；档位对齐口径见注入点注释。
    const h = makeHarness() // makeHarness 默认 idleTimeoutMs=80ms（< 30min 默认）
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      // 低档：引擎逐出不低于引擎默认 30min，由本管理器先回收
      expect(h.fakes[0].spawnOpts.env?.SENPI_RPC_SESSION_IDLE_EVICTION_MS).toBe(String(30 * 60_000))

      // 改档上调 → 逐 spawn 现算：旧引擎（第一个 fake）env 不变，新 spawn 取新档
      h.manager.setIdleTimeoutMs(60 * 60_000)
      await h.manager.stop(SESS_A1)
      await h.manager.ensureRunning(SESS_A1, PROJ)
      expect(h.fakes.length).toBe(2)
      expect(h.fakes[0].spawnOpts.env?.SENPI_RPC_SESSION_IDLE_EVICTION_MS).toBe(String(30 * 60_000))
      expect(h.fakes[1].spawnOpts.env?.SENPI_RPC_SESSION_IDLE_EVICTION_MS).toBe(String(60 * 60_000))
    } finally {
      await h.manager.stopAll()
      cleanup(h)
    }

    // 永不回收档（<=0）：不能注入 0（引擎侧 parseIdleExitMs 遇 0/非法回落默认 30min），
    // 用 MAX_SAFE_INTEGER 表达永不
    const never = new EngineProcessManager({
      registryPath: `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`,
      idleTimeoutMs: 0,
      backoffBaseMs: 20,
      backoffMaxMs: 100,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 10,
      stopGraceMs: 60,
      probe: h.probe,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        h.fakes.push(fake)
        return wireProbe(fake, h.probe)
      },
    })
    try {
      await never.ensureRunning(SESS_A1, PROJ)
      expect(h.fakes[2].spawnOpts.env?.SENPI_RPC_SESSION_IDLE_EVICTION_MS).toBe(String(Number.MAX_SAFE_INTEGER))
    } finally {
      await never.stopAll()
      cleanup({ manager: never, fakes: h.fakes, probe: h.probe, events: h.events, registryPath: "/tmp/nonexistent" })
    }
  })

  test("默认 provider/model 成对传入，缺一不传（RpcClient 单 --provider 是 CLI 错误）", async () => {
    const fakes: FakeRpcClient[] = []
    const probe = new MemProbe()
    const mk = (provider?: string, model?: string) => {
      const m = new EngineProcessManager({
        registryPath: `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`,
        defaultProvider: provider,
        defaultModel: model,
        probe,
        clientFactory: (o) => {
          const fake = new FakeRpcClient(o)
          fakes.push(fake)
          return wireProbe(fake, probe)
        },
      })
      return m
    }
    const both = mk("zai-coding-cn", "glm-5.3-flash")
    await both.ensureRunning(SESS_A1, PROJ)
    expect(fakes[0].spawnOpts.provider).toBe("zai-coding-cn")
    expect(fakes[0].spawnOpts.model).toBe("glm-5.3-flash")
    await both.stopAll()

    const onlyProvider = mk("zai-coding-cn")
    await onlyProvider.ensureRunning(SESS_A1, PROJ)
    expect(fakes[1].spawnOpts.provider).toBeUndefined()
    expect(fakes[1].spawnOpts.model).toBeUndefined()
    await onlyProvider.stopAll()
  })

  test("resolveEnginePaths 返回真实存在的 cli 与 plugin 目录", () => {
    const { cliPath, pluginDir } = resolveEnginePaths()
    expect(cliPath.includes("@code-yeongyu/senpi")).toBe(true)
    expect(pluginDir.endsWith("/plugin")).toBe(true)
  })
})

describe("状态机：启动与健康检查", () => {
  test("ensureRunning 成功 → ready，registry 登记	pid，快照正确", async () => {
    const h = makeHarness()
    try {
      const snap = await h.manager.ensureRunning(SESS_A1, PROJ)
      expect(snap.state).toBe("ready")
      expect(snap.pid).toBe(h.fakes[0].pid)
      expect(snap.consecutiveRestarts).toBe(0)
      expect((h.manager.getClient(SESS_A1) as unknown) === h.fakes[0]).toBe(true)
      const records = new PidRegistry(h.registryPath).load()
      expect(records.map((r) => r.pid)).toContain(h.fakes[0].pid)
      // 记录对：pid ↔ projectPath+sessionPath 成对登记（重启恢复/孤儿清扫读对）
      const rec = records.find((r) => r.pid === h.fakes[0].pid)
      expect(rec?.projectPath).toBe(PROJ)
      expect(rec?.sessionPath).toBe(SESS_A1)
    } finally {
      await h.manager.stopAll()
      cleanup(h)
    }
  })

  test("健康检查前 N 次 ping 超时后成功（get_protocol_info 轮询模式）", async () => {
    const fakes: FakeRpcClient[] = []
    const probe = new MemProbe()
    const m = new EngineProcessManager({
      registryPath: `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 10,
      probe,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        fake.probeFailures = 2
        fakes.push(fake)
        return wireProbe(fake, probe)
      },
    })
    try {
      const snap = await m.ensureRunning(SESS_A1, PROJ)
      expect(snap.state).toBe("ready")
      expect(fakes[0].probeAttempts).toBeGreaterThanOrEqual(3)
    } finally {
      await m.stopAll()
    }
  })

  test("健康检查轮询超限 → 进入 backoff 并记录 lastError", async () => {
    const fakes: FakeRpcClient[] = []
    const probe = new MemProbe()
    const m = new EngineProcessManager({
      registryPath: `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`,
      backoffBaseMs: 20,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 3,
      maxConsecutiveFailures: 99, // 不触顶，观察 backoff
      probe,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        fake.probeAlwaysFail = true
        fakes.push(fake)
        return wireProbe(fake, probe)
      },
    })
    try {
      // doStart 失败被 catch 进退避，ensureRunning 正常返回快照
      const snap = await m.ensureRunning(SESS_A1, PROJ)
      expect(["backoff", "starting"]).toContain(snap.state)
      await waitFor(() => {
        const s = m.getStatus(SESS_A1)
        return s?.state === "backoff" && (s?.consecutiveRestarts ?? 0) >= 2
      })
      const s2 = m.getStatus(SESS_A1)
      expect(s2?.state).toBe("backoff")
      expect(s2?.consecutiveRestarts).toBeGreaterThanOrEqual(2)
      expect(m.getAllStatus()[0].lastError).toContain("健康检查")
      void fakes
    } finally {
      await m.stopAll().catch(() => {})
    }
  })

  test("并发 ensureRunning 去重：只 spawn 一个子进程", async () => {
    const h = makeHarness()
    try {
      const [a, b] = await Promise.all([h.manager.ensureRunning(SESS_A1, PROJ), h.manager.ensureRunning(SESS_A1, PROJ)])
      expect(h.fakes.length).toBe(1)
      expect(a.pid).toBe(b.pid)
    } finally {
      await h.manager.stopAll()
      cleanup(h)
    }
  })
})

describe("状态机：崩溃与重启退避", () => {
  test("ready 后崩溃 → backoff → 自动重启 → ready，失败计数清零", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      const pid1 = h.fakes[0].pid
      h.fakes[0].crash()
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("backoff")
      // 轮询到重启完成即断言（避免短空闲超时抢先回收干扰时序）
      await waitFor(() => h.fakes.length === 2 && h.manager.getStatus(SESS_A1)?.state === "ready")
      expect(h.fakes.length).toBe(2)
      const snap = h.manager.getStatus(SESS_A1)
      expect(snap?.state).toBe("ready")
      expect(snap?.pid).toBe(h.fakes[1].pid)
      expect(snap?.pid).not.toBe(pid1)
      expect(snap?.consecutiveRestarts).toBe(0)
      expect(h.events.some((e) => e.type === "process_crashed")).toBe(true)
    } finally {
      await h.manager.stopAll().catch(() => {})
      cleanup(h)
    }
  })

  test("监督轮询检测进程消失 → 自动重启（RpcClient stdio 路径不回调 onDisconnect 的主检测路径）", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      const pid1 = h.fakes[0].pid
      // 不走 fake.crash()（onDisconnect 兼容挂点），直接从进程表移除模拟进程消失
      h.probe.procs.delete(pid1)
      // 检测观测走 process_crashed 事件（持久事实）而非 backoff 过境态：backoff 窗口
      // （backoffBaseMs=20ms）窄于 waitFor 25ms 步长，全量套件负载下 waitFor 会错过
      // ready→backoff→starting 过境窗口（监督检测→重启 ready 后永不再回 backoff），
      // 误报超时。本用例 process_crashed 只能来自监督轮询：FakeRpcClient 无 process.on
      // exit 句柄（attachExitWatcher 返回 null）、未调 fake.crash（onDisconnect 兼容
      // 挂点不可达），exit 事件主检测路径同样缺席，事件即监督轮询检测的证明。
      await waitFor(() => h.events.some((e) => e.type === "process_crashed"))
      await waitFor(() => h.fakes.length === 2 && h.manager.getStatus(SESS_A1)?.state === "ready")
      const snap = h.manager.getStatus(SESS_A1)
      expect(snap?.pid).toBe(h.fakes[1].pid)
      expect(snap?.pid).not.toBe(pid1)
      expect(snap?.consecutiveRestarts).toBe(0)
    } finally {
      await h.manager.stopAll().catch(() => {})
      cleanup(h)
    }
  })

  test("ready 后子进程 exit 事件 → crash 带死因 code/signal/uptime（P1a：exit 事件主检测）", async () => {
    const fakes: FakeRpcClient[] = []
    const exitCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
    const probe = new MemProbe()
    const m = new EngineProcessManager({
      registryPath: `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`,
      backoffBaseMs: 10,
      backoffMaxMs: 30,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 2,
      probe,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        // 真实 RpcClient 的 process 是 ChildProcess 自带 on("exit")；给 fake 挂同型挂点
        const proc = fake.process as unknown as {
          on: (ev: string, cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void
          removeListener: (ev: string, cb: unknown) => void
        }
        proc.on = (ev, cb) => {
          if (ev === "exit") exitCbs.push(cb)
        }
        proc.removeListener = () => {}
        fakes.push(fake)
        return wireProbe(fake, probe)
      },
    })
    const events: EngineManagerEvent[] = []
    m.onEvent((e) => events.push(e))
    try {
      await m.ensureRunning(SESS_A1, PROJ)
      expect(m.getStatus(SESS_A1)?.state).toBe("ready")
      expect(exitCbs.length).toBe(1) // 挂点已接
      exitCbs[0](0, null) // code=0 干净自退（对机 2026-11-05 实测形态）
      await waitFor(() => m.getStatus(SESS_A1)?.state === "backoff")
      const crashed = events.find(
        (e): e is Extract<EngineManagerEvent, { type: "process_crashed" }> => e.type === "process_crashed",
      )
      expect(crashed?.exit).toMatchObject({ code: 0, signal: null })
      expect(crashed?.exit?.uptimeMs).toBeGreaterThanOrEqual(0)
      await waitFor(() => fakes.length === 2 && m.getStatus(SESS_A1)?.state === "ready")
      expect(m.getStatus(SESS_A1)?.consecutiveRestarts).toBe(0)
    } finally {
      await m.stopAll().catch(() => {})
    }
  })

  test("连续失败达上限 → unavailable，停止自动重启（不死循环），recover 可恢复", async () => {
    const fakes: FakeRpcClient[] = []
    const probe = new MemProbe()
    const m = new EngineProcessManager({
      registryPath: `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`,
      backoffBaseMs: 10,
      backoffMaxMs: 30,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 2,
      maxConsecutiveFailures: 3,
      probe,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        fake.probeAlwaysFail = true // 重启永远健康检查失败
        fakes.push(fake)
        return wireProbe(fake, probe)
      },
    })
    const events: EngineManagerEvent[] = []
    m.onEvent((e) => events.push(e))

    await m.ensureRunning(SESS_A1, PROJ) // 第一次失败 → 连续失败 1 → backoff
    expect(m.getStatus(SESS_A1)?.state).toBe("backoff")
    await waitFor(() => m.getStatus(SESS_A1)?.state === "unavailable") // 退避两次（失败 2、失败 3 → 触顶）
    const snap = m.getStatus(SESS_A1)
    expect(snap?.state).toBe("unavailable")
    expect(snap?.consecutiveRestarts).toBe(3)
    expect(events.some((e) => e.type === "engine_unavailable")).toBe(true)

    const countAtUnavailable = fakes.length
    // 观察窗口：不再自动重启（状态保持不变，破坏即抛错）
    await holdInvariant(() => fakes.length === countAtUnavailable, 200)

    // recover：清零重试，仍失败继续进退避（fake 仍 alwaysFail）
    await m.recover(SESS_A1)
    expect(m.getStatus(SESS_A1)?.consecutiveRestarts).toBe(1)
    expect(m.getStatus(SESS_A1)?.state).toBe("backoff")
    await waitFor(() => m.getStatus(SESS_A1)?.state === "unavailable")
    expect(m.getStatus(SESS_A1)?.state).toBe("unavailable")
    void fakes
  })

  test("unavailable 状态下 ensureRunning 抛错（不静默重启）", async () => {
    const probe = new MemProbe()
    const fakes: FakeRpcClient[] = []
    const m = new EngineProcessManager({
      registryPath: `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`,
      backoffBaseMs: 10,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 2,
      maxConsecutiveFailures: 2,
      probe,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        fake.probeAlwaysFail = true
        fakes.push(fake)
        return wireProbe(fake, probe)
      },
    })
    await m.ensureRunning(SESS_A1, PROJ)
    await waitFor(() => m.getStatus(SESS_A1)?.state === "unavailable") // 失败 2 次 → unavailable
    let err: unknown
    try {
      await m.ensureRunning(SESS_A1, PROJ)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect(String(err)).toContain("不可用")
    void fakes
  })
})

describe("空闲回收（空闲 = 无运行会话 且 无挂起权限请求）", () => {
  test("空闲超时 → 自动回收（stopped）+ engine_reclaimed 事件", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      await waitFor(() => h.manager.getStatus(SESS_A1)?.state === "stopped")
      expect(h.fakes[0].stopCount).toBe(1)
      expect(h.events.some((e) => e.type === "engine_reclaimed")).toBe(true)
    } finally {
      cleanup(h)
    }
  })

  test("挂起权限请求视为忙：超时不回收；应答后恢复回收（P0-2 孤儿化约束）", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.fakes[0].emit({ type: "extension_ui_request", method: "select", id: "ui-1", sessionId: "rpc-1" })
      // 观察窗口覆盖数倍空闲超时（80ms）：期间必须保持 ready 不被回收
      await holdInvariant(() => h.manager.getStatus(SESS_A1)?.state === "ready", 300)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      expect(h.manager.getStatus(SESS_A1)?.pendingPermissions).toEqual(["ui-1"])

      h.manager.reportPermissionAnswered(SESS_A1, "ui-1")
      await waitFor(() => h.manager.getStatus(SESS_A1)?.state === "stopped")
    } finally {
      cleanup(h)
    }
  })

  test("setIdleTimeoutMs(0)=永不：已拉起引擎不再被回收（2026-11-04 用户定版）", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.manager.setIdleTimeoutMs(0)
      // 覆盖数倍原 80ms 超时窗口：必须保持 ready
      await holdInvariant(() => h.manager.getStatus(SESS_A1)?.state === "ready", 300)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      expect(h.events.some((e) => e.type === "engine_reclaimed")).toBe(false)
    } finally {
      h.manager.setIdleTimeoutMs(80)
      cleanup(h)
    }
  })

  test("运行时改档即时生效：拉长阻断回收，改回短档恢复回收", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.manager.setIdleTimeoutMs(60_000)
      await holdInvariant(() => h.manager.getStatus(SESS_A1)?.state === "ready", 300)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")

      h.manager.setIdleTimeoutMs(60)
      await waitFor(() => h.manager.getStatus(SESS_A1)?.state === "stopped")
      expect(h.events.some((e) => e.type === "engine_reclaimed")).toBe(true)
    } finally {
      cleanup(h)
    }
  })

  test("运行中会话视为忙；agent_settled 解除后回收；显式上报优先", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.fakes[0].emit({ type: "agent_start", sessionId: "rpc-1" })
      await holdInvariant(() => h.manager.getStatus(SESS_A1)?.state === "ready", 300)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      expect(h.manager.getStatus(SESS_A1)?.runningSessions).toEqual(["rpc-1"])

      h.fakes[0].emit({ type: "agent_settled", sessionId: "rpc-1" })
      await waitFor(() => h.manager.getStatus(SESS_A1)?.state === "stopped")
    } finally {
      cleanup(h)
    }
  })

  test("显式 reportSessionActive 阻止回收，reportSessionClosed 解除", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.manager.reportSessionActive(SESS_A1, "rpc-9")
      await holdInvariant(() => h.manager.getStatus(SESS_A1)?.state === "ready", 300)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      h.manager.reportSessionClosed(SESS_A1, "rpc-9")
      await waitFor(() => h.manager.getStatus(SESS_A1)?.state === "stopped")
    } finally {
      cleanup(h)
    }
  })

  test("fire-and-forget 型 UI 请求（setStatus）不算挂起权限，不阻止回收", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.fakes[0].emit({ type: "extension_ui_request", method: "setStatus", statusKey: "goal" })
      await waitFor(() => h.manager.getStatus(SESS_A1)?.state === "stopped")
    } finally {
      cleanup(h)
    }
  })

  test("定时器提前触发竞态：未到阈值时重排而非丢弃回收（回归 task-2b）", async () => {
    let clock = Date.now()
    const t0 = clock
    const fakes: FakeRpcClient[] = []
    const probe = new MemProbe()
    const events: EngineManagerEvent[] = []
    const registryPath = `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`
    const m = new EngineProcessManager({
      registryPath,
      idleTimeoutMs: 80,
      // 任务 7：正常档梯子专项（task-2b 竞态回归），探活窗关闭排除双门档干扰
      activityWindowMs: 0,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 10,
      stopGraceMs: 60,
      crashPollMs: 20,
      probe,
      now: () => clock,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        probe.add(fake.pid, { cwd: PROJ })
        const origStop = fake.stop.bind(fake)
        fake.stop = async () => {
          await origStop()
          probe.procs.delete(fake.pid)
        }
        fakes.push(fake)
        return fake
      },
    })
    m.onEvent((e) => events.push(e))
    try {
      await m.ensureRunning(SESS_A1, PROJ)
      m.reportSessionActive(SESS_A1, "rpc-1")
      m.reportSessionClosed(SESS_A1, "rpc-1")
      // 时钟回拨模拟定时器毫秒级抖动提前触发：回调时 now-lastActivityAt 未到阈值
      clock = t0 - 500
      await sleep(200) // 首次回调已运行：旧代码在此永久丢弃回收；新代码重排（remaining=580）
      clock = t0 + 1000 // 前拨越过阈值，重排后的定时器到点即回收
      await waitFor(() => m.getStatus(SESS_A1)?.state === "stopped", 15000)
      expect(fakes[0].stopCount).toBe(1)
      expect(events.some((e) => e.type === "engine_reclaimed")).toBe(true)
    } finally {
      await m.stopAll().catch(() => {})
      rmSync(registryPath, { force: true })
    }
  })
})

describe("空闲回收第三判据：background_running（multi-session-parallel T2 防误杀回归）", () => {
  /** 仿 task-2b 用例的手动时钟 harness：回收判定的时点由时钟前拨决定（不靠真实
   * 睡眠越过空闲超时）；挂起的 80ms 档真实定时器用有界 waitFor/holdInvariant 观察。 */
  function makeClockHarness(opts: { backgroundRunning?: (sessionPath: string) => boolean } = {}) {
    let clock = Date.now()
    const fakes: FakeRpcClient[] = []
    const probe = new MemProbe()
    const events: EngineManagerEvent[] = []
    const registryPath = `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`
    const manager = new EngineProcessManager({
      registryPath,
      idleTimeoutMs: 80,
      // 任务 7：第三判据专项仍到正常档梯子（80ms 档），探活窗关闭排除双门档干扰
      activityWindowMs: 0,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 10,
      stopGraceMs: 60,
      crashPollMs: 20,
      probe,
      now: () => clock,
      sessionBackgroundRunning: opts.backgroundRunning,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        probe.add(fake.pid, { cwd: PROJ })
        const origStop = fake.stop.bind(fake)
        fake.stop = async () => {
          await origStop()
          probe.procs.delete(fake.pid)
        }
        fakes.push(fake)
        return fake
      },
    })
    manager.onEvent((e) => events.push(e))
    return {
      manager,
      fakes,
      events,
      cleanup: () => {
        try {
          rmSync(registryPath)
        } catch {
          // 已删除
        }
      },
      setClock: (t: number) => {
        clock = t
      },
    }
  }

  test("(a) background_running=true：空闲期满不回收（stop 未被调用）", async () => {
    const h = makeClockHarness({ backgroundRunning: () => true })
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.setClock(Date.now() + 500) // 前拨越过 80ms 档阈值
      // 负向窗口覆盖挂起定时器真实到点（remaining=80ms < 250ms 有界观察）
      await holdInvariant(() => h.manager.getStatus(SESS_A1)?.state === "ready", 250)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      // 对抗 misleading_success_output：实证 stop 未被调用，非仅断言状态字段
      expect(h.fakes[0].stopCount).toBe(0)
      expect(h.events.some((e) => e.type === "engine_reclaimed")).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test("(b) 回调转 false（后台任务落定）后正常回收", async () => {
    let busy = true
    const h = makeClockHarness({ backgroundRunning: () => busy })
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.setClock(Date.now() + 500)
      await holdInvariant(() => h.manager.getStatus(SESS_A1)?.state === "ready", 250) // 忙窗口内不回收
      busy = false
      // 磁盘 busy 落定无 wire 事件可依：经 adapter 活动上报口触发重排（生产中任意
      // 后续交互必经 reportSessionActive/Closed 或 trackWireEvent，此为最短触发对）
      h.setClock(Date.now() + 600)
      h.manager.reportSessionActive(SESS_A1, "rpc-bg")
      h.manager.reportSessionClosed(SESS_A1, "rpc-bg")
      h.setClock(Date.now() + 700) // 越过 lastActivityAt+80ms，重排定时器到点即回收
      await waitFor(() => h.manager.getStatus(SESS_A1)?.state === "stopped")
      expect(h.fakes[0].stopCount).toBe(1)
      expect(h.events.some((e) => e.type === "engine_reclaimed")).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  test("(c) 未注入回调：行为与现状一致（期满正常回收）", async () => {
    const h = makeClockHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.setClock(Date.now() + 500)
      await waitFor(() => h.manager.getStatus(SESS_A1)?.state === "stopped")
      expect(h.fakes[0].stopCount).toBe(1)
      expect(h.events.some((e) => e.type === "engine_reclaimed")).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  test("(d) 回调抛错按 false 降级：不阻塞回收，状态机不崩", async () => {
    const h = makeClockHarness({
      backgroundRunning: () => {
        throw new Error("probe boom")
      },
    })
    try {
      // ensureRunning 的 ready 完成路径即经 isIdle：无有界捕获则此处直接拗错
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.setClock(Date.now() + 500)
      await waitFor(() => h.manager.getStatus(SESS_A1)?.state === "stopped")
      expect(h.fakes[0].stopCount).toBe(1)
      expect(h.events.some((e) => e.type === "engine_reclaimed")).toBe(true)
      // 异常未污染状态机：活动上报链路照常工作
      expect(() => h.manager.reportSessionActive(SESS_A1, "rpc-x")).not.toThrow()
    } finally {
      h.cleanup()
    }
  })

  test("(e) 默认档仍 7 天（IS-6 证明）：缺省构造 spawn env 携带 7 天空闲自退对齐", async () => {
    // T2 只增第三判据不动档位：缺省（不传 idleTimeoutMs）spawn env 的宿主自退对齐值
    // 仍为 7 天（604800000ms），证明 2026-11-04 定版档位未被本任务漂移
    const fakes: FakeRpcClient[] = []
    const probe = new MemProbe()
    const registryPath = `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`
    const manager = new EngineProcessManager({
      registryPath,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 10,
      stopGraceMs: 60,
      crashPollMs: 20,
      probe,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        probe.add(fake.pid, { cwd: PROJ })
        const origStop = fake.stop.bind(fake)
        fake.stop = async () => {
          await origStop()
          probe.procs.delete(fake.pid)
        }
        fakes.push(fake)
        return fake
      },
    })
    try {
      await manager.ensureRunning(SESS_A1, PROJ)
      expect(fakes[0].spawnOpts.env?.SENPI_RPC_HOST_IDLE_EXIT_MS).toBe(
        String(7 * 24 * 60 * 60 * 1000),
      )
    } finally {
      await manager.stopAll().catch(() => {})
      try {
        rmSync(registryPath)
      } catch {
        // 已删除
      }
    }
  })
})

describe("优雅关停", () => {
  test("stop()：client.stop 调用、registry 清理、状态 stopped", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      const pid = h.fakes[0].pid
      await h.manager.stop(SESS_A1)
      expect(h.fakes[0].stopCount).toBe(1)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("stopped")
      expect(h.manager.getClient(SESS_A1)).toBeUndefined()
      expect(new PidRegistry(h.registryPath).load().map((r) => r.pid)).not.toContain(pid)
    } finally {
      cleanup(h)
    }
  })

  test("client.stop() 挂死 → 兜底 SIGTERM 强杀路径", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      const pid = h.fakes[0].pid
      h.probe.add(pid, { cwd: PROJ })
      h.fakes[0].stopHang = true
      await h.manager.stop(SESS_A1)
      expect(h.probe.signals.some((s) => s.pid === pid && s.sig === "SIGTERM")).toBe(true)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("stopped")
    } finally {
      cleanup(h)
    }
  })

  test("backoff 状态 stop()：取消重启定时器直接 stopped（无进程可关）", async () => {
    const registryPath = `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`
    try {
      const fakes: FakeRpcClient[] = []
      const probe = new MemProbe()
      const m = new EngineProcessManager({
        registryPath,
        backoffBaseMs: 5000, // 长退避：stop 应取消它
        readyProbeIntervalMs: 5,
        readyProbeMaxAttempts: 2,
        maxConsecutiveFailures: 99,
        probe,
        clientFactory: (o) => {
          const fake = new FakeRpcClient(o)
          fake.probeAlwaysFail = true
          fakes.push(fake)
          return wireProbe(fake, probe)
        },
      })
      await m.ensureRunning(SESS_A1, PROJ)
      expect(m.getStatus(SESS_A1)?.state).toBe("backoff")
      await m.stop(SESS_A1)
      expect(m.getStatus(SESS_A1)?.state).toBe("stopped")
      // 观察窗口：退避定时器已取消，没有继续重启（backoffBaseMs=5000 远大于窗口）
      await holdInvariant(() => fakes.length === 1, 200)
    } finally {
      rmSync(registryPath, { force: true })
    }
  })

  test("stopAll 清理全部项目", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      await h.manager.ensureRunning(SESS_B1, "/tmp/opencode/w2-pm-test/proj-b")
      expect(h.fakes.length).toBe(2)
      await h.manager.stopAll()
      expect(h.manager.getAllStatus().every((s) => s.state === "stopped")).toBe(true)
    } finally {
      cleanup(h)
    }
  })
})

describe("事件订阅面（todo 10 事件桥基础）", () => {
  test("透传 engine_event 与 state_changed；退订后不再接收", async () => {
    const h = makeHarness()
    try {
      const received: EngineManagerEvent[] = []
      const unsub = h.manager.onEvent((e) => received.push(e))
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.fakes[0].emit({ type: "agent_start", sessionId: "s1" })
      expect(received.some((e) => e.type === "engine_event")).toBe(true)
      expect(received.some((e) => e.type === "state_changed" && e.to === "ready")).toBe(true)
      const n = received.length
      unsub()
      h.fakes[0].emit({ type: "agent_start", sessionId: "s2" })
      expect(received.length).toBe(n)
    } finally {
      await h.manager.stopAll().catch(() => {})
      cleanup(h)
    }
  })

  test("订阅者抛异常不影响管理器与其它订阅者", async () => {
    const h = makeHarness()
    try {
      let ok = false
      h.manager.onEvent(() => {
        throw new Error("bad subscriber")
      })
      h.manager.onEvent(() => {
        ok = true
      })
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.fakes[0].emit({ type: "agent_start", sessionId: "s1" })
      expect(ok).toBe(true)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
    } finally {
      await h.manager.stopAll()
      cleanup(h)
    }
  })
})

describe("warmup 钩子", () => {
  test("ready 后 fire-and-forget 调用；失败不回滚 ready", async () => {
    const h = makeHarness()
    try {
      let warmedWith: string | undefined
      h.manager.setWarmupHook(async (projectPath) => {
        warmedWith = projectPath
      })
      await h.manager.ensureRunning(SESS_A1, PROJ)
      await waitFor(() => warmedWith !== undefined)
      expect(warmedWith).toBe(PROJ)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")

      h.manager.setWarmupHook(() => {
        throw new Error("warmup boom")
      })
      await h.manager.stop(SESS_A1)
      await h.manager.ensureRunning(SESS_A1, PROJ)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
    } finally {
      await h.manager.stopAll()
      cleanup(h)
    }
  })
})

describe("健康守卫（任务 5：换引擎前 ping，健康不重拉）", () => {
  test("分支 1：现有引擎 ping 健康 → 复用，不重 spawn，注册表行不变", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      const pid1 = h.fakes[0].pid
      h.fakes[0].probeAttempts = 0
      const snap = await h.manager.ensureRunning(SESS_A1, PROJ)
      expect(h.fakes.length).toBe(1) // 无新 spawn
      expect(snap.state).toBe("ready")
      expect(snap.pid).toBe(pid1) // 注册表无搅动：同一 pid 仍在登记
      expect(h.fakes[0].probeAttempts).toBeGreaterThan(0) // 确实 ping 过
      const pids = new PidRegistry(h.registryPath).load().map((r) => r.pid)
      expect(pids).toEqual([pid1])
      expect(h.events.some((e) => e.type === "process_crashed")).toBe(false)
    } finally {
      await h.manager.stopAll()
      cleanup(h)
    }
  })

  test("分支 2：ping 失败（RPC 拒绝）→ 重拉，注册表更新为新 pid", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      const pid1 = h.fakes[0].pid
      h.fakes[0].probeAlwaysFail = true // 现有引擎挂死/拒绝
      const snap = await h.manager.ensureRunning(SESS_A1, PROJ)
      expect(snap.state).toBe("ready")
      expect(h.fakes.length).toBe(2) // 重拉了新引擎
      expect(snap.pid).toBe(h.fakes[1].pid)
      expect(snap.pid).not.toBe(pid1)
      const pids = new PidRegistry(h.registryPath).load().map((r) => r.pid)
      expect(pids).toEqual([h.fakes[1].pid]) // 旧行已清、只余新 pid
      expect(h.events.some((e) => e.type === "process_crashed" && e.pid === pid1)).toBe(true)
    } finally {
      await h.manager.stopAll()
      cleanup(h)
    }
  })

  test("分支 2b：pid 已死（恶意/陈旧记录）→ 不复用，直接重拉", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      const pid1 = h.fakes[0].pid
      h.probe.procs.delete(pid1) // 进程表摘除：send 仍健康但 pid 不存活
      const snap = await h.manager.ensureRunning(SESS_A1, PROJ)
      expect(h.fakes.length).toBe(2)
      expect(snap.state).toBe("ready")
      expect(snap.pid).toBe(h.fakes[1].pid)
      expect(snap.pid).not.toBe(pid1)
    } finally {
      await h.manager.stopAll()
      cleanup(h)
    }
  })

  test("分支 3：ping 超时（send 挂死不落定）→ 按失败处理重拉", async () => {
    const registryPath = `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`
    const fakes: FakeRpcClient[] = []
    const probe = new MemProbe()
    const m = new EngineProcessManager({
      registryPath,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 10,
      healthPingTimeoutMs: 50, // 短有界：挂死引擎快速判死
      probe,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        fakes.push(fake)
        return wireProbe(fake, probe)
      },
    })
    try {
      await m.ensureRunning(SESS_A1, PROJ)
      const pid1 = fakes[0].pid
      fakes[0].probeHang = true // 现有引擎挂死：send 永不落定
      const snap = await m.ensureRunning(SESS_A1, PROJ)
      expect(snap.state).toBe("ready")
      expect(fakes.length).toBe(2)
      expect(snap.pid).toBe(fakes[1].pid)
      expect(snap.pid).not.toBe(pid1)
      // 挂死旧进程被兑底强杀（进程表已摘除）
      expect(probe.procs.has(pid1)).toBe(false)
    } finally {
      await m.stopAll().catch(() => {})
      rmSync(registryPath, { force: true })
    }
  })
})

// T1 绑定 open 观测：记录非探针 open_session 的绑定调用（其余行为同 FakeRpcClient）。
class BindRecordingFake extends FakeRpcClient {
  readonly boundOpens: string[] = []
  override async send(message: unknown): Promise<{ success: boolean; data: unknown }> {
    const msg = message as { type?: string; sessionPath?: string }
    if (msg?.type === "open_session" && !(msg.sessionPath ?? "").includes("__probe__")) {
      this.boundOpens.push(msg.sessionPath ?? "")
    }
    return super.send(message)
  }
}

// T1 病态：绑定 open 一律被拒（健康检查/探针面正常，仅 open_session 拒绝）。
class BindFailFake extends FakeRpcClient {
  override async send(message: unknown): Promise<{ success: boolean; data: unknown }> {
    const msg = message as { type?: string; sessionPath?: string }
    if (msg?.type === "open_session" && !(msg.sessionPath ?? "").includes("__probe__")) {
      throw new Error("open_session refused")
    }
    return super.send(message)
  }
}

describe("每会话一引擎（multi-session-parallel T1 键迁移）", () => {
  test("同项目两个 sessionPath 两次 ensureRunning → 两个独立引擎实例（不同 pid/对象）", async () => {
    const h = makeHarness()
    try {
      const s1 = await h.manager.ensureRunning(SESS_A1, PROJ)
      const s2 = await h.manager.ensureRunning(SESS_A2, PROJ)
      expect(h.fakes.length).toBe(2)
      expect(h.fakes[0].pid).not.toBe(h.fakes[1].pid)
      // 对象身份断言（键两侧同 string 的假绿防线：必须证明确是两个实例）
      const c1 = h.manager.getClient(SESS_A1)
      const c2 = h.manager.getClient(SESS_A2)
      expect(c1 === (h.fakes[0] as unknown)).toBe(true)
      expect(c2 === (h.fakes[1] as unknown)).toBe(true)
      expect(c1 !== c2).toBe(true)
      // 快照记录对：同 projectPath、异 sessionPath
      expect(s1.projectPath).toBe(PROJ)
      expect(s1.sessionPath).toBe(SESS_A1)
      expect(s2.projectPath).toBe(PROJ)
      expect(s2.sessionPath).toBe(SESS_A2)
      // engines Map 公共镜像：两条（每会话一引擎；即节点 -e 冒烟的同型断言）
      expect(h.manager.getAllStatus().length).toBe(2)
      // 注册表记录对：pid ↔ projectPath+sessionPath
      const rows = new PidRegistry(h.registryPath).load()
      expect(rows.map((r) => r.pid).sort((a, b) => a - b)).toEqual([h.fakes[0].pid, h.fakes[1].pid].sort((a, b) => a - b))
      for (const [fake, sess] of [
        [h.fakes[0], SESS_A1],
        [h.fakes[1], SESS_A2],
      ] as const) {
        const row = rows.find((r) => r.pid === fake.pid)
        expect(row?.projectPath).toBe(PROJ)
        expect(row?.sessionPath).toBe(sess)
      }
    } finally {
      await h.manager.stopAll()
      cleanup(h)
    }
  })

  test("spawn 附加参数/cwd 仍按传入 projectPath 取值（IS-6 取值面不变）", async () => {
    const registryPath = `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`
    const fakes: FakeRpcClient[] = []
    const probe = new MemProbe()
    const m = new EngineProcessManager({
      registryPath,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 10,
      probe,
      // 权限预设形态：仅 projectPath 命中才附加（sessionPath 不是取值依据）
      extraSpawnArgs: (p) => (p === PROJ ? ["--permission-preset", "read-only"] : []),
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        fakes.push(fake)
        return wireProbe(fake, probe)
      },
    })
    try {
      await m.ensureRunning(SESS_A1, PROJ)
      await m.ensureRunning(SESS_A2, PROJ)
      await m.ensureRunning(SESS_B1, PROJ_B)
      expect(fakes.length).toBe(3)
      // 同项目两会话引擎：cwd 与附加参数均按 projectPath
      expect(fakes[0].spawnOpts.cwd).toBe(PROJ)
      expect(fakes[1].spawnOpts.cwd).toBe(PROJ)
      expect(fakes[0].spawnOpts.args).toEqual(expect.arrayContaining(["--permission-preset", "read-only"]))
      expect(fakes[1].spawnOpts.args).toEqual(expect.arrayContaining(["--permission-preset", "read-only"]))
      // 他项目引擎：取值随各自 projectPath，不串
      expect(fakes[2].spawnOpts.cwd).toBe(PROJ_B)
      expect(fakes[2].spawnOpts.args).not.toContain("--permission-preset")
    } finally {
      await m.stopAll().catch(() => {})
      rmSync(registryPath, { force: true })
    }
  })

  test("ensure 完成会话绑定 open；引擎换代重拉后新 client 重新 open", async () => {
    const registryPath = `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`
    const fakes: BindRecordingFake[] = []
    const probe = new MemProbe()
    const m = new EngineProcessManager({
      registryPath,
      backoffBaseMs: 10,
      backoffMaxMs: 30,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 10,
      stopGraceMs: 60,
      crashPollMs: 20,
      probe,
      clientFactory: (o) => {
        const fake = new BindRecordingFake(o)
        fakes.push(fake)
        return wireProbe(fake, probe)
      },
    })
    try {
      await m.ensureRunning(SESS_A1, PROJ)
      // 绑定 open：引擎收到非探针 open_session 且路径=键定会话
      expect(fakes[0].boundOpens).toEqual([SESS_A1])
      expect(m.getStatus(SESS_A1)?.state).toBe("ready")
      // 换代：crash → 自动重拉 → 新 client 再次绑定 open 同一会话
      fakes[0].crash()
      await waitFor(() => fakes.length === 2 && m.getStatus(SESS_A1)?.state === "ready")
      expect(fakes[1].boundOpens).toEqual([SESS_A1])
    } finally {
      await m.stopAll().catch(() => {})
      rmSync(registryPath, { force: true })
    }
  })

  test("绑定 open 失败 → 既有退避→unavailable 路径（有界不悬挂）", async () => {
    const registryPath = `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`
    const fakes: BindFailFake[] = []
    const probe = new MemProbe()
    const m = new EngineProcessManager({
      registryPath,
      backoffBaseMs: 10,
      backoffMaxMs: 30,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 2,
      maxConsecutiveFailures: 2,
      probe,
      clientFactory: (o) => {
        const fake = new BindFailFake(o)
        fakes.push(fake)
        return wireProbe(fake, probe)
      },
    })
    try {
      // 首次 ensure：健康检查过后绑定 open 被拒 → doStart 既有 catch → 退避（不悬挂）
      const snap = await m.ensureRunning(SESS_A1, PROJ)
      expect(snap.state).not.toBe("ready")
      expect(snap.lastError).toContain("session_bind_failed")
      await waitFor(() => m.getStatus(SESS_A1)?.state === "unavailable")
      expect(m.getStatus(SESS_A1)?.consecutiveRestarts).toBe(2)
      // unavailable 后 ensureRunning 抛错（既有语义）
      let err: unknown
      try {
        await m.ensureRunning(SESS_A1, PROJ)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(Error)
      expect(String(err)).toContain("不可用")
    } finally {
      await m.stopAll().catch(() => {})
      rmSync(registryPath, { force: true })
    }
  })
})

describe("注册表 projectPath 校验（docs08-2026-10-23-24-batch 任务 6）", () => {
  test.each(["/", "//", ""])("非法项目路径 %j：引擎照常 ready，但不登记注册表且告警", async (badPath) => {
    const registryPath = `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`
    const fakes: FakeRpcClient[] = []
    const probe = new MemProbe()
    const m = new EngineProcessManager({
      registryPath,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 10,
      probe,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        fakes.push(fake)
        return wireProbe(fake, probe, badPath || "/")
      },
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const snap = await m.ensureRunning(join("/tmp/opencode/w2-pm-test", "bad-sess.jsonl"), badPath)
      expect(snap.state).toBe("ready") // 引擎本身照常运行，仅拒绝登记
      expect(new PidRegistry(registryPath).load()).toEqual([]) // 注册表零脏行
      expect(
        warnSpy.mock.calls.some((args) =>
          String(args[0]).includes("[process-manager] 拒绝登记非法项目路径"),
        ),
      ).toBe(true)
    } finally {
      warnSpy.mockRestore()
      await m.stopAll().catch(() => {})
      rmSync(registryPath, { force: true })
    }
  })

  test("isRegistrableProjectPath：根/空拒绝，常规与相对路径放行", async () => {
    expect(isRegistrableProjectPath("/")).toBe(false)
    expect(isRegistrableProjectPath("//")).toBe(false)
    expect(isRegistrableProjectPath("")).toBe(false)
    expect(isRegistrableProjectPath(PROJ)).toBe(true)
    expect(isRegistrableProjectPath("relative/proj")).toBe(true) // resolve 后非根，放行
  })
})

// joinCheck：避免只为断言引 node:path 的顶层 import 报 unused
function joinCheck(...parts: string[]): string {
  return parts.join("/")
}

describe("就绪试写门禁（docs08-2026-10-23-24-batch 任务 7）", () => {
  function makeGateHarness(opts: {
    probeGate?: boolean
    fakeSetup?: (fake: FakeRpcClient, n: number) => void
    maxConsecutiveFailures?: number
    probeWriteTimeoutMs?: number
  } = {}): {
    m: EngineProcessManager
    fakes: FakeRpcClient[]
    probe: MemProbe
    events: EngineManagerEvent[]
    agentRoot: string
    registryPath: string
  } {
    const fakes: FakeRpcClient[] = []
    const probe = new MemProbe()
    const agentRoot = mkdtempSync(join(tmpdir(), "gate-agent-"))
    const registryPath = `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`
    const events: EngineManagerEvent[] = []
    const m = new EngineProcessManager({
      registryPath,
      agentDir: agentRoot,
      probeGate: opts.probeGate,
      backoffBaseMs: 20,
      backoffMaxMs: 100,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 10,
      maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 99,
      probeWriteTimeoutMs: opts.probeWriteTimeoutMs ?? 2000,
      stopGraceMs: 60,
      crashPollMs: 20,
      probe,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        opts.fakeSetup?.(fake, fakes.length)
        fakes.push(fake)
        return wireProbe(fake, probe)
      },
    })
    m.onEvent((e) => events.push(e))
    return { m, fakes, probe, events, agentRoot, registryPath }
  }

  async function cleanupGate(h: ReturnType<typeof makeGateHarness>) {
    await h.m.stopAll().catch(() => {})
    rmSync(h.registryPath, { force: true })
    rmSync(h.agentRoot, { recursive: true, force: true })
  }

  test("(a) 门禁开 + 探针成功 → ready，单次 spawn，探针即焚无残留", async () => {
    const h = makeGateHarness({ probeGate: true })
    try {
      const snap = await h.m.ensureRunning(SESS_A1, PROJ)
      expect(snap.state).toBe("ready")
      expect(h.fakes.length).toBe(1)
      expect(h.fakes[0].probeOpened.length).toBe(1)
      expect(h.fakes[0].probeOpened[0]).toContain("__probe__")
      // 即焚：引擎侧探针会话已关，本地探针文件已删，sessions 目录零残留
      expect(h.fakes[0].probeSessionsOpen).toEqual([])
      expect(h.fakes[0].probeCloseCalls).toBe(1)
      const sessionsDir = join(h.agentRoot, "sessions")
      const residue = existsSync(sessionsDir) ? readdirSync(sessionsDir).flatMap((d) => readdirSync(join(sessionsDir, d))) : []
      expect(residue).toEqual([])
      // 不污染注册表：只登 eid 引擎 pid
      const rows = new PidRegistry(h.registryPath).load()
      expect(rows.map((r) => r.pid)).toEqual([h.fakes[0].pid])
      expect(rows.every((r) => !r.projectPath.includes("probe"))).toBe(true)
      expect(h.events.some((e) => e.type === "process_crashed")).toBe(false)
    } finally {
      await cleanupGate(h)
    }
  })

  test("(b) 门禁开 + 认领不落盘（t1 病态）→ 不 ready，崩溃重拉语义 + 结构化错误 + 无残留", async () => {
    let spawnCount = 0
    const h = makeGateHarness({
      probeGate: true,
      fakeSetup: (fake, n) => {
        if (n === 0) fake.probeClaimOnly = true // 首个引擎：口头认领不写盘
      },
    })
    try {
      const snap = await h.m.ensureRunning(SESS_A1, PROJ)
      expect(snap.state).not.toBe("ready") // 不标 ready
      expect(snap.state).toBe("backoff") // 崩溃重拉语义：退避已调度
      expect(snap.lastError).toContain("probe_gate_failed") // 结构化码（t6 同族约定）
      expect(snap.lastError).toContain("就绪门禁")
      expect(h.events.some((e) => e.type === "process_crashed" && e.pid === h.fakes[0].pid)).toBe(true)
      // 调用方拿不到 ready 引擎（ getClient 未开放）
      expect(h.m.getClient(SESS_A1)).toBeUndefined()
      // 重拉：第二个（健康）引擎通过门禁后 ready
      await waitFor(() => h.fakes.length === 2 && h.m.getStatus(SESS_A1)?.state === "ready")
      expect(h.m.getStatus(SESS_A1)?.pid).toBe(h.fakes[1].pid)
      // 失败向也无残留：首引擎探针即焚（认领不落盘本无文件，引擎侧会话已关）
      expect(h.fakes[0].probeSessionsOpen).toEqual([])
      const sessionsDir = join(h.agentRoot, "sessions")
      const residue = existsSync(sessionsDir) ? readdirSync(sessionsDir).flatMap((d) => readdirSync(join(sessionsDir, d))) : []
      expect(residue).toEqual([])
      void spawnCount
    } finally {
      await cleanupGate(h)
    }
  })

  test.each([
    ["垃圾响应", (f: FakeRpcClient): void => { f.probeOpenGarbage = true }],
    ["open 挂死（超时有界）", (f: FakeRpcClient): void => { f.probeOpenHang = true }],
    ["认领其它路径（误导性成功）", (f: FakeRpcClient): void => { f.probeClaimOtherPath = true }],
  ] as const)("(b 变体) 门禁开 + %s → 不 ready + probe_gate_failed", async (label: string, setup: (f: FakeRpcClient) => void) => {
    const h = makeGateHarness({
      probeGate: true,
      probeWriteTimeoutMs: 300, // 挂死臂有界
      fakeSetup: (fake, n) => {
        if (n === 0) setup(fake)
      },
    })
    try {
      const snap = await h.m.ensureRunning(SESS_A1, PROJ)
      expect(snap.state).not.toBe("ready")
      expect(snap.lastError).toContain("probe_gate_failed")
      void label
    } finally {
      await cleanupGate(h)
    }
  })

  test("(c) 门禁关 → 旁路：认领不落盘的引擎照常 ready，探针零发出（与 main 行为一致）", async () => {
    const h = makeGateHarness({
      probeGate: false,
      fakeSetup: (fake) => {
        fake.probeClaimOnly = true // 若门禁误开，此引擎必被拦
      },
    })
    try {
      const snap = await h.m.ensureRunning(SESS_A1, PROJ)
      expect(snap.state).toBe("ready")
      expect(h.fakes.length).toBe(1)
      expect(h.fakes[0].probeOpened).toEqual([]) // 未发过探针
      expect(h.events.some((e) => e.type === "process_crashed")).toBe(false)
    } finally {
      await cleanupGate(h)
    }
  })

  test("(d) 开关环境变量解析：合法值、非法值告警一次、默认开", async () => {
    expect(parseProbeGateEnv(undefined)).toBe(true) // 默认开（计划书任务 7）
    expect(parseProbeGateEnv("")).toBe(true)
    expect(parseProbeGateEnv("1")).toBe(true)
    expect(parseProbeGateEnv("true")).toBe(true)
    expect(parseProbeGateEnv("ON")).toBe(true)
    expect(parseProbeGateEnv("0")).toBe(false)
    expect(parseProbeGateEnv("false")).toBe(false)
    expect(parseProbeGateEnv("Off")).toBe(false)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(parseProbeGateEnv("banana")).toBe(true) // 非法 → 默认开
      expect(parseProbeGateEnv("banana")).toBe(true)
      expect(parseProbeGateEnv("42")).toBe(true)
      const warns = warnSpy.mock.calls.map((args) => String(args[0]))
      expect(warns.filter((w) => w.includes("SENPI_ENGINE_PROBE_GATE"))).toHaveLength(2) // 每个不同非法值只告警一次
      expect(warns[0]).toContain("banana")
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("(d 续) 构造缺省走环境变量：SENPI_ENGINE_PROBE_GATE=0 → 门禁关旁路生效", async () => {
    const h = makeGateHarness({
      fakeSetup: (fake) => {
        fake.probeClaimOnly = true
      },
    })
    try {
      // setup.ts 已把 env 设为 "0"：未显式传 probeGate 的构造走 env 解析
      const snap = await h.m.ensureRunning(SESS_A1, PROJ)
      expect(snap.state).toBe("ready")
      expect(h.fakes[0].probeOpened).toEqual([])
    } finally {
      await cleanupGate(h)
    }
  })
})

describe("探活窗双门（任务 7，C4-B：wire 静默 ≥5min AND isIdle 判据；发过消息转正常档）", () => {
  /** 假时钟 harness：vi.useFakeTimers 先于一切生效（Date.now 与 setTimeout 同源
   *  假化，推进 = 时钟前拨 + 定时器到点原子完成）。全套件零真实睡眠——时间推进
   *  全部经 vi.advanceTimersByTimeAsync，时序 flaky 不成立（对抗 flaky_tests 探针）。
   *  探针 sleep 同被假化且本套件路径（首次 ping 即就绪、门禁关）不依赖任何轮询
   *  睡眠，ensureRunning 纯微任务即可落定。 */
  const MIN = 60_000

  function makeTierHarness(opts: {
    idleTimeoutMs?: number
    activityWindowMs?: number
    queuedWork?: (sessionPath: string) => boolean
    backgroundRunning?: (sessionPath: string) => boolean
  } = {}) {
    const fakes: FakeRpcClient[] = []
    const probe = new MemProbe()
    const events: EngineManagerEvent[] = []
    const registryPath = `/tmp/opencode/w2-pm-test/registry-${Math.random().toString(36).slice(2)}.json`
    const manager = new EngineProcessManager({
      registryPath,
      idleTimeoutMs: opts.idleTimeoutMs ?? 10 * MIN, // 正常档：10min（与 5min 探活窗错开，双档各自可验）
      activityWindowMs: opts.activityWindowMs ?? 5 * MIN,
      readyProbeIntervalMs: 5,
      readyProbeMaxAttempts: 10,
      stopGraceMs: 60,
      crashPollMs: MIN, // 假时钟下崩溃监督周期拉长：本套件不测崩溃，减少推进时的无谓回调
      probe,
      sessionBackgroundRunning: opts.backgroundRunning,
      sessionQueuedWork: opts.queuedWork,
      clientFactory: (o) => {
        const fake = new FakeRpcClient(o)
        probe.add(fake.pid, { cwd: PROJ })
        const origStop = fake.stop.bind(fake)
        fake.stop = async () => {
          await origStop()
          probe.procs.delete(fake.pid)
        }
        fakes.push(fake)
        return fake
      },
    })
    manager.onEvent((e) => events.push(e))
    return { manager, fakes, events, registryPath }
  }

  type TierHarness = ReturnType<typeof makeTierHarness>

  function reclaimedEvents(h: TierHarness): Array<Extract<EngineManagerEvent, { type: "engine_reclaimed" }>> {
    return h.events.filter((e): e is Extract<EngineManagerEvent, { type: "engine_reclaimed" }> => e.type === "engine_reclaimed")
  }

  async function cleanupTier(h: TierHarness): Promise<void> {
    await h.manager.stopAll().catch(() => {})
    vi.useRealTimers()
    rmSync(h.registryPath, { force: true })
  }

  test("(a) 纯看引擎（无 prompt 回执）：wire 静默满 5min 即收，engine_reclaimed(activity_window) + 进程拆除实证", async () => {
    vi.useFakeTimers()
    const h = makeTierHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      await vi.advanceTimersByTimeAsync(5 * MIN - 10_000) // 4min50s：未满窗不收
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      await vi.advanceTimersByTimeAsync(20_000) // 越过 5min 窗
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("stopped")
      // 对抗 misleading_success_output：事件 + 进程面拆除实证（非仅状态字段）
      expect(reclaimedEvents(h).map((e) => e.reason)).toEqual(["activity_window"])
      expect(h.fakes[0].stopCount).toBe(1)
      expect(h.manager.getClient(SESS_A1)).toBeUndefined()
      expect(h.manager.getStatus(SESS_A1)?.pid).toBeUndefined()
    } finally {
      await cleanupTier(h)
    }
  })

  test("(b) 点亮会话（reportSessionActive）不构成忙：静默满窗照收（t6 证据：点亮但静默的正确处理）", async () => {
    vi.useFakeTimers()
    const h = makeTierHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.manager.reportSessionActive(SESS_A1, "rpc-9") // t6 扇出点亮等价物（纯看无回合）
      expect(h.manager.getStatus(SESS_A1)?.runningSessions).toEqual(["rpc-9"]) // 点亮确实在表（面板口径不变）
      await vi.advanceTimersByTimeAsync(5 * MIN + 10_000)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("stopped")
      expect(reclaimedEvents(h).map((e) => e.reason)).toEqual(["activity_window"])
    } finally {
      await cleanupTier(h)
    }
  })

  test("(c) markUserActivity（prompt 回执钩子）翻正常档：满 5min 不收，满 idleTimeout 档才收（idle_timeout）", async () => {
    vi.useFakeTimers()
    const h = makeTierHarness() // 正常档 10min
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.manager.markUserActivity(SESS_A1) // ProjectRuntime.prompt 回执成功点
      await vi.advanceTimersByTimeAsync(6 * MIN) // 越过探活窗但未到正常档
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      expect(reclaimedEvents(h)).toEqual([])
      await vi.advanceTimersByTimeAsync(5 * MIN) // 累计 11min > 10min 正常档
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("stopped")
      expect(reclaimedEvents(h).map((e) => e.reason)).toEqual(["idle_timeout"])
      expect(h.fakes[0].stopCount).toBe(1)
    } finally {
      await cleanupTier(h)
    }
  })

  test("(d) 真实回合（agent_start）静默满窗不收；agent_settled 后静默满窗即收", async () => {
    vi.useFakeTimers()
    const h = makeTierHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.manager.reportSessionActive(SESS_A1, "rpc-9")
      h.fakes[0].emit({ type: "agent_start", sessionId: "rpc-9" }) // 真实回合（区别于点亮）
      await vi.advanceTimersByTimeAsync(6 * MIN) // 长工具调用静默 6min：双门之忙门拦下
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      expect(h.fakes[0].stopCount).toBe(0)
      h.fakes[0].emit({ type: "agent_settled", sessionId: "rpc-9" })
      await vi.advanceTimersByTimeAsync(5 * MIN + 10_000)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("stopped")
      expect(reclaimedEvents(h).map((e) => e.reason)).toEqual(["activity_window"])
    } finally {
      await cleanupTier(h)
    }
  })

  test("(e) 窗内 wire 事件流刷新活动钟：4min 处流帧 → 9min 处仍 ready（时钟=trackWireEvent）", async () => {
    vi.useFakeTimers()
    const h = makeTierHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      await vi.advanceTimersByTimeAsync(4 * MIN)
      h.fakes[0].emit({ type: "message_start", sessionId: "rpc-9" }) // 流式帧=活动（非回合帧）
      await vi.advanceTimersByTimeAsync(4 * MIN) // 距流帧 4min<5min，距 spawn 8min>5min：验证时钟从流帧重计
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      await vi.advanceTimersByTimeAsync(1 * MIN + 10_000) // 距流帧超 5min
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("stopped")
      expect(reclaimedEvents(h)).toHaveLength(1)
    } finally {
      await cleanupTier(h)
    }
  })

  test("(f) 后台长任务（jsonl 探测注入）静默 30min 不收（2026-11-04 误杀防线回归）", async () => {
    vi.useFakeTimers()
    const h = makeTierHarness({ backgroundRunning: () => true })
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      await vi.advanceTimersByTimeAsync(30 * MIN) // 双档窗口全越过
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      expect(h.fakes[0].stopCount).toBe(0)
      expect(reclaimedEvents(h)).toEqual([])
    } finally {
      await cleanupTier(h)
    }
  })

  test("(g) 排队中（sessionQueuedWork 注入）永不回收；出队后满窗即收", async () => {
    let queued = true
    vi.useFakeTimers()
    const h = makeTierHarness({ queuedWork: () => queued })
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      await vi.advanceTimersByTimeAsync(12 * MIN) // 越过探活窗 5min 与正常档 10min
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      expect(h.fakes[0].stopCount).toBe(0)
      queued = false
      // 出队无 wire 事件可依：经活动上报口触发重排（生产中任意后续交互必经
      // reportSessionActive/Closed 或 trackWireEvent，此为最短触发对）
      h.manager.reportSessionActive(SESS_A1, "rpc-q")
      h.manager.reportSessionClosed(SESS_A1, "rpc-q")
      await vi.advanceTimersByTimeAsync(5 * MIN + 10_000)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("stopped")
      expect(reclaimedEvents(h).map((e) => e.reason)).toEqual(["activity_window"])
    } finally {
      await cleanupTier(h)
    }
  })

  test("(h) sessionQueuedWork 回调异常按 false 降级：不阻塞回收、不炸状态机", async () => {
    vi.useFakeTimers()
    const h = makeTierHarness({
      queuedWork: () => {
        throw new Error("queue probe boom")
      },
    })
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ) // ready 路径即经 isIdle：无有界捕获则直接拗错
      await vi.advanceTimersByTimeAsync(5 * MIN + 10_000)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("stopped")
      expect(reclaimedEvents(h)).toHaveLength(1)
      expect(() => h.manager.reportSessionActive(SESS_A1, "rpc-x")).not.toThrow()
    } finally {
      await cleanupTier(h)
    }
  })

  test("(i) setIdleTimeoutMs(0)=never 总逃生口：探活窗一并停摆", async () => {
    vi.useFakeTimers()
    const h = makeTierHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.manager.setIdleTimeoutMs(0)
      await vi.advanceTimersByTimeAsync(30 * MIN)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      expect(reclaimedEvents(h)).toEqual([])
      expect(h.fakes[0].stopCount).toBe(0)
    } finally {
      await cleanupTier(h)
    }
  })

  test("(j) setActivityWindowMs(0)=关窗：未发消息引擎回落正常档（本批前行为）", async () => {
    vi.useFakeTimers()
    const h = makeTierHarness() // 探活窗 5min + 正常档 10min
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.manager.setActivityWindowMs(0) // 灰度逃生口：关探活窗
      await vi.advanceTimersByTimeAsync(6 * MIN) // 越过原探活窗但未到正常档
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      await vi.advanceTimersByTimeAsync(5 * MIN) // 累计 11min > 10min 正常档
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("stopped")
      expect(reclaimedEvents(h).map((e) => e.reason)).toEqual(["idle_timeout"])
    } finally {
      await cleanupTier(h)
    }
  })

  test("(k) 挂起权限挡探活窗：静默满窗不收；应答后满窗即收（P0-2 约束在探活窗档同样成立）", async () => {
    vi.useFakeTimers()
    const h = makeTierHarness()
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      h.fakes[0].emit({ type: "extension_ui_request", method: "select", id: "ui-1", sessionId: "rpc-1" })
      await vi.advanceTimersByTimeAsync(6 * MIN)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
      expect(h.manager.getStatus(SESS_A1)?.pendingPermissions).toEqual(["ui-1"])
      h.manager.reportPermissionAnswered(SESS_A1, "ui-1")
      await vi.advanceTimersByTimeAsync(5 * MIN + 10_000)
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("stopped")
      expect(reclaimedEvents(h).map((e) => e.reason)).toEqual(["activity_window"])
    } finally {
      await cleanupTier(h)
    }
  })

  test("(l) getReclaimFacts 只读事实面（engine-ux-visibility 任务 2）：档位/翻档/回合计数/未知键；纯读零副作用", async () => {
    vi.useFakeTimers()
    const h = makeTierHarness() // 探活窗 5min + 正常档 10min
    try {
      await h.manager.ensureRunning(SESS_A1, PROJ)
      // 纯看引擎：探活窗档事实齐全（与 harness 构造参数同源）
      expect(h.manager.getReclaimFacts(SESS_A1)).toEqual({
        userPrompted: false,
        agentRunningCount: 0,
        activityWindowMs: 5 * MIN,
        idleTimeoutMs: 10 * MIN,
      })
      // 真实回合计数：agent_start 入表，agent_settled 出表
      h.fakes[0].emit({ type: "agent_start", sessionId: "rpc-9" })
      expect(h.manager.getReclaimFacts(SESS_A1)?.agentRunningCount).toBe(1)
      h.fakes[0].emit({ type: "agent_settled", sessionId: "rpc-9" })
      expect(h.manager.getReclaimFacts(SESS_A1)?.agentRunningCount).toBe(0)
      // 翻档：发过消息转正常档；改档 setter 即时反映
      h.manager.markUserActivity(SESS_A1)
      expect(h.manager.getReclaimFacts(SESS_A1)?.userPrompted).toBe(true)
      h.manager.setActivityWindowMs(0)
      expect(h.manager.getReclaimFacts(SESS_A1)?.activityWindowMs).toBe(0)
      // 未知键：undefined（不虚构事实）
      expect(h.manager.getReclaimFacts("/unknown/key.jsonl")).toBeUndefined()
      // 纯读零副作用：getter 不触发重排/不改变回收行为（引擎仍探活窗档计时内 ready）
      expect(h.manager.getStatus(SESS_A1)?.state).toBe("ready")
    } finally {
      await cleanupTier(h)
    }
  })
})
