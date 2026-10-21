/**
 * per-project 引擎子进程管理器（计划 todo 8）。
 *
 * 进程模型（docs/verification/01 结论 4）：每个项目一个 `--multi-session` stdio
 * 子进程承载该项目全部会话。官方 RpcClient 单连接同一时刻只驾驶一个活跃会话
 * （01 结论 4 的限制），并发驾驶需 `--listen` socket 多连接形态——是否切换留待
 * todo 9/10 集成时按实测决策；本管理器把 client 作为"主连接 + 健康检查 + 事件源"
 * 暴露，接口不锁死单连接语义。
 *
 * 状态机：
 *   stopped --ensureRunning--> starting --健康检查过--> ready
 *   ready --crash/transport 断--> backoff --退避到点--> starting（1s/2s/4s...上限 60s）
 *   连续失败达上限（默认 5）--> unavailable（停止自动重启，需显式 recover，不死循环）
 *   ready/starting --stop()--> stopping --> stopped
 *   ready --空闲超时--> stopping --> stopped（空闲回收，下次访问 ensureRunning 重启）
 *
 * 空闲定义（docs/verification/02 实证约束）：无运行中会话 **且** 无挂起未应答的
 * 权限请求——未应答权限请求会无限阻塞该会话 agent，回收即孤儿化，必须视为忙。
 *
 * 预热设计（docs/verification/01 注意事项 4：open_session 有 3.5-4.9s worker
 * runtime 延迟）：管理器只做进程级预热——上层在用户打开项目页时即可调
 * ensureRunning()，把 spawn + 握手的 2-5s 藏在用户浏览期；会话级预热（预 open
 * 一个空闲会话消化 open_session 延迟）由 adapter 注入 warmup 钩子完成——
 * open_session 需要 provider/model 等驾驶参数，属 adapter（todo 7）的会话语义，
 * 管理器不越权 open。钩子在 ready 后 fire-and-forget，失败只记日志不回滚 ready。
 *
 * spawn 规范（docs/verification/01/03 实证）：cli 本体 realpath 解析（bun isolated
 * 布局经 .bun/omo-ai@<ver>/node_modules/ 取官配对，不走提升解析）、
 * `--extension <omo-ai>/plugin --multi-session`、env 显式 OMO_CODING_AGENT_DIR/
 * SENPI_CODING_AGENT_DIR（指向 config.agentDir()——2026-10-15 起缺省 ~/.omo/agent，
 * 与命令行版 omo 同库；显式注入纪律保留：不带它跑引擎会按引擎自家缺省整目录迁移）、
 * HOME 与其余环境变量经 RpcClient 的 {...process.env} 自然继承透传，cwd=项目目录。
 */

import { RpcClient } from "@code-yeongyu/senpi"
import { createRequire } from "node:module"
import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { isCompiledBinary, releaseRoot, selfDir } from "../runtime-paths"
import { PidRegistry } from "./pid-registry"
import {
  linuxProcProbe,
  reapOrphanEngines,
  type OrphanReapResult,
  type ProcProbe,
} from "./orphan-reaper"

export type RpcClientOptions = NonNullable<ConstructorParameters<typeof RpcClient>[0]>
export type RpcClientEvent = Parameters<Parameters<RpcClient["onEvent"]>[0]>[0]

/** 管理器实际依赖的 client 最小面（真实 RpcClient 结构兼容；测试注入 fake）。 */
export interface EngineClientLike {
  start(): Promise<void>
  stop(): Promise<void>
  onEvent(listener: (event: RpcClientEvent) => void): () => void
  getStderr(): string
}

export type EngineClientFactory = (opts: RpcClientOptions) => EngineClientLike

export type EngineState =
  | "stopped"
  | "starting"
  | "ready"
  | "backoff"
  | "unavailable"
  | "stopping"

