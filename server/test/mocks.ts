/**
 * 单测共享 mock：FakeRpcClient（mock 子进程事件面）与 MemProbe（内存 /proc 替身）。
 * 本文件不被 bun test 当测试执行（无 *.test. 命名）。
 */

import { type RpcClientEvent, type RpcClientOptions, type EngineClientLike } from "../src/engine/process-manager"
import type { ProcProbe } from "../src/engine/orphan-reaper"
import { writeFileSync } from "node:fs"

export type WireEvent = RpcClientEvent | (Record<string, unknown> & { type: string })

/** mock 子进程：可手动 emit wire 事件、crash() 模拟 transport 断开、控制健康检查与 stop 行为。
 * 就绪门禁（docs08 任务 7）：默认以「健康引擎」姿态处理探针 open_session（真实写盘
 * + 规范响应）；可编程切换认领不落盘/垃圾响应/挂死/认领其它路径四种病态。 */
export class FakeRpcClient implements EngineClientLike {
  static nextPid = 5000

  readonly spawnOpts: RpcClientOptions
  process: { pid: number }
  started = false
  stopCount = 0
  /** stop() 挂死不返回（测优雅关停兜底强杀路径）。 */
  stopHang = false
  /** 健康检查前 N 次 ping 抛超时（默认 0）。 */
  probeFailures = 0
  /** 健康检查永久失败（测轮询超限）。 */
  probeAlwaysFail = false
  /** send 永不落定（测健康守卫 ping 超时臂）。 */
  probeHang = false
  probeAttempts = 0
  /** 门禁探针：认领成功但不写盘（t1 病态）。 */
  probeClaimOnly = false
  /** 门禁探针：open_session 回垃圾响应（非规范结构）。 */
  probeOpenGarbage = false
  /** 门禁探针：open_session 挂死不落定。 */
  probeOpenHang = false
  /** 门禁探针：认领到其它路径（误导性成功）。 */
  probeClaimOtherPath = false
  /** 探针 open_session 收到的 sessionPath（断言门禁确实发过探针）。 */
  readonly probeOpened: string[] = []
  /** 引擎侧当前仍打开的探针会话（即焚验证：门禁收尾后应为空）。 */
  readonly probeSessionsOpen: string[] = []
  probeCloseCalls = 0

  private listeners: Array<(e: RpcClientEvent) => void> = []
  private disconnectCb: ((error: unknown) => void) | undefined

  constructor(opts: RpcClientOptions) {
    this.spawnOpts = opts
    this.process = { pid: ++FakeRpcClient.nextPid }
    this.disconnectCb = opts.onDisconnect as ((error: unknown) => void) | undefined
  }

  get pid(): number {
    return this.process.pid
  }

  async start(): Promise<void> {
    this.started = true
  }

  async stop(): Promise<void> {
    this.stopCount++
    if (this.stopHang) return new Promise<void>(() => {})
    this.started = false
  }

  onEvent(listener: (e: RpcClientEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  emit(event: WireEvent): void {
    for (const l of [...this.listeners]) l(event as RpcClientEvent)
  }

  /** 模拟引擎子进程被杀（transport 断开）。 */
  crash(reason = "Agent process exited (code=null signal=SIGKILL)"): void {
    this.started = false
    this.disconnectCb?.(new Error(reason))
  }

  async send(message: unknown): Promise<{ success: boolean; data: unknown }> {
    const msg = message as { type?: string; sessionPath?: string }
    // 门禁探针面：独立于健康检查计数（probeAttempts 语义保持不变）
    if (msg?.type === "open_session") {
      const sessionPath = String(msg.sessionPath ?? "")
      if (!sessionPath.includes("__probe__")) {
        // 非探针 open（门禁外场景）：按健康引擎规范响应但不落盘语义不变
        return { success: true, data: { sessionId: "rpc-x", state: { sessionId: "d-x", sessionFile: sessionPath } } }
      }
      this.probeOpened.push(sessionPath)
      this.probeSessionsOpen.push(sessionPath)
      if (this.probeOpenHang) return new Promise(() => {})
      if (this.probeOpenGarbage) {
        return { success: true, data: { html: "<html>garbage</html>" } }
      }
      const claimed = this.probeClaimOtherPath
        ? sessionPath.replace("__probe__", "__other__")
        : sessionPath
      if (!this.probeClaimOnly) {
        writeFileSync(claimed, `${JSON.stringify({ type: "session", version: 3, id: "probe", cwd: "/probe" })}\n`)
      }
      return {
        success: true,
        data: { sessionId: `rpc-probe-${this.probeOpened.length}`, state: { sessionId: "__probe__durable", sessionFile: claimed } },
      }
    }
    if (msg?.type === "close_session") {
      this.probeCloseCalls += 1
      const idx = this.probeSessionsOpen.length - 1
      if (idx >= 0) this.probeSessionsOpen.splice(idx, 1)
      return { success: true, data: {} }
    }
    this.probeAttempts++
    if (this.probeHang) return new Promise(() => {})
    if (this.probeAlwaysFail || this.probeAttempts <= this.probeFailures) {
      throw new Error(`request deadline exceeded (${JSON.stringify(message)})`)
    }
    return { success: true, data: { engineVersion: "test" } }
  }

  getStderr(): string {
    return ""
  }
}

/** 内存进程表：map 里存在即存活，signal 后移除。 */
export class MemProbe implements ProcProbe {
  readonly procs = new Map<number, { cwd?: string; argv?: string[]; zombie?: boolean }>()
  readonly signals: Array<{ pid: number; sig: NodeJS.Signals }> = []

  add(pid: number, info: { cwd?: string; argv?: string[] } = {}): void {
    this.procs.set(pid, info)
  }

  alive(pid: number): boolean {
    const p = this.procs.get(pid)
    return !!p && !p.zombie
  }

  cwd(pid: number): string | undefined {
    return this.procs.get(pid)?.cwd
  }

  argv(pid: number): string[] | undefined {
    return this.procs.get(pid)?.argv
  }

  listPids(): number[] {
    return [...this.procs.keys()]
  }

  signal(pid: number, sig: NodeJS.Signals): void {
    this.signals.push({ pid, sig })
    this.procs.delete(pid)
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
