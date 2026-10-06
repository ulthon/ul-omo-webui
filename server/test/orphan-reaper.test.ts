/**
 * 孤儿清扫与 PID 登记表单测（内存 /proc 探针，零真实进程依赖）。
 * 安全判定红线：只有登记 PID（cwd+argv 复核）或 cwd+argv 双因子命中的进程才可杀。
 */

import { describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { PidRegistry } from "../src/engine/pid-registry"
import { reapOrphanEngines } from "../src/engine/orphan-reaper"
import { MemProbe } from "./mocks"

const CLI = "/data/engine/realpath/senpi/dist/bundle/cli.js"
const TMP = `/tmp/opencode/w2-reaper-test/registry-${Math.random().toString(36).slice(2)}.json`

function mkRegistry(): PidRegistry {
  return new PidRegistry(TMP)
}

describe("PidRegistry", () => {
  test("upsert/load/remove 往返；损坏文件容错", () => {
    const reg = mkRegistry()
    try {
      expect(reg.load()).toEqual([])
      reg.upsert({ pid: 1, projectPath: "/a", startedAt: 10 })
      reg.upsert({ pid: 2, projectPath: "/b", startedAt: 20 })
      reg.upsert({ pid: 1, projectPath: "/a", startedAt: 30 }) // 同 PID 覆盖
      expect(reg.load()).toHaveLength(2)
      expect(reg.load().find((r) => r.pid === 1)?.startedAt).toBe(30)
      reg.remove(1)
      expect(reg.load().map((r) => r.pid)).toEqual([2])
      reg.remove(999) // 不存在不抛
      expect(reg.load()).toHaveLength(1)
    } finally {
      rmSync(TMP, { force: true })
    }
  })
})

describe("reapOrphanEngines 判定 1：登记表记录", () => {
  test("登记 PID 已死 → 清记录不杀", async () => {
    const reg = mkRegistry()
    const probe = new MemProbe()
    try {
      reg.upsert({ pid: 111, projectPath: "/proj-a", startedAt: 1 })
      const result = await reapOrphanEngines({ probe, registry: reg, engineCliPath: CLI })
      expect(result.deadRecords).toEqual([111])
      expect(result.killed).toEqual([])
      expect(reg.load()).toEqual([])
      expect(probe.signals).toEqual([])
    } finally {
      rmSync(TMP, { force: true })
    }
  })

  test("登记 PID 活 + cwd 匹配 + argv 含引擎 cli → 杀（SIGTERM 优雅路径）", async () => {
    const reg = mkRegistry()
    const probe = new MemProbe()
    try {
      reg.upsert({ pid: 222, projectPath: "/proj-a", startedAt: 1 })
      probe.add(222, { cwd: "/proj-a", argv: ["node", CLI, "--extension", "/omo/plugin", "--mode", "rpc"] })
      const result = await reapOrphanEngines({ probe, registry: reg, engineCliPath: CLI, graceMs: 50 })
      expect(result.killed).toEqual([{ pid: 222, source: "registry", projectPath: "/proj-a" }])
      expect(probe.signals[0]).toEqual({ pid: 222, sig: "SIGTERM" })
      expect(reg.load()).toEqual([])
    } finally {
      rmSync(TMP, { force: true })
    }
  })

  test("登记 PID 活但 cwd 不符（PID 复用）→ 跳过不杀", async () => {
    const reg = mkRegistry()
    const probe = new MemProbe()
    try {
      reg.upsert({ pid: 333, projectPath: "/proj-a", startedAt: 1 })
      probe.add(333, { cwd: "/somewhere-else", argv: ["node", CLI] })
      const result = await reapOrphanEngines({ probe, registry: reg, engineCliPath: CLI })
      expect(result.killed).toEqual([])
      expect(result.skipped[0]?.reason).toContain("复用")
      expect(probe.signals).toEqual([])
    } finally {
      rmSync(TMP, { force: true })
    }
  })

  test("登记 PID 活 + cwd 匹配但 argv 非引擎 cli（用户进程 PID 复用）→ 跳过不杀", async () => {
    const reg = mkRegistry()
    const probe = new MemProbe()
    try {
      reg.upsert({ pid: 444, projectPath: "/proj-a", startedAt: 1 })
      probe.add(444, { cwd: "/proj-a", argv: ["vim", "notes.txt"] })
      const result = await reapOrphanEngines({ probe, registry: reg, engineCliPath: CLI })
      expect(result.killed).toEqual([])
      expect(result.skipped[0]?.reason).toContain("argv")
      expect(probe.signals).toEqual([])
    } finally {
      rmSync(TMP, { force: true })
    }
  })

  test("engineCliPath 不可得 → 判定 1 降级为 PID+cwd 双因子仍可杀", async () => {
    const reg = mkRegistry()
    const probe = new MemProbe()
    try {
      reg.upsert({ pid: 555, projectPath: "/proj-a", startedAt: 1 })
      probe.add(555, { cwd: "/proj-a", argv: ["node", "未知路径/cli.js"] })
      const result = await reapOrphanEngines({ probe, registry: reg, graceMs: 50 })
      expect(result.killed).toEqual([{ pid: 555, source: "registry", projectPath: "/proj-a" }])
    } finally {
      rmSync(TMP, { force: true })
    }
  })
})

describe("reapOrphanEngines 判定 2：管辖目录扫描（cwd+argv 双因子）", () => {
  test("cwd 精确等于管辖项目目录 且 argv 含引擎 cli → 杀 source=scan", async () => {
    const reg = mkRegistry()
    const probe = new MemProbe()
    try {
      probe.add(777, { cwd: "/proj-b", argv: ["node", CLI, "--mode", "rpc"] })
      const result = await reapOrphanEngines({
        probe,
        registry: reg,
        managedProjectPaths: ["/proj-b"],
        engineCliPath: CLI,
        graceMs: 50,
      })
      expect(result.killed).toEqual([{ pid: 777, source: "scan", projectPath: "/proj-b" }])
    } finally {
      rmSync(TMP, { force: true })
    }
  })

  test("cwd 在管辖目录但 argv 非引擎（用户 shell/编辑器）→ 绝不杀", async () => {
    const reg = mkRegistry()
    const probe = new MemProbe()
    try {
      probe.add(888, { cwd: "/proj-b", argv: ["bash"] })
      probe.add(889, { cwd: "/proj-b", argv: ["bun", "test"] })
      const result = await reapOrphanEngines({
        probe,
        registry: reg,
        managedProjectPaths: ["/proj-b"],
        engineCliPath: CLI,
      })
      expect(result.killed).toEqual([])
      expect(probe.signals).toEqual([])
    } finally {
      rmSync(TMP, { force: true })
    }
  })

  test("cwd 非管辖目录的引擎进程（其他项目/其他宿主）→ 不杀", async () => {
    const reg = mkRegistry()
    const probe = new MemProbe()
    try {
      probe.add(999, { cwd: "/other-project", argv: ["node", CLI, "--mode", "rpc"] })
      const result = await reapOrphanEngines({
        probe,
        registry: reg,
        managedProjectPaths: ["/proj-b"],
        engineCliPath: CLI,
      })
      expect(result.killed).toEqual([])
    } finally {
      rmSync(TMP, { force: true })
    }
  })

  test("currentPids 保护：本进程当前活引擎不被清扫", async () => {
    const reg = mkRegistry()
    const probe = new MemProbe()
    try {
      probe.add(101, { cwd: "/proj-b", argv: ["node", CLI, "--mode", "rpc"] })
      const result = await reapOrphanEngines({
        probe,
        registry: reg,
        managedProjectPaths: ["/proj-b"],
        engineCliPath: CLI,
        currentPids: [101],
      })
      expect(result.killed).toEqual([])
      expect(probe.signals).toEqual([])
    } finally {
      rmSync(TMP, { force: true })
    }
  })

  test("未提供管辖目录时判定 2 跳过（只跑判定 1）", async () => {
    const reg = mkRegistry()
    const probe = new MemProbe()
    try {
      probe.add(202, { cwd: "/proj-c", argv: ["node", CLI, "--mode", "rpc"] })
      const result = await reapOrphanEngines({ probe, registry: reg, engineCliPath: CLI })
      expect(result.killed).toEqual([])
    } finally {
      rmSync(TMP, { force: true })
    }
  })
})