export interface EngineManagerOptions {
  /** 创建 RpcClient 的工厂（测试注入 fake）。 */
  clientFactory?: EngineClientFactory
  /** 引擎 agent 目录（spawn 规范：显式 OMO_CODING_AGENT_DIR；缺省见 config.agentDir()，2026-10-15 起 ~/.omo/agent）。 */
  agentDir?: string
  /** spawn 时的默认 provider/model（成对生效；多会话模式下 open_session 可逐会话覆盖）。 */
  defaultProvider?: string
  defaultModel?: string
  /** 空闲回收超时（默认 30 分钟，可配置）。 */
  idleTimeoutMs?: number
  /** 重启退避基数（默认 1s，第 n 次连续失败退避 base*2^(n-1)）。 */
  backoffBaseMs?: number
  /** 重启退避上限（默认 60s）。 */
  backoffMaxMs?: number
  /** 连续失败达此数标记 unavailable（默认 5）。 */
  maxConsecutiveFailures?: number
  /** 健康检查轮询间隔（默认 1s；冷启动可超 30s，verification/03）。 */
  readyProbeIntervalMs?: number
  /** 健康检查轮询上限（默认 40 次）。 */
  readyProbeMaxAttempts?: number
  /** 优雅关停宽限（默认 3s）。 */
  stopGraceMs?: number
  /** 崩溃监督轮询间隔（默认 1s）。RpcClient 的 stdio 进程路径崩溃时**不回调**
   * onDisconnect（实测 2026.10.10：exit 只设 exitError，socket 路径才回调），
   * 崩溃检测必须由管理器按 pid 存活轮询自持。 */
  crashPollMs?: number
  /** PID 登记表路径（默认 server/data/engine-processes.json）。 */
  registryPath?: string
  /** 按项目的 spawn 附加参数（如 meta_kv 权限预设 → ["--permission-preset", 值]）。
   * spawn 参数级：变更后需重启项目引擎进程才生效。 */
  extraSpawnArgs?: (projectPath: string) => string[]
  /** 时钟（测试注入）。 */
  now?: () => number
  /** 进程探针（测试注入；默认 Linux /proc）。 */
  probe?: ProcProbe
}

export interface EngineStatusSnapshot {
  projectPath: string
  state: EngineState
  pid: number | undefined
  consecutiveRestarts: number
  lastError: string | undefined
  startedAt: number | undefined
  lastActivityAt: number
  runningSessions: string[]
  pendingPermissions: string[]
}

export type EngineManagerEvent =
  | { type: "state_changed"; projectPath: string; from: EngineState; to: EngineState }
  /** 引擎 wire 事件透传（todo 10 事件桥汇聚用）。 */
  | { type: "engine_event"; projectPath: string; event: RpcClientEvent }
  | { type: "process_crashed"; projectPath: string; pid: number | undefined; consecutiveRestarts: number }
  | { type: "engine_unavailable"; projectPath: string; reason: string }
  | { type: "engine_reclaimed"; projectPath: string; reason: "idle_timeout" }

/** 上层在进程 ready 后可注入的会话级预热钩子（如预 open 一个空闲会话）。 */
export type WarmupHook = (projectPath: string, client: RpcClient) => void | Promise<void>

/** 四型对话框请求（verification/02）+ question（q1 提问卡片）；
 * notify/setStatus/setWidget/setTitle 为 fire-and-forget 型不计。
 * question 的落定有双通道：客户端应答走 reportPermissionAnswered（与其他型同），
 * 引擎侧超时/取消走 question_resolved 事件（trackWireEvent 清除）。 */
const DIALOG_UI_METHODS = new Set(["select", "confirm", "input", "editor", "question"])

const DEFAULTS = {
  idleTimeoutMs: 30 * 60 * 1000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60 * 1000,
  maxConsecutiveFailures: 5,
  readyProbeIntervalMs: 1000,
  readyProbeMaxAttempts: 40,
  stopGraceMs: 3000,
  crashPollMs: 1000,
} as const

interface ProjectEngine {
  projectPath: string
  state: EngineState
  client: EngineClientLike | null
  pid: number | undefined
  startPromise: Promise<void> | null
  consecutiveRestarts: number
  lastError: string | undefined
  startedAt: number | undefined
  lastActivityAt: number
  runningSessions: Set<string>
  pendingPermissions: Set<string>
  idleTimer: ReturnType<typeof setTimeout> | null
  backoffTimer: ReturnType<typeof setTimeout> | null
  supervisorTimer: ReturnType<typeof setInterval> | null
  unsubEvent: (() => void) | null
}

