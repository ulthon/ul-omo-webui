/**
 * 引擎子进程 PID 登记表：持久化到 server/data/engine-processes.json。
 *
 * 用途：server 重启后孤儿引擎清扫的第一判定依据——只有本管理器自己登记过的 PID
 * 才参与清扫（配合 /proc/<pid>/cwd + argv 复核，见 orphan-reaper.ts），杜绝
 * cmdline/pkill -f 宽匹配（W1 事故红线：learnings.md 2026-10-06 误杀事故记录）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface EngineProcessRecord {
  pid: number
  projectPath: string
  startedAt: number
}

function isRecord(v: unknown): v is EngineProcessRecord {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.pid === "number" && typeof r.projectPath === "string"
}

export class PidRegistry {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  load(): EngineProcessRecord[] {
    let raw: string
    try {
      raw = readFileSync(this.filePath, "utf8")
    } catch {
      return []
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(isRecord)
    } catch {
      return []
    }
  }

  /** 原子覆写整个登记表（tmp + rename），避免并发读到半截 JSON。 */
  private save(records: EngineProcessRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(records, null, 2))
    renameSync(tmp, this.filePath)
  }

  upsert(record: EngineProcessRecord): void {
    const records = this.load().filter((r) => r.pid !== record.pid)
    records.push(record)
    this.save(records)
  }

  remove(pid: number): void {
    const before = this.load()
    const records = before.filter((r) => r.pid !== pid)
    if (records.length === before.length) return
    this.save(records)
  }
}
