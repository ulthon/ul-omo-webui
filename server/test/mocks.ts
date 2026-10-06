/**
 * 单测共享 mock：FakeRpcClient（mock 子进程事件面）与 MemProbe（内存 /proc 替身）。
 * 本文件不被 bun test 当测试执行（无 *.test. 命名）。
 */

import { type RpcClientEvent, type RpcClientOptions, type EngineClientLike } from "../src/engine/process-manager"
import type { ProcProbe } from "../src/engine/orphan-reaper"

export type WireEvent = RpcClientEvent | (Record<string, unknown> & { type: string })

/** mock 子进程：可手动 emit wire 事件、crash() 模拟 transport 断开、控制健康检查与 stop 行为。 */
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
  probeAttempts = 0

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
    this.probeAttempts++
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
