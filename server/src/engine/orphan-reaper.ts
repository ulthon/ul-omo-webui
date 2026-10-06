/**
 * 启动孤儿清扫：清掉 server 上次运行遗留的引擎子进程。
 *
 * 安全判定（W1 事故红线，learnings.md：pkill -f 宽匹配曾误杀并行任务引擎进程）：
 * 只允许两种判定路径——
 * 1. 登记表（PidRegistry）记录的 PID，且 /proc/<pid>/cwd 复核等于登记的项目目录、
 *    argv 精确包含本管理器 spawn 的引擎 cli 本体路径；
 * 2. /proc/<pid>/cwd 精确等于本管理器管辖的项目目录，且 argv 同样精确含引擎 cli。
 *
 * argv 全等比较不是 cmdline 子串/正则宽匹配：宽匹配会命中任何命令行里"提到"该
 * 字符串的进程；这里要求 argv 数组中某一项与 cli 路径完全相等。
 *
 * 判定 2 在"仅 cwd 匹配"之上追加 argv 复核：产品项目目录是用户真实工作目录，
 * 用户在项目目录跑的 shell/编辑器进程 cwd 同样匹配，仅凭 cwd 单因子会误杀
 * （W1 spike 的专属隔离目录使 cwd 单因子恰好安全，产品化必须双因子）。
 */

import { readdirSync, readFileSync, realpathSync } from "node:fs"
import type { PidRegistry } from "./pid-registry"

/** 进程探针：默认走 Linux /proc，测试注入内存实现。 */
export interface ProcProbe {
  /** 进程存活（/proc/<pid> 存在且非 zombie）。 */
  alive(pid: number): boolean
  /** /proc/<pid>/cwd 解析结果；不可读（已退出/无权限）返回 undefined。 */
  cwd(pid: number): string | undefined
  /** /proc/<pid>/cmdline 按 \0 拆分的 argv；不可读返回 undefined。 */
  argv(pid: number): string[] | undefined
  /** /proc 下全部数字 PID。 */
  listPids(): number[]
  signal(pid: number, sig: NodeJS.Signals): void
  sleep(ms: number): Promise<void>
}

export const linuxProcProbe: ProcProbe = {
  alive(pid) {
    try {
      // stat 形如 "123 (cat) R ..."；comm 可含空格与括号，取最后一个 ")" 之后的字段
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const close = stat.lastIndexOf(")")
      const state = stat.slice(close + 2, close + 3)
      return state !== "Z" // zombie 已死，只等收尸
    } catch {
      return false
    }
  },
  cwd(pid) {
    try {
      return realpathSync(`/proc/${pid}/cwd`)
    } catch {
      return undefined
    }
  },
  argv(pid) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
    } catch {
      return undefined
    }
  },
  listPids() {
    try {
      return readdirSync("/proc")
        .filter((s) => /^\d+$/.test(s))
        .map(Number)
    } catch {
      return []
    }
  },
  signal(pid, sig) {
    process.kill(pid, sig)
  },
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  },
}

export interface OrphanReapResult {
  killed: Array<{ pid: number; source: "registry" | "scan"; projectPath: string }>
  skipped: Array<{ pid: number; reason: string }>
  /** 登记表里已死亡的记录（进程自然退出，仅清记录）。 */
  deadRecords: number[]
}

async function waitForExit(probe: ProcProbe, pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!probe.alive(pid)) return true
    await probe.sleep(50)
  }
  return !probe.alive(pid)
}

export async function reapOrphanEngines(opts: {
  probe: ProcProbe
  registry: PidRegistry
  /** 本管理器管辖的项目目录（判定 2 的扫描范围）；缺省时只跑判定 1。 */
  managedProjectPaths?: string[]
  /** 引擎 cli 本体精确路径（argv 复核用）；缺省时判定 1 降级为 PID+cwd 双因子、判定 2 跳过。 */
  engineCliPath?: string
  /** 本进程当前活跃引擎 PID（防御：绝不误伤自己 spawn 的进程）。 */
  currentPids?: number[]
  graceMs?: number
}): Promise<OrphanReapResult> {
  const { probe, registry } = opts
  const graceMs = opts.graceMs ?? 1500
  const result: OrphanReapResult = { killed: [], skipped: [], deadRecords: [] }
  const protectedPids = new Set<number>([process.pid, ...(opts.currentPids ?? [])])
  const handled = new Set<number>()

  const killWithGrace = async (pid: number): Promise<boolean> => {
    if (protectedPids.has(pid)) return false
    try {
      probe.signal(pid, "SIGTERM")
    } catch {
      return false
    }
    if (await waitForExit(probe, pid, graceMs)) return true
    try {
      probe.signal(pid, "SIGKILL")
    } catch {
      // SIGTERM 宽限内已退出
    }
    return waitForExit(probe, pid, graceMs)
  }

  // 判定 1：登记表记录的 PID
  for (const record of registry.load()) {
    if (handled.has(record.pid)) continue
    handled.add(record.pid)
    if (!probe.alive(record.pid)) {
      registry.remove(record.pid)
      result.deadRecords.push(record.pid)
      continue
    }
    if (protectedPids.has(record.pid)) {
      // 本进程当前活引擎不应出现在登记表（stop 会清）；防御性清理
      registry.remove(record.pid)
      result.skipped.push({ pid: record.pid, reason: "本进程活跃引擎" })
      continue
    }
    const cwd = probe.cwd(record.pid)
    if (cwd !== record.projectPath) {
      // PID 已被系统复用或项目目录已改名——不是我们的孤儿，绝不杀
      registry.remove(record.pid)
      result.skipped.push({ pid: record.pid, reason: `PID 疑似复用（cwd=${cwd ?? "不可读"} 与登记不符）` })
      continue
    }
    if (opts.engineCliPath) {
      const argv = probe.argv(record.pid)
      if (!argv?.includes(opts.engineCliPath)) {
        registry.remove(record.pid)
        result.skipped.push({ pid: record.pid, reason: "cwd 匹配但 argv 非引擎 cli，PID 疑似复用" })
        continue
      }
    }
    // engineCliPath 不可得时降级为"登记 PID + cwd 双因子"：记录本身出自本管理器，可信度足够
    if (await killWithGrace(record.pid)) {
      result.killed.push({ pid: record.pid, source: "registry", projectPath: record.projectPath })
    } else {
      result.skipped.push({ pid: record.pid, reason: "终止失败" })
    }
    registry.remove(record.pid)
  }

  // 判定 2：扫描 /proc——cwd 精确等于管辖项目目录 且 argv 精确含引擎 cli 本体
  if (opts.managedProjectPaths?.length && opts.engineCliPath) {
    const managed = new Set(opts.managedProjectPaths)
    for (const pid of probe.listPids()) {
      if (protectedPids.has(pid) || handled.has(pid)) continue
      const cwd = probe.cwd(pid)
      if (cwd === undefined || !managed.has(cwd)) continue
      const argv = probe.argv(pid)
      if (!argv?.includes(opts.engineCliPath)) continue
      handled.add(pid)
      if (await killWithGrace(pid)) {
        result.killed.push({ pid, source: "scan", projectPath: cwd })
      } else {
        result.skipped.push({ pid, reason: "终止失败" })
      }
    }
  }

  return result
}