/**
 * 解析引擎 cli 本体与 omo 插件目录（01/03 实证 spawn 规范）。
 * realpath 解析 omo-ai：bun isolated 布局下官配 senpi 在 .bun/omo-ai@<ver>/node_modules/
 * 旁路，直接从 omo-ai 包 createRequire 会被解析到宿主直依赖（04 号文档路径解析坑）。
 *
 * 三形态：
 * - npm 安装形态：esbuild 单文件 bundle 内 import.meta 位置推导失效，从自身
 *   require.resolve 解析 omo-ai；官配 senpi 在 omo-ai 的嵌套 node_modules 里
 *   （顶层被宿主直依赖 senpi 占位时 npm 自动嵌套，版本即官配对）
 * - 编译形态（历史，已退役）：发行包随附 engine/node_modules/，锚定可执行文件目录
 * - 源码形态：仓库 node_modules（bun isolated 旁路布局或 npm 提升布局均可走
 *   realpath/嵌套两级候选），锚定仓库根
 */
let resolvedEnginePaths: { cliPath: string; pluginDir: string } | null = null

const pkgRequire = createRequire(import.meta.url)

export function resolveEnginePaths(): { cliPath: string; pluginDir: string } {
  if (resolvedEnginePaths) return resolvedEnginePaths
  const candidates: string[] = []
  let pluginDir: string
  if (isCompiledBinary()) {
    // 发行包布局：engine/node_modules/{omo-ai, @code-yeongyu/senpi}
    const engineNm = join(releaseRoot(), "engine", "node_modules")
    pluginDir = join(engineNm, "omo-ai", "plugin")
    candidates.push(join(engineNm, "@code-yeongyu", "senpi", "dist", "bundle", "cli.js"))
  } else {
    // omo-ai 锚点：优先 require.resolve（npm 安装 bundle 形态唯一可行路径；
    // 源码形态下也可解析，失败退回源码相对推导）
    let omoRoot: string
    try {
      omoRoot = dirname(pkgRequire.resolve("omo-ai/package.json"))
    } catch {
      omoRoot = join(selfDir(), "..", "..", "node_modules", "omo-ai")
    }
    pluginDir = join(omoRoot, "plugin")
    try {
      const omoReal = realpathSync(omoRoot)
      // npm 布局：官配 senpi 嵌套在 omo-ai 自己的 node_modules 里（首选——版本即官配对）
      candidates.push(join(omoReal, "node_modules", "@code-yeongyu", "senpi", "dist", "bundle", "cli.js"))
      // bun isolated 布局：官配 senpi 是 omo-ai 的 .bun 旁路兄弟目录
      candidates.push(join(omoReal, "..", "@code-yeongyu", "senpi", "dist", "bundle", "cli.js"))
    } catch {
      // omo-ai 符号链接不可解析时退回常规布局
    }
    candidates.push(join(omoRoot, "node_modules", "@code-yeongyu", "senpi", "dist", "bundle", "cli.js"))
  }
  const cliPath = candidates.find((c) => existsSync(c))
  if (!cliPath) {
    const hint = isCompiledBinary()
      ? `发行包缺少引擎运行时（期望 ${candidates.join(" / ")}），请用 scripts/build-binary.ts 重新构建发行包`
      : `omo-ai 官配 senpi 引擎 bundle 缺失（已尝试：${candidates.join(" / ")}），请先安装依赖`
    throw new Error(hint)
  }
  resolvedEnginePaths = { cliPath, pluginDir }
  return resolvedEnginePaths
}

/** RpcClient 未公开进程句柄；内部 this.process 在 start() 后即引擎本体
 * （RpcClient spawn 时 pin SENPI_RUNTIME=node 阻断 launcher re-exec，execve 同 PID，
 * verification/04）。字段版本升级时需复核。 */
function extractPid(client: EngineClientLike): number | undefined {
  const proc = (client as unknown as { process?: { pid?: number } | null }).process
  return proc?.pid
}

/** RPC ping：get_protocol_info（verification/03 就绪轮询模式——超时只 reject 该次 pending，进程仍可用）。 */
async function protocolPing(client: EngineClientLike): Promise<boolean> {
  const raw = client as unknown as { send?: (m: unknown) => Promise<{ success?: boolean }> }
  if (typeof raw.send !== "function") return false
  try {
    const res = await raw.send({ type: "get_protocol_info" })
    return res?.success === true
  } catch {
    return false
  }
}

