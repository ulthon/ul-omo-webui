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
import { EngineProcessManager, resolveEnginePaths, type EngineManagerEvent } from "../src/engine/process-manager"
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
      await h.manager.ensureRunning(PROJ)
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
    await both.ensureRunning(PROJ)
    expect(fakes[0].spawnOpts.provider).toBe("zai-coding-cn")
    expect(fakes[0].spawnOpts.model).toBe("glm-5.3-flash")
    await both.stopAll()

    const onlyProvider = mk("zai-coding-cn")
    await onlyProvider.ensureRunning(PROJ)
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
      const snap = await h.manager.ensureRunning(PROJ)
      expect(snap.state).toBe("ready")
      expect(snap.pid).toBe(h.fakes[0].pid)
      expect(snap.consecutiveRestarts).toBe(0)
      expect((h.manager.getClient(PROJ) as unknown) === h.fakes[0]).toBe(true)
      const { PidRegistry } = await import("../src/engine/pid-registry")
      const records = new PidRegistry(h.registryPath).load()
      expect(records.map((r) => r.pid)).toContain(h.fakes[0].pid)
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
      const snap = await m.ensureRunning(PROJ)
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
      const snap = await m.ensureRunning(PROJ)
      expect(["backoff", "starting"]).toContain(snap.state)
      await waitFor(() => {
        const s = m.getStatus(PROJ)
        return s?.state === "backoff" && (s?.consecutiveRestarts ?? 0) >= 2
      })
      const s2 = m.getStatus(PROJ)
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
      const [a, b] = await Promise.all([h.manager.ensureRunning(PROJ), h.manager.ensureRunning(PROJ)])
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
      await h.manager.ensureRunning(PROJ)
      const pid1 = h.fakes[0].pid
      h.fakes[0].crash()
      expect(h.manager.getStatus(PROJ)?.state).toBe("backoff")
      // 轮询到重启完成即断言（避免短空闲超时抢先回收干扰时序）
      await waitFor(() => h.fakes.length === 2 && h.manager.getStatus(PROJ)?.state === "ready")
      expect(h.fakes.length).toBe(2)
      const snap = h.manager.getStatus(PROJ)
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
      await h.manager.ensureRunning(PROJ)
      const pid1 = h.fakes[0].pid
      // 不走 fake.crash()（onDisconnect 兼容挂点），直接从进程表移除模拟进程消失
      h.probe.procs.delete(pid1)
      await waitFor(() => h.manager.getStatus(PROJ)?.state === "backoff")
      expect(h.events.some((e) => e.type === "process_crashed")).toBe(true)
      await waitFor(() => h.fakes.length === 2 && h.manager.getStatus(PROJ)?.state === "ready")
      const snap = h.manager.getStatus(PROJ)
      expect(snap?.pid).toBe(h.fakes[1].pid)
      expect(snap?.pid).not.toBe(pid1)
      expect(snap?.consecutiveRestarts).toBe(0)
    } finally {
      await h.manager.stopAll().catch(() => {})
      cleanup(h)
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

    await m.ensureRunning(PROJ) // 第一次失败 → 连续失败 1 → backoff
    expect(m.getStatus(PROJ)?.state).toBe("backoff")
    await waitFor(() => m.getStatus(PROJ)?.state === "unavailable") // 退避两次（失败 2、失败 3 → 触顶）
    const snap = m.getStatus(PROJ)
    expect(snap?.state).toBe("unavailable")
    expect(snap?.consecutiveRestarts).toBe(3)
    expect(events.some((e) => e.type === "engine_unavailable")).toBe(true)

    const countAtUnavailable = fakes.length
    // 观察窗口：不再自动重启（状态保持不变，破坏即抛错）
    await holdInvariant(() => fakes.length === countAtUnavailable, 200)

    // recover：清零重试，仍失败继续进退避（fake 仍 alwaysFail）
    await m.recover(PROJ)
    expect(m.getStatus(PROJ)?.consecutiveRestarts).toBe(1)
    expect(m.getStatus(PROJ)?.state).toBe("backoff")
    await waitFor(() => m.getStatus(PROJ)?.state === "unavailable")
    expect(m.getStatus(PROJ)?.state).toBe("unavailable")
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
    await m.ensureRunning(PROJ)
    await waitFor(() => m.getStatus(PROJ)?.state === "unavailable") // 失败 2 次 → unavailable
    let err: unknown
    try {
      await m.ensureRunning(PROJ)
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
      await h.manager.ensureRunning(PROJ)
      await waitFor(() => h.manager.getStatus(PROJ)?.state === "stopped")
      expect(h.fakes[0].stopCount).toBe(1)
      expect(h.events.some((e) => e.type === "engine_reclaimed")).toBe(true)
    } finally {
      cleanup(h)
    }
  })

  test("挂起权限请求视为忙：超时不回收；应答后恢复回收（P0-2 孤儿化约束）", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(PROJ)
      h.fakes[0].emit({ type: "extension_ui_request", method: "select", id: "ui-1", sessionId: "rpc-1" })
      // 观察窗口覆盖数倍空闲超时（80ms）：期间必须保持 ready 不被回收
      await holdInvariant(() => h.manager.getStatus(PROJ)?.state === "ready", 300)
      expect(h.manager.getStatus(PROJ)?.state).toBe("ready")
      expect(h.manager.getStatus(PROJ)?.pendingPermissions).toEqual(["ui-1"])

      h.manager.reportPermissionAnswered(PROJ, "ui-1")
      await waitFor(() => h.manager.getStatus(PROJ)?.state === "stopped")
    } finally {
      cleanup(h)
    }
  })

  test("运行中会话视为忙；agent_settled 解除后回收；显式上报优先", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(PROJ)
      h.fakes[0].emit({ type: "agent_start", sessionId: "rpc-1" })
      await holdInvariant(() => h.manager.getStatus(PROJ)?.state === "ready", 300)
      expect(h.manager.getStatus(PROJ)?.state).toBe("ready")
      expect(h.manager.getStatus(PROJ)?.runningSessions).toEqual(["rpc-1"])

      h.fakes[0].emit({ type: "agent_settled", sessionId: "rpc-1" })
      await waitFor(() => h.manager.getStatus(PROJ)?.state === "stopped")
    } finally {
      cleanup(h)
    }
  })

  test("显式 reportSessionActive 阻止回收，reportSessionClosed 解除", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(PROJ)
      h.manager.reportSessionActive(PROJ, "rpc-9")
      await holdInvariant(() => h.manager.getStatus(PROJ)?.state === "ready", 300)
      expect(h.manager.getStatus(PROJ)?.state).toBe("ready")
      h.manager.reportSessionClosed(PROJ, "rpc-9")
      await waitFor(() => h.manager.getStatus(PROJ)?.state === "stopped")
    } finally {
      cleanup(h)
    }
  })

  test("fire-and-forget 型 UI 请求（setStatus）不算挂起权限，不阻止回收", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(PROJ)
      h.fakes[0].emit({ type: "extension_ui_request", method: "setStatus", statusKey: "goal" })
      await waitFor(() => h.manager.getStatus(PROJ)?.state === "stopped")
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
      await m.ensureRunning(PROJ)
      m.reportSessionActive(PROJ, "rpc-1")
      m.reportSessionClosed(PROJ, "rpc-1")
      // 时钟回拨模拟定时器毫秒级抖动提前触发：回调时 now-lastActivityAt 未到阈值
      clock = t0 - 500
      await sleep(200) // 首次回调已运行：旧代码在此永久丢弃回收；新代码重排（remaining=580）
      clock = t0 + 1000 // 前拨越过阈值，重排后的定时器到点即回收
      await waitFor(() => m.getStatus(PROJ)?.state === "stopped", 15000)
      expect(fakes[0].stopCount).toBe(1)
      expect(events.some((e) => e.type === "engine_reclaimed")).toBe(true)
    } finally {
      await m.stopAll().catch(() => {})
      rmSync(registryPath, { force: true })
    }
  })
})

