/**
 * 引擎进程指标采样（engine-ux-visibility 任务 1）。
 *
 * 一次性纯读采样：仅在请求处理器内执行（GET /api/engines/metrics），
 * 无定时器/无轮询循环；不触发 ensure/spawn 链（数据源 = 引擎状态快照 + /proc）。
 *
 * /proc 读取面可注入（ProcMetricsSource）：生产用 linuxProcMetricsSource（真实
 * /proc），测试注入内存表实现。与 orphan-reaper 的 ProcProbe 分离——probe 面向
 * 进程生命周期（alive/cwd/argv），本模块面向资源度量（stat/io），互不膨胀。
 *
 * 树采样算法：listPids 全表 + 每进程一次 stat 读（~几百次 1KB 同步读，一次性
 * 请求内毫秒级），按 ppid 建索引后从引擎 pid BFS 收集后代（含自身）——
 * rssBytes=自身、treeRssBytes/childCount/CPU/IO 均按树合计口径（引擎的 worker
 * 子进程才是干活主体，单进程口径会系统性低估）。
 *
 * cpuPct 口径：瞬时值需要两次采样。基线保存在采样器实例内存（pid →
 * {cpuMs, at}），首次采样（无基线）为 null，第二次请求起有值。这是请求间
 * 状态而非定时器——约束「采样仅在请求内」指不主动采样，被动携带上次请求的
 * 基线做差分不违反。cpuPct 为树合计占单核百分比，可超 100%（多核并行）。
 */

import { readFileSync, readdirSync } from "node:fs"

/** /proc/<pid>/stat 解析结果（本模块用到的字段子集；单位见字段注释） */
export interface ProcPidStat {
  /** 父进程 PID（字段 4） */
  ppid: number
  /** 驻留内存字节数（字段 24 rss 页数 × pageSize） */
  rssBytes: number
  /** 用户态 CPU 累计（字段 14，时钟滴答） */
  utimeTicks: number
  /** 内核态 CPU 累计（字段 15，时钟滴答） */
  stimeTicks: number
}

/** /proc/<pid>/io 解析结果（块设备实际 IO，不含 page cache 命中） */
export interface ProcPidIo {
  readBytes: number
  writeBytes: number
}

/** /proc 度量读取面（测试注入内存实现） */
export interface ProcMetricsSource {
  /** /proc/<pid>/stat 解析；进程不存在/不可读返回 undefined */
  stat(pid: number): ProcPidStat | undefined
  /** /proc/<pid>/io 解析；不可读（权限/不存在）返回 undefined */
  io(pid: number): ProcPidIo | undefined
  /** /proc 下全部数字 PID */
  listPids(): number[]
  /** 时钟滴答/秒（sysconf CLK_TCK；Linux x86-64 恒 100） */
  clockTicksPerSec(): number
  /** 内存页字节数（Linux x86-64 恒 4096；aarch64 主流发行版同为 4096） */
  pageSize(): number
}

/**
 * 常量依据：getconf CLK_TCK 与 getconf PAGESIZE 在本项目部署面
 * （x86-64/aarch64 Debian 系 Docker 宿主）均为 100 与 4096。Node 无公开
 * sysconf API；非 4K 页机器上 rssBytes 会按页数错算，届时把常量改为
 * 可配置即可（接口已按可注入设计，测试不受影响）。
 */
const CLK_TCK = 100
const PAGE_SIZE = 4096

/** 解析 /proc/<pid>/stat 内容。comm 可含空格与括号，取最后一个 ")" 之后按空白拆分。 */
export function parseProcStat(content: string, pageSize = PAGE_SIZE): ProcPidStat | undefined {
  const close = content.lastIndexOf(")")
  if (close < 0) return undefined
  // ")" 后剩余 " state ppid pgrp ..." 拆分后 idx0=字段3(state)，idxN=字段N+3
  const f = content.slice(close + 2).trim().split(/\s+/)
  const ppid = Number(f[1])
  const utime = Number(f[11])
  const stime = Number(f[12])
  const rssPages = Number(f[21])
  if (!Number.isFinite(ppid) || !Number.isFinite(utime) || !Number.isFinite(stime) || !Number.isFinite(rssPages)) {
    return undefined
  }
  return { ppid, rssBytes: rssPages * pageSize, utimeTicks: utime, stimeTicks: stime }
}