function withTimeout(p: Promise<void>, ms: number, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    p.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

const DEFAULT_FACTORY: EngineClientFactory = (opts) => new RpcClient(opts)

export class EngineProcessManager {
  private readonly opts: Required<Pick<EngineManagerOptions, "idleTimeoutMs" | "backoffBaseMs" | "backoffMaxMs" | "maxConsecutiveFailures" | "readyProbeIntervalMs" | "readyProbeMaxAttempts" | "stopGraceMs">> & EngineManagerOptions
  private readonly registry: PidRegistry
  private readonly probe: ProcProbe
  private readonly engines = new Map<string, ProjectEngine>()
  private readonly listeners = new Set<(e: EngineManagerEvent) => void>()
  private warmupHook: WarmupHook | null = null

  constructor(options: EngineManagerOptions = {}) {
    this.opts = {
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
      backoffMaxMs: options.backoffMaxMs ?? DEFAULTS.backoffMaxMs,
      maxConsecutiveFailures: options.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures,
      readyProbeIntervalMs: options.readyProbeIntervalMs ?? DEFAULTS.readyProbeIntervalMs,
      readyProbeMaxAttempts: options.readyProbeMaxAttempts ?? DEFAULTS.readyProbeMaxAttempts,
      stopGraceMs: options.stopGraceMs ?? DEFAULTS.stopGraceMs,
      ...options,
    }
    this.probe = options.probe ?? linuxProcProbe
    // 缺省锚点：源码态 server/data；编译态发行包 data/（组合根恒显式传入，此处兜底）
    const defaultRegistryPath = isCompiledBinary()
      ? join(releaseRoot(), "data", "engine-processes.json")
      : join(selfDir(), "..", "..", "data", "engine-processes.json")
    this.registry = new PidRegistry(options.registryPath ?? defaultRegistryPath)
  }

  // ---- 查询 ----

  getStatus(projectPath: string): EngineStatusSnapshot | undefined {
    const engine = this.engines.get(projectPath)
    return engine ? this.snapshot(engine) : undefined
  }

  getAllStatus(): EngineStatusSnapshot[] {
    return [...this.engines.values()].map((e) => this.snapshot(e))
  }

  /** 主连接（生产恒为官方 RpcClient；供 adapter 驾驶会话）。ready 前为 undefined。 */
  getClient(projectPath: string): RpcClient | undefined {
    const engine = this.engines.get(projectPath)
    if (!engine || engine.state !== "ready" || !engine.client) return undefined
    return engine.client as unknown as RpcClient
  }

  // ---- 事件订阅（todo 10 事件桥直接基础）----

  onEvent(listener: (e: EngineManagerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: EngineManagerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // 订阅者异常不影响管理器
      }
    }
  }

  // ---- 预热钩子 ----

  setWarmupHook(hook: WarmupHook | null): void {
    this.warmupHook = hook
  }

  private fireWarmup(engine: ProjectEngine): void {
    const hook = this.warmupHook
    const client = engine.client
    if (!hook || !client) return
    Promise.resolve()
      .then(() => hook(engine.projectPath, client as unknown as RpcClient))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[process-manager] warmup 失败 ${engine.projectPath}: ${msg}`)
      })
  }

  // ---- 生命周期 ----

  /** 确保项目引擎已 spawn 且健康检查通过。并发调用去重；unavailable 时抛错。 */
  async ensureRunning(projectPath: string): Promise<EngineStatusSnapshot> {
    const engine = this.engines.get(projectPath) ?? this.createEngine(projectPath)
    if (engine.state === "ready") return this.snapshot(engine)
    if (engine.state === "unavailable") {
      throw new Error(
        `项目引擎不可用（连续失败 ${engine.consecutiveRestarts} 次达上限）：${engine.lastError ?? "未知原因"}。需调用 recover() 显式重试`,
      )
    }
    if (engine.state === "stopping") {
      // 等关停落定再重启（避免新 client 与旧关停竞争）
      await this.stop(projectPath)
    }
    if (!engine.startPromise) {
      engine.startPromise = this.doStart(engine).finally(() => {
        engine.startPromise = null
      })
    }
    await engine.startPromise
    return this.snapshot(engine)
  }

  /** 从 unavailable 显式恢复（清零失败计数重试；API/SSE 报错后的手动/自动恢复入口）。 */
  async recover(projectPath: string): Promise<EngineStatusSnapshot> {
    const engine = this.engines.get(projectPath)
    if (engine && engine.state === "unavailable") {
      engine.consecutiveRestarts = 0
      engine.lastError = undefined
      this.transition(engine, "stopped")
    }
    return this.ensureRunning(projectPath)
  }

  private createEngine(projectPath: string): ProjectEngine {
    const engine: ProjectEngine = {
      projectPath,
      state: "stopped",
      client: null,
      pid: undefined,
      startPromise: null,
      consecutiveRestarts: 0,
      lastError: undefined,
      startedAt: undefined,
      lastActivityAt: this.now(),
      runningSessions: new Set(),
      pendingPermissions: new Set(),
      idleTimer: null,
      backoffTimer: null,
      supervisorTimer: null,
      unsubEvent: null,
    }
    this.engines.set(projectPath, engine)
    return engine
  }

  private buildSpawnOptions(engine: ProjectEngine): RpcClientOptions {
    const { cliPath, pluginDir } = resolveEnginePaths()
    const env: Record<string, string> = {
      // 显式注入 agentDir（缺省 ~/.omo/agent，与命令行版 omo 同库）：不注入时引擎按
      // 自家缺省做整目录迁移（verification/04 第 7 节陷阱——改锚后前提已变，纪律保留）
      OMO_CODING_AGENT_DIR: this.agentDir,
      SENPI_CODING_AGENT_DIR: this.agentDir,
      OMO_NATIVE: "1",
      PI_OFFLINE: "1",
    }
    const args = ["--extension", pluginDir, "--multi-session"]
    // 按项目附加参数（权限预设等 meta_kv 派生；缺省无附加）
    args.push(...(this.opts.extraSpawnArgs?.(engine.projectPath) ?? []))
    // RpcClient 约束：单 --provider 是 CLI 错误，必须成对
    const provider = this.opts.defaultProvider
    const model = this.opts.defaultModel
    return {
      cliPath,
      cwd: engine.projectPath,
      args,
      env,
      provider: provider && model ? provider : undefined,
      model: provider && model ? model : undefined,
      onDisconnect: (error) => {
        this.handleDisconnect(engine, error)
      },
    }
  }

  private async doStart(engine: ProjectEngine): Promise<void> {
    this.clearTimers(engine)
    this.transition(engine, "starting")
    try {
      const client = this.clientFactory(this.buildSpawnOptions(engine))
      engine.client = client
      engine.unsubEvent?.()
      engine.unsubEvent = client.onEvent((event) => this.trackWireEvent(engine, event))
      // spawn + launcher 握手约 2-5s（verification/01）
      await client.start()
      engine.pid = extractPid(client)
      if (engine.pid !== undefined) {
        this.registry.upsert({
          pid: engine.pid,
          projectPath: engine.projectPath,
          startedAt: this.now(),
        })
      }
      const ready = await this.waitUntilReady(engine, client)
      if (!ready) {
        throw new Error(
          `健康检查失败：get_protocol_info 轮询 ${this.opts.readyProbeMaxAttempts} 次未就绪${engine.pid ? `，stderr: ${client.getStderr().slice(-200)}` : ""}`,
        )
      }
      engine.startedAt = this.now()
      engine.lastActivityAt = this.now()
      engine.consecutiveRestarts = 0
      engine.lastError = undefined
      this.transition(engine, "ready")
      this.startSupervisor(engine)
      this.fireWarmup(engine)
      this.rescheduleIdleCheck(engine)
    } catch (err) {
      engine.lastError = err instanceof Error ? err.message : String(err)
      await this.discardClient(engine)
      this.scheduleRestart(engine)
    }
  }

  private get clientFactory(): EngineClientFactory {
    return this.opts.clientFactory ?? DEFAULT_FACTORY
  }

  private get agentDir(): string {
    return this.opts.agentDir ?? join(homedir(), ".pi", "agent")
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private async waitUntilReady(engine: ProjectEngine, client: EngineClientLike): Promise<boolean> {
    for (let attempt = 1; attempt <= this.opts.readyProbeMaxAttempts; attempt++) {
      // starting 阶段崩溃快速失败：进程已死就不用等轮询超限（onDisconnect 在
      // starting 状态不直接调度重启，由本函数的错误路径统一走退避，避免双调度）
      if (engine.pid !== undefined && !this.probe.alive(engine.pid)) return false
      if (await protocolPing(client)) return true
      await this.probe.sleep(this.opts.readyProbeIntervalMs)
    }
    return false
  }

  /** 丢弃（启动失败的）client：尽力关停防泄漏，清登记与跟踪状态。 */
  private async discardClient(engine: ProjectEngine): Promise<void> {
    const client = engine.client
    const pid = engine.pid
    engine.client = null
    engine.pid = undefined
    engine.runningSessions.clear()
    engine.pendingPermissions.clear()
    engine.unsubEvent?.()
    engine.unsubEvent = null
    if (pid !== undefined) this.registry.remove(pid)
    if (!client) return
    try {
      await withTimeout(client.stop(), this.opts.stopGraceMs, "client.stop")
    } catch {
      // 超时/失败走兜底强杀
    }
    if (pid !== undefined && this.probe.alive(pid)) {
      try {
        this.probe.signal(pid, "SIGKILL")
      } catch {
        // 已退出
      }
    }
  }

  private handleDisconnect(engine: ProjectEngine, error: unknown): void {
    // 实测（senpi 2026.10.10 rpc-client.js）：stdio 进程路径崩溃只设 exitError，
    // 不回调 onDisconnect（socket 路径才回调）。此回调当前到不了；保留作为官方
    // 未来实现进程路径回调时的兼容挂点。主检测路径是 startSupervisor 的存活轮询。
    if (engine.state !== "ready") return
    engine.lastError = error instanceof Error ? error.message : String(error)
    void this.handleCrash(engine)
  }

  /** 崩溃监督：ready 状态下按 pid 存活轮询（crashPollMs），进程消失即走重启流程。 */
  private startSupervisor(engine: ProjectEngine): void {
    this.stopSupervisor(engine)
    engine.supervisorTimer = setInterval(() => {
      if (engine.state !== "ready" || engine.pid === undefined) return
      if (!this.probe.alive(engine.pid)) {
        engine.lastError = `引擎子进程消失（pid=${engine.pid}，监督轮询检测）`
        void this.handleCrash(engine)
      }
    }, this.opts.crashPollMs)
    engine.supervisorTimer.unref?.()
  }

  private stopSupervisor(engine: ProjectEngine): void {
    if (engine.supervisorTimer) {
      clearInterval(engine.supervisorTimer)
      engine.supervisorTimer = null
    }
  }

  private async handleCrash(engine: ProjectEngine): Promise<void> {
    if (engine.state !== "ready") return
    const pid = engine.pid
    if (pid !== undefined) this.registry.remove(pid)
    this.clearTimers(engine)
    engine.client = null
    engine.pid = undefined
    engine.runningSessions.clear()
    engine.pendingPermissions.clear()
    engine.unsubEvent?.()
    engine.unsubEvent = null
    this.emit({
      type: "process_crashed",
      projectPath: engine.projectPath,
      pid,
      consecutiveRestarts: engine.consecutiveRestarts + 1,
    })
    this.scheduleRestart(engine)
  }

  /** 指数退避调度重启：1s/2s/4s...上限 60s；连续失败达上限标记 unavailable（不死循环）。 */
  private scheduleRestart(engine: ProjectEngine): void {
    if (engine.state === "backoff" || engine.state === "unavailable") return
    engine.consecutiveRestarts += 1
    if (engine.consecutiveRestarts >= this.opts.maxConsecutiveFailures) {
      this.transition(engine, "unavailable")
      this.emit({
        type: "engine_unavailable",
        projectPath: engine.projectPath,
        reason: engine.lastError ?? `连续失败 ${engine.consecutiveRestarts} 次`,
      })
      return
    }
    const delay = Math.min(
      this.opts.backoffBaseMs * 2 ** (engine.consecutiveRestarts - 1),
      this.opts.backoffMaxMs,
    )
    this.transition(engine, "backoff")
    engine.backoffTimer = setTimeout(() => {
      engine.backoffTimer = null
      // 失败已被 doStart 记录并继续调度退避；这里只兜住未预期的同步异常
      void this.ensureRunning(engine.projectPath).catch(() => {})
    }, delay)
  }

  /** 优雅关停：优先进程内 client.stop()（内建 SIGTERM→1s→SIGKILL，verification/04），
   * 兜底按 PID SIGTERM→超时→SIGKILL。 */
  async stop(projectPath: string): Promise<void> {
    const engine = this.engines.get(projectPath)
    if (!engine) return
    if (engine.state === "stopped") return
    if (engine.state === "starting" && engine.startPromise) {
      // 等启动流程落定（成功或失败）再关，避免与 doStart 竞争
      await engine.startPromise.catch(() => {})
    }
    this.clearTimers(engine)
    if (engine.state === "backoff" || engine.state === "unavailable") {
      // 无进程可关（退避期/不可用态没有活进程）
      this.transition(engine, "stopped")
      return
    }
    this.transition(engine, "stopping")
    await this.shutdownProcess(engine)
    this.transition(engine, "stopped")
  }

  async stopAll(): Promise<void> {
    const paths = [...this.engines.keys()]
    await Promise.all(paths.map((p) => this.stop(p)))
  }

  private async shutdownProcess(engine: ProjectEngine): Promise<void> {
    const client = engine.client
    const pid = engine.pid
    engine.client = null
    engine.pid = undefined
    engine.runningSessions.clear()
    engine.pendingPermissions.clear()
    engine.unsubEvent?.()
    engine.unsubEvent = null
    if (pid !== undefined) this.registry.remove(pid)
    if (!client) return
    try {
      await withTimeout(client.stop(), this.opts.stopGraceMs, "client.stop")
    } catch {
      // 超时走下方兜底
    }
    // verification/04：stop() 立即 resolve，需自行轮询 /proc 复核
    if (pid !== undefined && this.probe.alive(pid)) {
      if (!(await this.waitForExit(pid, this.opts.stopGraceMs))) {
        try {
          this.probe.signal(pid, "SIGTERM")
        } catch {
          // 已退出
        }
        if (!(await this.waitForExit(pid, 1000))) {
          try {
            this.probe.signal(pid, "SIGKILL")
          } catch {
            // 已退出
          }
          await this.waitForExit(pid, this.opts.stopGraceMs)
        }
      }
    }
  }

  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    while (this.now() < deadline) {
      if (!this.probe.alive(pid)) return true
      await this.probe.sleep(50)
    }
    return !this.probe.alive(pid)
  }

  // ---- 空闲回收 ----

  /** 空闲 = 无运行中会话 且 无挂起未应答权限请求（P0-2 实证约束）。 */
  private isIdle(engine: ProjectEngine): boolean {
    return engine.runningSessions.size === 0 && engine.pendingPermissions.size === 0
  }

  private rescheduleIdleCheck(engine: ProjectEngine): void {
    if (engine.idleTimer) {
      clearTimeout(engine.idleTimer)
      engine.idleTimer = null
    }
    if (engine.state !== "ready") return
    if (!this.isIdle(engine)) return
    const elapsed = this.now() - engine.lastActivityAt
    const remaining = Math.max(this.opts.idleTimeoutMs - elapsed, 0)
    engine.idleTimer = setTimeout(() => {
      engine.idleTimer = null
      if (engine.state !== "ready" || !this.isIdle(engine)) return
      if (this.now() - engine.lastActivityAt < this.opts.idleTimeoutMs) {
        // 定时器毫秒级抖动可能提前触发（remaining 与触发时 elapsed 踩同一边界）：
        // 重排空闲检查而非 return 丢弃，否则该次回收被永久吞掉（实测竞态，见 task-2b 证据）
        this.rescheduleIdleCheck(engine)
        return
      }
      this.emit({ type: "engine_reclaimed", projectPath: engine.projectPath, reason: "idle_timeout" })
      void this.stop(engine.projectPath).catch(() => {})
    }, remaining)
  }

  // ---- 活动上报（adapter 集成面；事件流跟踪为兜底，以下 API 为显式修正口）----

  /** adapter open 会话后上报（显式口径优先于事件流推断）。 */
  reportSessionActive(projectPath: string, sessionId: string): void {
    const engine = this.engines.get(projectPath)
    if (!engine) return
    engine.runningSessions.add(sessionId)
    engine.lastActivityAt = this.now()
    this.rescheduleIdleCheck(engine)
  }

  /** adapter close 会话后上报。 */
  reportSessionClosed(projectPath: string, sessionId: string): void {
    const engine = this.engines.get(projectPath)
    if (!engine) return
    engine.runningSessions.delete(sessionId)
    engine.lastActivityAt = this.now()
    this.rescheduleIdleCheck(engine)
  }

  /** adapter 应答权限请求后上报（应答 wire 上无事件回声，必须显式上报解除忙）。 */
  reportPermissionAnswered(projectPath: string, uiRequestId: string): void {
    const engine = this.engines.get(projectPath)
    if (!engine) return
    engine.pendingPermissions.delete(uiRequestId)
    engine.lastActivityAt = this.now()
    this.rescheduleIdleCheck(engine)
  }

  // ---- wire 事件跟踪（事件流兜底口径）----

  private trackWireEvent(engine: ProjectEngine, event: RpcClientEvent): void {
    engine.lastActivityAt = this.now()
    const anyE = event as { type?: string; sessionId?: string; method?: string; id?: string }
    switch (anyE.type) {
      case "agent_start":
        if (anyE.sessionId) engine.runningSessions.add(anyE.sessionId)
        break
      case "agent_end":
      case "agent_settled":
      case "session_closed":
        if (anyE.sessionId) engine.runningSessions.delete(anyE.sessionId)
        break
      case "extension_ui_request":
        if (anyE.method && DIALOG_UI_METHODS.has(anyE.method) && typeof anyE.id === "string") {
          engine.pendingPermissions.add(anyE.id)
        }
        break
      case "question_resolved":
        // 引擎侧落定（超时/取消/异端应答）：清忙记账，防止挂死空闲回收判定
        if (typeof anyE.id === "string") engine.pendingPermissions.delete(anyE.id)
        break
    }
    this.emit({ type: "engine_event", projectPath: engine.projectPath, event })
    this.rescheduleIdleCheck(engine)
  }

  // ---- 孤儿清扫 ----

  /** server 启动时调用：清上次遗留的引擎子进程。projectPaths 缺省时只清登记表记录。 */
  async reapOrphans(projectPaths?: string[]): Promise<OrphanReapResult> {
    let engineCliPath: string | undefined
    try {
      engineCliPath = resolveEnginePaths().cliPath
    } catch {
      // 依赖未安装等场景：判定 1 降级为 PID+cwd 双因子，判定 2 跳过
    }
    const currentPids = [...this.engines.values()]
      .map((e) => e.pid)
      .filter((p): p is number => p !== undefined)
    return reapOrphanEngines({
      probe: this.probe,
      registry: this.registry,
      managedProjectPaths: projectPaths,
      engineCliPath,
      currentPids,
      graceMs: this.opts.stopGraceMs,
    })
  }

  // ---- 内部工具 ----

  private clearTimers(engine: ProjectEngine): void {
    if (engine.idleTimer) {
      clearTimeout(engine.idleTimer)
      engine.idleTimer = null
    }
    if (engine.backoffTimer) {
      clearTimeout(engine.backoffTimer)
      engine.backoffTimer = null
    }
    this.stopSupervisor(engine)
  }

  private transition(engine: ProjectEngine, to: EngineState): void {
    if (engine.state === to) return
    const from = engine.state
    engine.state = to
    this.emit({ type: "state_changed", projectPath: engine.projectPath, from, to })
  }

  private snapshot(engine: ProjectEngine): EngineStatusSnapshot {
    return {
      projectPath: engine.projectPath,
      state: engine.state,
      pid: engine.pid,
      consecutiveRestarts: engine.consecutiveRestarts,
      lastError: engine.lastError,
      startedAt: engine.startedAt,
      lastActivityAt: engine.lastActivityAt,
      runningSessions: [...engine.runningSessions],
      pendingPermissions: [...engine.pendingPermissions],
    }
  }
}
