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
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { isCompiledBinary, releaseRoot, selfDir } from "../runtime-paths"
import { log } from "../obs/logger"
import { PidRegistry } from "./pid-registry"
import { RPC_CLIENT_CAPABILITIES_ENV } from "./rpc-capabilities"
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
  /** 健康守卫 ping 超时（默认 3s，短有界：挂死引擎快速判死走重拉）。 */
  healthPingTimeoutMs?: number
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
  /** 就绪试写门禁开关（docs08-2026-10-23-24-batch 任务 7）：on=握手后试写探针
   * 会话落盘通过才标 ready；off=现行为（t5 健康检查通过即 ready）。缺省按环境
   * 变量 SENPI_ENGINE_PROBE_GATE 解析（默认开，见 parseProbeGateEnv）。 */
  probeGate?: boolean
  /** 试写探针的有界等待上限（默认 5s：open_session 响应 + 探针文件落盘合计）。 */
  probeWriteTimeoutMs?: number
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
  healthPingTimeoutMs: 3000,
  stopGraceMs: 3000,
  crashPollMs: 1000,
  probeWriteTimeoutMs: 15000,
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

/** 注册表 projectPath 合法性（docs08-2026-10-23-24-batch 任务 6）：拒绝文件系统根
 * （"/"、"//" 等 resolve 后为根的形态）与空串——10-24 事发现场曾登记过 "/" 项目。 */
export function isRegistrableProjectPath(projectPath: string): boolean {
  if (!projectPath) return false
  return resolve(projectPath) !== "/"
}

/** cwd -> 会话库目录编码（与 adapter encodeCwdToSessionDirName 同算法：去前导 /，
 * / 换 -，包 --...--；engine 层不反向依赖 api/adapter，就地复制）。 */
function encodeProbeSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`
}

/** 就绪门禁环境变量解析（任务 7）：
 * - "0"/"false"/"off" → 关（一键逃生口）；
 * - "1"/"true"/"on" → 开；
 * - 未设置/空 → 默认开（计划书任务 7：开关默认开启但必须可一键关闭）；
 * - 其它值 → 按默认开处理并告警（每个不同非法值只告警一次，防日志刷屏）。 */
const probeGateWarnedValues = new Set<string>()
export function parseProbeGateEnv(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase()
  if (v === "" ) return true
  if (["0", "false", "off"].includes(v)) return false
  if (["1", "true", "on"].includes(v)) return true
  if (!probeGateWarnedValues.has(v)) {
    probeGateWarnedValues.add(v)
    console.warn(
      `[process-manager] SENPI_ENGINE_PROBE_GATE 非法值 ${JSON.stringify(value)}，按默认（开）处理；合法值：1/true/on 开，0/false/off 关`,
    )
  }
  return true
}

const DEFAULT_FACTORY: EngineClientFactory = (opts) => new RpcClient(opts)

export class EngineProcessManager {
  private readonly opts: Required<Pick<EngineManagerOptions, "idleTimeoutMs" | "backoffBaseMs" | "backoffMaxMs" | "maxConsecutiveFailures" | "readyProbeIntervalMs" | "readyProbeMaxAttempts" | "healthPingTimeoutMs" | "stopGraceMs" | "probeWriteTimeoutMs">> & EngineManagerOptions
  private readonly registry: PidRegistry
  private readonly probe: ProcProbe
  private readonly probeGateEnabled: boolean
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
      healthPingTimeoutMs: options.healthPingTimeoutMs ?? DEFAULTS.healthPingTimeoutMs,
      stopGraceMs: options.stopGraceMs ?? DEFAULTS.stopGraceMs,
      probeWriteTimeoutMs: options.probeWriteTimeoutMs ?? DEFAULTS.probeWriteTimeoutMs,
      ...options,
    }
    this.probe = options.probe ?? linuxProcProbe
    this.probeGateEnabled = options.probeGate ?? parseProbeGateEnv(process.env.SENPI_ENGINE_PROBE_GATE)
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
    // 采集增强批：生命周期事件常开观测（engine_event 帧级在事件桥 publish 侧，不在此重复）
    switch (event.type) {
      case "state_changed":
        log.info("engine", "state", { proj: event.projectPath, from: event.from, to: event.to })
        break
      case "process_crashed":
        log.warn("engine", "crash", { proj: event.projectPath, pid: event.pid, restarts: event.consecutiveRestarts })
        break
      case "engine_unavailable":
        log.error("engine", "unavailable", { proj: event.projectPath, reason: event.reason })
        break
      case "engine_reclaimed":
        log.info("engine", "reclaimed", { proj: event.projectPath, reason: event.reason })
        break
      case "engine_event":
        break
    }
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
        log.warn("engine", "warmup_fail", { proj: engine.projectPath, msg: msg.slice(0, 300) })
      })
  }

  // ---- 生命周期 ----

  /** 确保项目引擎已 spawn 且健康检查通过。并发调用去重；unavailable 时抛错。 */
  async ensureRunning(projectPath: string): Promise<EngineStatusSnapshot> {
    const engine = this.engines.get(projectPath) ?? this.createEngine(projectPath)
    if (engine.state === "ready") {
      // 健康守卫（任务 5）：换引擎前先短超时 RPC ping 现有引擎——健康直接复用
      // （不重拉、不搅动注册表）；ping 失败/超时或 pid 已死按崩溃处理（杀残留
      // 进程、清注册表行）后走下方 doStart 重拉。ping 一次 get_protocol_info 是
      // 本地子进程单往返，量级远小于 spawn+握手，换取挂死引擎的快速自愈。
      if (engine.client && (await this.pingBounded(engine))) {
        return this.snapshot(engine)
      }
      const deadPid = engine.pid
      engine.lastError = `健康守卫：现有引擎 ping 未通过（pid=${deadPid ?? "?"}），按崩溃处理重拉`
      await this.discardClient(engine) // 杀仍存活的挂死进程 + 清注册表行
      this.emit({
        type: "process_crashed",
        projectPath: engine.projectPath,
        pid: deadPid,
        consecutiveRestarts: engine.consecutiveRestarts + 1,
      })
      this.scheduleRestart(engine) // 计数/退避语义与真实崩溃一致；随后的 doStart 清退避定时器立即重拉
    }
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
      // 客户端能力声明（docs08-r6 任务 5）：本函数是生产组合（engine-runtime
      // clientFactory）实际走的 spawn 路径，引擎在 rpc-mode 启动时读一次该 env；
      // stdio 下 set_client_info 的能力面是静默空操作，env 缺失即提问卡片降级。
      // 单一来源见 ./rpc-capabilities.ts（与 senpi-adapter 自建 RpcClient 共用）。
      ...RPC_CLIENT_CAPABILITIES_ENV,
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
      // 注册表 projectPath 校验（docs08-2026-10-23-24-batch 任务 6）：10-24 事发现场
      // 曾出现 "/" 项目（slug 形态 ----）污染注册表——文件系统根目录不是合法项目，
      // 拒绝登记（清扫仅按登记表判定，脏行只会误导 orphan-reaper）。引擎本身照常运行。
      if (engine.pid !== undefined) {
        if (!isRegistrableProjectPath(engine.projectPath)) {
          console.warn(
            `[process-manager] 拒绝登记非法项目路径（文件系统根/空）：${JSON.stringify(engine.projectPath)}`,
          )
        } else {
          this.registry.upsert({
            pid: engine.pid,
            projectPath: engine.projectPath,
            startedAt: this.now(),
          })
        }
      }
      const ready = await this.waitUntilReady(engine, client)
      if (!ready) {
        throw new Error(
          `健康检查失败：get_protocol_info 轮询 ${this.opts.readyProbeMaxAttempts} 次未就绪${engine.pid ? `，stderr: ${client.getStderr().slice(-200)}` : ""}`,
        )
      }
      // 就绪试写门禁（docs08-2026-10-23-24-batch 任务 7，顺序邁守计划书约定：
      // 健康检查→落盘回传→cwd 校验→试写门禁最后上）：握手通过后、标 ready/承接
      // 流量前，用一次性探针会话验证引擎写路径真实落盘（t1 根因：引擎口头认领
      // 不写盘）。失败/超时/畸形响应不标 ready，按 t5 崩溃语义重拉并回传结构化
      // 错误（lastError 携带 probe_gate_failed 码，与 t6 session_not_persisted 同族
      // 机器可读约定）。开关 probeGate 可一键关闭（默认开，env SENPI_ENGINE_PROBE_GATE）。
      if (this.probeGateEnabled) {
        const probeOk = await this.runProbeWriteGate(engine, client)
        if (!probeOk) {
          this.emit({
            type: "process_crashed",
            projectPath: engine.projectPath,
            pid: engine.pid,
            consecutiveRestarts: engine.consecutiveRestarts + 1,
          })
          throw new Error(
            `[probe_gate_failed] 就绪门禁：试写探针未通过（open_session 未落盘/响应畸形/超时，projectPath=${JSON.stringify(engine.projectPath)}）`,
          )
        }
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

  /** 就绪试写门禁（任务 7）：一次性探针会话验证写路径落盘。设计要点：
   * - 探针 id 前缀 `__probe__`（可识别、用后即焚）：引擎侧 close_session + 本地
   *   探针文件删除，不污染用户会话列表/别名表/claims（全部在 process-manager
   *   层内闭环，不经过 EngineRuntimeRegistry）；
   * - 响应严格校验：success=true 且 data.state.sessionId/sessionFile 为字符串且
   *   sessionFile 必须就是本探针路径（引擎认领到其它路径视为畸形，不放行）；
   * - 有界等待：open_session 与文件落盘均受 probeWriteTimeoutMs 上限（时钟
   *   可注入 now，等待步进走 probe.sleep 可注入）；
   * - 任何异常/超时/畸形 → false（门禁失败），无挂死风险。 */
  private async runProbeWriteGate(engine: ProjectEngine, client: EngineClientLike): Promise<boolean> {
    const probeId = `__probe__${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const probeDir = join(this.agentDir, "sessions", encodeProbeSessionDirName(engine.projectPath))
    const probePath = join(probeDir, `${probeId}.jsonl`)
    const send = (client as unknown as { send?: (m: unknown) => Promise<unknown> }).send
    if (typeof send !== "function") return false
    try {
      mkdirSync(probeDir, { recursive: true })
      const res = await this.bounded(
        send.call(client, {
          type: "open_session",
          sessionPath: probePath,
          ...(this.opts.defaultProvider && this.opts.defaultModel
            ? { provider: this.opts.defaultProvider, modelId: this.opts.defaultModel }
            : {}),
        }),
      )
      // 响应严格校验（malformed-input 类：垃圾/HTML/非 JSON 形态在此一律失败）
      const env = res as { success?: unknown; data?: { sessionId?: unknown; state?: unknown } | null } | null | undefined
      if (!env || env.success !== true || typeof env.data !== "object" || env.data === null) {
        log.warn("engine", "probe_gate", { step: "响应非成功帧", detail: JSON.stringify(env)?.slice(0, 300) })
        return false
      }
      const state = env.data.state
      if (typeof state !== "object" || state === null) {
        log.warn("engine", "probe_gate", { step: "state 缺失/非对象", detail: JSON.stringify(state)?.slice(0, 200) })
        return false
      }
      const claimedId = (state as { sessionId?: unknown }).sessionId
      const claimedPath = (state as { sessionFile?: unknown }).sessionFile
      if (typeof claimedId !== "string" || claimedId === "") {
        log.warn("engine", "probe_gate", { step: "sessionId 非法", detail: JSON.stringify(claimedId)?.slice(0, 100) })
        return false
      }
      // 认领路径必须是本探针路径（防误导性成功：引擎拿其它会话文件充数）
      if (typeof claimedPath !== "string" || resolve(claimedPath) !== resolve(probePath)) {
        log.warn("engine", "probe_gate", { step: "sessionFile 不匹配", claimed: String(claimedPath).slice(0, 200), probe: probePath })
        return false
      }
      // 有界等待探针文件落盘（t6 同族判定：磁盘为准，不以口头认领为准）
      const deadline = this.now() + this.opts.probeWriteTimeoutMs
      while (!existsSync(probePath) && this.now() < deadline) {
        await this.probe.sleep(25)
      }
      if (!existsSync(probePath)) {
        log.warn("engine", "probe_gate", { step: "探针文件未落盘", waited: this.opts.probeWriteTimeoutMs, probe: probePath })
        return false
      }
      return true
    } catch (e) {
      log.warn("engine", "probe_gate", { step: "异常", detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
      return false
    } finally {
      // 即焚：引擎侧关会话 + 本地探针文件删除（成功失败两向都清，防残留）
      try {
        await this.bounded(send.call(client, { type: "close_session", sessionId: undefined }))
      } catch {
        // 关不掉不阻塞门禁结论（进程即将被丢弃/或已 ready 由后续清理兜底）
      }
      try {
        rmSync(probePath, { force: true })
      } catch {
        // 尽力清理
      }
    }
  }

  /** 有界等待一个 promise：超时臂走 probe.sleep（测试可注入），超时 reject。 */
  private bounded<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolveP, rejectP) => {
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }
      void this.probe.sleep(this.opts.probeWriteTimeoutMs ?? DEFAULTS.probeWriteTimeoutMs).then(() =>
        settle(() => rejectP(new Error(`probe 超时（${this.opts.probeWriteTimeoutMs ?? DEFAULTS.probeWriteTimeoutMs}ms）`))),
      )
      void p.then(
        (v: T) => settle(() => resolveP(v)),
        (e: unknown) => settle(() => rejectP(e instanceof Error ? e : new Error(String(e)))),
      )
    })
  }

  /** 有界健康 ping：协议层复用 protocolPing（get_protocol_info），超时臂走
   * probe.sleep（测试可注入确定时钟）；任一臂先落定即定音，失败/超时一律 false。 */
  private async pingBounded(engine: ProjectEngine): Promise<boolean> {
    const client = engine.client
    if (!client) return false
    if (engine.pid !== undefined && !this.probe.alive(engine.pid)) return false
    return new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean) => {
        if (!settled) {
          settled = true
          resolve(ok)
        }
      }
      void this.probe.sleep(this.opts.healthPingTimeoutMs).then(() => done(false))
      void protocolPing(client).then((ok) => done(ok), () => done(false))
    })
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