/** 解析 /proc/<pid>/io 内容（只取 read_bytes/write_bytes 两行） */
export function parseProcIo(content: string): ProcPidIo | undefined {
  let readBytes: number | undefined
  let writeBytes: number | undefined
  for (const line of content.split("\n")) {
    if (line.startsWith("read_bytes:")) readBytes = Number(line.slice(line.indexOf(":") + 1).trim())
    else if (line.startsWith("write_bytes:")) writeBytes = Number(line.slice(line.indexOf(":") + 1).trim())
  }
  if (readBytes === undefined || writeBytes === undefined || !Number.isFinite(readBytes) || !Number.isFinite(writeBytes)) {
    return undefined
  }
  return { readBytes, writeBytes }
}

export const linuxProcMetricsSource: ProcMetricsSource = {
  stat(pid) {
    try {
      return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"))
    } catch {
      return undefined
    }
  },
  io(pid) {
    try {
      return parseProcIo(readFileSync(`/proc/${pid}/io`, "utf8"))
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
  clockTicksPerSec() {
    return CLK_TCK
  },
  pageSize() {
    return PAGE_SIZE
  },
}

/** 单引擎一次采样结果（树口径；进程已死时 proc 字段为 null） */
export interface EngineProcSample {
  pid: number
  rssBytes: number | null
  /** 自身+全部后代 RSS 合计 */
  treeRssBytes: number | null
  /** 后代进程数（不含自身） */
  childCount: number
  /** 自身+后代 utime+stime 合计（毫秒） */
  cpuTotalMs: number | null
  /** 两次采样间的树 CPU 占比（单核=100%；首次采样 null） */
  cpuPct: number | null
  /** 自身+后代块设备 IO 合计；全部不可读为 null */
  ioBytes: { readBytes: number; writeBytes: number } | null
}

/** cpuPct 基线（采样器实例内存，请求驱动刷新） */
interface CpuBaseline {
  cpuMs: number
  at: number
}

/** 基线表软上限：防引擎换代 pid 残留累积（每条几十字节，512 条远超引擎数） */
const BASELINE_CAP = 512

export class ProcMetricsSampler {
  private readonly source: ProcMetricsSource
  private readonly baselines = new Map<number, CpuBaseline>()

  constructor(source: ProcMetricsSource = linuxProcMetricsSource) {
    this.source = source
  }

  /** 一次性采样引擎进程树（纯读 /proc + 刷新内部 cpuPct 基线）。 */
  sample(pid: number, nowMs: number): EngineProcSample {
    const stat = (pid2: number) => this.source.stat(pid2)
    const root = stat(pid)
    const dead: EngineProcSample = {
      pid,
      rssBytes: null,
      treeRssBytes: null,
      childCount: 0,
      cpuTotalMs: null,
      cpuPct: null,
      ioBytes: null,
    }
    if (!root) {
      this.baselines.delete(pid)
      return dead
    }
    // 全表 stat + ppid 索引（排除根自身防环）
    const byPpid = new Map<number, number[]>()
    for (const p of this.source.listPids()) {
      if (p === pid) continue
      const s = stat(p)
      if (!s) continue
      const bucket = byPpid.get(s.ppid)
      if (bucket) bucket.push(p)
      else byPpid.set(s.ppid, [p])
    }
    // BFS 收集后代（含自身）
    const tree: number[] = [pid]
    for (let i = 0; i < tree.length; i++) {
      for (const child of byPpid.get(tree[i]) ?? []) tree.push(child)
    }
    let treeRss = 0
    let utime = 0
    let stime = 0
    let ioRead = 0
    let ioWrite = 0
    let ioSeen = false
    for (const p of tree) {
      const s = p === pid ? root : stat(p)
      if (!s) continue
      treeRss += s.rssBytes
      utime += s.utimeTicks
      stime += s.stimeTicks
      const io = this.source.io(p)
      if (io) {
        ioSeen = true
        ioRead += io.readBytes
        ioWrite += io.writeBytes
      }
    }
    const cpuTotalMs = ((utime + stime) / this.source.clockTicksPerSec()) * 1000
    // cpuPct 差分（基线请求驱动，非定时器）
    const prev = this.baselines.get(pid)
    let cpuPct: number | null = null
    if (prev && nowMs > prev.at && cpuTotalMs >= prev.cpuMs) {
      cpuPct = ((cpuTotalMs - prev.cpuMs) / (nowMs - prev.at)) * 100
    }
    if (this.baselines.size >= BASELINE_CAP) this.baselines.clear()
    this.baselines.set(pid, { cpuMs: cpuTotalMs, at: nowMs })
    return {
      pid,
      rssBytes: root.rssBytes,
      treeRssBytes: treeRss,
      childCount: tree.length - 1,
      cpuTotalMs,
      cpuPct,
      ioBytes: ioSeen ? { readBytes: ioRead, writeBytes: ioWrite } : null,
    }
  }
}