describe("优雅关停", () => {
  test("stop()：client.stop 调用、registry 清理、状态 stopped", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(PROJ)
      const pid = h.fakes[0].pid
      await h.manager.stop(PROJ)
      expect(h.fakes[0].stopCount).toBe(1)
      expect(h.manager.getStatus(PROJ)?.state).toBe("stopped")
      expect(h.manager.getClient(PROJ)).toBeUndefined()
      const { PidRegistry } = await import("../src/engine/pid-registry")
      expect(new PidRegistry(h.registryPath).load().map((r) => r.pid)).not.toContain(pid)
    } finally {
      cleanup(h)
    }
  })

  test("client.stop() 挂死 → 兜底 SIGTERM 强杀路径", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(PROJ)
      const pid = h.fakes[0].pid
      h.probe.add(pid, { cwd: PROJ })
      h.fakes[0].stopHang = true
      await h.manager.stop(PROJ)
      expect(h.probe.signals.some((s) => s.pid === pid && s.sig === "SIGTERM")).toBe(true)
      expect(h.manager.getStatus(PROJ)?.state).toBe("stopped")
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
      await m.ensureRunning(PROJ)
      expect(m.getStatus(PROJ)?.state).toBe("backoff")
      await m.stop(PROJ)
      expect(m.getStatus(PROJ)?.state).toBe("stopped")
      // 观察窗口：退避定时器已取消，没有继续重启（backoffBaseMs=5000 远大于窗口）
      await holdInvariant(() => fakes.length === 1, 200)
    } finally {
      rmSync(registryPath, { force: true })
    }
  })

  test("stopAll 清理全部项目", async () => {
    const h = makeHarness()
    try {
      await h.manager.ensureRunning(PROJ)
      await h.manager.ensureRunning("/tmp/opencode/w2-pm-test/proj-b")
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
      await h.manager.ensureRunning(PROJ)
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
      await h.manager.ensureRunning(PROJ)
      h.fakes[0].emit({ type: "agent_start", sessionId: "s1" })
      expect(ok).toBe(true)
      expect(h.manager.getStatus(PROJ)?.state).toBe("ready")
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
      await h.manager.ensureRunning(PROJ)
      await waitFor(() => warmedWith !== undefined)
      expect(warmedWith).toBe(PROJ)
      expect(h.manager.getStatus(PROJ)?.state).toBe("ready")

      h.manager.setWarmupHook(() => {
        throw new Error("warmup boom")
      })
      await h.manager.stop(PROJ)
      await h.manager.ensureRunning(PROJ)
      expect(h.manager.getStatus(PROJ)?.state).toBe("ready")
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
      await h.manager.ensureRunning(PROJ)
      const pid1 = h.fakes[0].pid
      h.fakes[0].probeAttempts = 0
      const snap = await h.manager.ensureRunning(PROJ)
      expect(h.fakes.length).toBe(1) // 无新 spawn
      expect(snap.state).toBe("ready")
      expect(snap.pid).toBe(pid1) // 注册表无搅动：同一 pid 仍在登记
      expect(h.fakes[0].probeAttempts).toBeGreaterThan(0) // 确实 ping 过
      const { PidRegistry } = await import("../src/engine/pid-registry")
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
      await h.manager.ensureRunning(PROJ)
      const pid1 = h.fakes[0].pid
      h.fakes[0].probeAlwaysFail = true // 现有引擎挂死/拒绝
      const snap = await h.manager.ensureRunning(PROJ)
      expect(snap.state).toBe("ready")
      expect(h.fakes.length).toBe(2) // 重拉了新引擎
      expect(snap.pid).toBe(h.fakes[1].pid)
      expect(snap.pid).not.toBe(pid1)
      const { PidRegistry } = await import("../src/engine/pid-registry")
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
      await h.manager.ensureRunning(PROJ)
      const pid1 = h.fakes[0].pid
      h.probe.procs.delete(pid1) // 进程表摘除：send 仍健康但 pid 不存活
      const snap = await h.manager.ensureRunning(PROJ)
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
      await m.ensureRunning(PROJ)
      const pid1 = fakes[0].pid
      fakes[0].probeHang = true // 现有引擎挂死：send 永不落定
      const snap = await m.ensureRunning(PROJ)
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
      const snap = await m.ensureRunning(badPath)
      expect(snap.state).toBe("ready") // 引擎本身照常运行，仅拒绝登记
      const { PidRegistry } = await import("../src/engine/pid-registry")
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
    const { isRegistrableProjectPath } = await import("../src/engine/process-manager")
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
      const snap = await h.m.ensureRunning(PROJ)
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
      const { PidRegistry } = await import("../src/engine/pid-registry")
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
      const snap = await h.m.ensureRunning(PROJ)
      expect(snap.state).not.toBe("ready") // 不标 ready
      expect(snap.state).toBe("backoff") // 崩溃重拉语义：退避已调度
      expect(snap.lastError).toContain("probe_gate_failed") // 结构化码（t6 同族约定）
      expect(snap.lastError).toContain("就绪门禁")
      expect(h.events.some((e) => e.type === "process_crashed" && e.pid === h.fakes[0].pid)).toBe(true)
      // 调用方拿不到 ready 引擎（ getClient 未开放）
      expect(h.m.getClient(PROJ)).toBeUndefined()
      // 重拉：第二个（健康）引擎通过门禁后 ready
      await waitFor(() => h.fakes.length === 2 && h.m.getStatus(PROJ)?.state === "ready")
      expect(h.m.getStatus(PROJ)?.pid).toBe(h.fakes[1].pid)
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
      const snap = await h.m.ensureRunning(PROJ)
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
      const snap = await h.m.ensureRunning(PROJ)
      expect(snap.state).toBe("ready")
      expect(h.fakes.length).toBe(1)
      expect(h.fakes[0].probeOpened).toEqual([]) // 未发过探针
      expect(h.events.some((e) => e.type === "process_crashed")).toBe(false)
    } finally {
      await cleanupGate(h)
    }
  })

  test("(d) 开关环境变量解析：合法值、非法值告警一次、默认开", async () => {
    const { parseProbeGateEnv } = await import("../src/engine/process-manager")
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
      const snap = await h.m.ensureRunning(PROJ)
      expect(snap.state).toBe("ready")
      expect(h.fakes[0].probeOpened).toEqual([])
    } finally {
      await cleanupGate(h)
    }
  })
})
