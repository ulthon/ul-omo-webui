/**
 * 启动小项单测（engine-open-read-batch 任务 8）：runtime 保留 30d 三刀
 * （transcripts/reflection/facts-queue）+ 删除安全（DRY-RUN 默认、realpath 守卫、
 * claims 在途保护）+ boot git 诊断静默降级。全部走 tmp 假目录，零真实 runtime 依赖。
 */

import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { bootGitDiagnostics, memoryIdentityForProject, runRuntimeRetention } from "../src/lib/runtime-retention";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** UUIDv7 目录名：前 12 hex = Unix 毫秒 + version 7 位（tail 只取前 3 位，调用方需保证唯一） */
function uuidV7Name(atMs: number, tail = "aaaa"): string {
  const hi = atMs.toString(16).padStart(12, "0");
  return `${hi}7${tail.slice(0, 3)}-1111-2222-3333-444455556666`;
}
const TAIL_A = "a01";
const TAIL_B = "a02";
const TAIL_C = "a03";

/** 队列条目文件名：8 位日期 T 9 位毫秒 Z-12hex-8hex.json */
function queueFileName(iso: string, mid: string): string {
  const compact = iso.replace(/[-:]/g, "").replace(".", "").replace("Z", "Z");
  return `${compact}-${mid}-0000abcd.json`;
}

interface Fixture {
  root: string;
  home: string;
  outside: string;
  /** runtime 根（identity 由 memoryIdentityForProject 派生，与生产同口径） */
  runtimeOf(projectPath: string): string;
  makeRuntime(projectPath: string): string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "runtime-retention-test-"));
  const home = join(root, "home");
  const outside = join(root, "outside");
  mkdirSync(home);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside-payload");
  const runtimeOf = (projectPath: string) =>
    join(home, "agents", memoryIdentityForProject(projectPath), "runtime");
  const makeRuntime = (projectPath: string) => {
    const runtime = runtimeOf(projectPath);
    mkdirSync(join(runtime, "transcripts"), { recursive: true });
    mkdirSync(join(runtime, "reflection", "runs"), { recursive: true });
    mkdirSync(join(runtime, "reflection", "completions"), { recursive: true });
    mkdirSync(join(runtime, "facts-queue"), { recursive: true });
    return runtime;
  };
  return { root, home, outside, runtimeOf, makeRuntime };
}

/** 造一个完整假 runtime（见各用例断言的三刀目标） */
function seedRuntime(fx: Fixture, runtime: string): {
  oldTranscriptDir: string;
  recentMtimeDir: string;
  youngTranscriptDir: string;
  nonUuidDir: string;
  oldFacts: string;
  newFacts: string;
  claimedOldFacts: string;
} {
  const transcripts = join(runtime, "transcripts");
  const mkSession = (name: string, mtimeMs: number) => {
    const dir = join(transcripts, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "transcript.jsonl"), "{}\n");
    utimesSync(dir, new Date(mtimeMs), new Date(mtimeMs));
    return dir;
  };
  const t35 = NOW.getTime() - 35 * DAY_MS;
  const t1 = NOW.getTime() - 1 * DAY_MS;
  const oldTranscriptDir = mkSession(uuidV7Name(t35, TAIL_A), t35);
  // UUIDv7 创建于 35 天前但 mtime 在 1 天前：会话仍在续写，不删
  const recentMtimeDir = mkSession(uuidV7Name(t35, TAIL_B), t1);
  const youngTranscriptDir = mkSession(uuidV7Name(t1, TAIL_C), t1);
  const nonUuidDir = mkSession("not-a-uuid-dir", t35);

  // reflection：runs 1..60 与 completions 1..55（keepRuns=50 → runs 删 1..10，
  // completions 删 1..5；active.lock/pending.json 白名单外不动）
  for (let i = 1; i <= 60; i += 1) mkdirSync(join(runtime, "reflection", "runs", `reflection-run-${i}`));
  for (let i = 1; i <= 55; i += 1)
    writeFileSync(join(runtime, "reflection", "completions", `reflection-run-${i}.json`), "{}");
  writeFileSync(join(runtime, "reflection", "active.lock"), "lock");
  writeFileSync(join(runtime, "reflection", "pending.json"), "{}");

  const facts = join(runtime, "facts-queue");
  const oldFacts = join(facts, queueFileName("20261002T120000000Z", "c734bd99b34f"));
  writeFileSync(oldFacts, "{}");
  const newFacts = join(facts, queueFileName("20261105T120000000Z", "c734bd99b34f"));
  writeFileSync(newFacts, "{}");
  // 老但在途 claim（claims.json key = 文件名 slice(19)，与引擎同口径）
  const claimedOldName = queueFileName("20261001T000000000Z", "0cbc31353faa");
  const claimedOldFacts = join(facts, claimedOldName);
  writeFileSync(claimedOldFacts, "{}");
  writeFileSync(join(facts, "claims.json"), JSON.stringify({ [claimedOldName.slice(19)]: { at: "x" } }));
  writeFileSync(join(facts, "failures.json"), "{}");
  writeFileSync(join(facts, "consumed.json"), "{}");
  mkdirSync(join(facts, "cursor"));

  return { oldTranscriptDir, recentMtimeDir, youngTranscriptDir, nonUuidDir, oldFacts, newFacts, claimedOldFacts };
}

describe("runRuntimeRetention", () => {
  test("DRY-RUN 默认：零删除，可删清单正确（含仍在写豁免与在途 claim 豁免）", () => {
    const fx = makeFixture();
    try {
      const project = join(fx.root, "proj-a");
      const runtime = fx.makeRuntime(project);
      const seeded = seedRuntime(fx, runtime);

      const report = runRuntimeRetention({ memoryHome: fx.home, projects: [project], now: NOW });

      expect(report.mode).toBe("dry-run");
      expect(report.deleted).toEqual([]);
      // 三刀可删清单：老 transcripts ×1、runs 1..10、completions 1..5、facts 老×1（claimed 豁免）
      expect(report.wouldDelete).toContain(seeded.oldTranscriptDir);
      expect(report.wouldDelete).not.toContain(seeded.recentMtimeDir);
      expect(report.wouldDelete).not.toContain(seeded.youngTranscriptDir);
      expect(report.wouldDelete).not.toContain(seeded.nonUuidDir);
      expect(report.wouldDelete).not.toContain(seeded.claimedOldFacts);
      expect(report.wouldDelete).toContain(seeded.oldFacts);
      const runNames = report.wouldDelete.filter((p) => /reflection-run-\d+$/.test(p)).map((p) => basename(p)).sort((a, b) => Number(a.slice(15)) - Number(b.slice(15)));
      expect(runNames).toEqual(Array.from({ length: 10 }, (_, i) => `reflection-run-${i + 1}`));
      const completionNames = report.wouldDelete.filter((p) => /reflection-run-\d+\.json$/.test(p)).map((p) => basename(p));
      expect(completionNames).toHaveLength(5);
      // 全部文件原样在盘
      for (const p of [seeded.oldTranscriptDir, seeded.recentMtimeDir, seeded.youngTranscriptDir, seeded.nonUuidDir, seeded.oldFacts, seeded.newFacts, seeded.claimedOldFacts]) {
        expect(existsSync(p)).toBe(true);
      }
      expect(existsSync(join(runtime, "reflection", "active.lock"))).toBe(true);
      expect(existsSync(join(runtime, "facts-queue", "claims.json"))).toBe(true);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("enabled=true 实删：三刀落盘删除，台账与豁免项保留", () => {
    const fx = makeFixture();
    try {
      const project = join(fx.root, "proj-b");
      const runtime = fx.makeRuntime(project);
      const seeded = seedRuntime(fx, runtime);

      const report = runRuntimeRetention({ memoryHome: fx.home, projects: [project], now: NOW, enabled: true });

      expect(report.mode).toBe("delete");
      expect(report.deleted).toHaveLength(17); // transcripts 1 + runs 10 + completions 5 + facts 1
      expect(existsSync(seeded.oldTranscriptDir)).toBe(false);
      expect(existsSync(seeded.recentMtimeDir)).toBe(true);
      expect(existsSync(seeded.youngTranscriptDir)).toBe(true);
      expect(existsSync(seeded.nonUuidDir)).toBe(true);
      expect(existsSync(seeded.oldFacts)).toBe(false);
      expect(existsSync(seeded.newFacts)).toBe(true);
      expect(existsSync(seeded.claimedOldFacts)).toBe(true);
      expect(existsSync(join(runtime, "reflection", "runs", "reflection-run-11"))).toBe(true);
      expect(existsSync(join(runtime, "reflection", "runs", "reflection-run-10"))).toBe(false);
      expect(existsSync(join(runtime, "reflection", "completions", "reflection-run-50.json"))).toBe(true);
      expect(existsSync(join(runtime, "facts-queue", "claims.json"))).toBe(true);
      expect(existsSync(join(runtime, "facts-queue", "cursor"))).toBe(true);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("realpath 守卫：symlink 逃逸目标拒删（条目级被 dirent 白名单挡住，子目录级被守卫拒绝）", () => {
    const fx = makeFixture();
    try {
      // 条目级：transcripts 下放指向外部的 symlink（名字伪装成老 UUIDv7）
      const project = join(fx.root, "proj-c");
      const runtime = fx.makeRuntime(project);
      const t35 = NOW.getTime() - 35 * DAY_MS;
      const escapeDir = join(fx.outside, "escaped-session");
      mkdirSync(escapeDir);
      writeFileSync(join(escapeDir, "transcript.jsonl"), "escaped");
      symlinkSync(escapeDir, join(runtime, "transcripts", uuidV7Name(t35, TAIL_A)));

      // 子目录级：另一 runtime 的 reflection 整体换成指向外部的 symlink
      const project2 = join(fx.root, "proj-d");
      const runtime2 = fx.makeRuntime(project2);
      const outsideRuns = join(fx.outside, "reflection-home", "runs");
      mkdirSync(outsideRuns, { recursive: true });
      for (let i = 1; i <= 60; i += 1) mkdirSync(join(outsideRuns, `reflection-run-${i}`));
      rmSync(join(runtime2, "reflection"), { recursive: true, force: true });
      symlinkSync(join(fx.outside, "reflection-home"), join(runtime2, "reflection"));

      const report = runRuntimeRetention({ memoryHome: fx.home, projects: [project, project2], now: NOW, enabled: true });

      // 条目级 symlink：lstat 非目录，不进清单，外部内容原样
      expect(existsSync(join(escapeDir, "transcript.jsonl"))).toBe(true);
      expect(report.deleted.some((p) => basename(p) === "transcript.jsonl")).toBe(false);
      // 子目录级 symlink：被裁的 10 个逃逸目标全部被 realpath 守卫拒绝（60-50=10），
      // 外加 reflection 子目录自身的子目录守卫拒绝，共 11 条
      expect(report.rejectedOutsideRoot.filter((p) => p.includes("reflection-run")).length).toBe(10);
      expect(report.rejectedOutsideRoot.some((p) => !p.includes("reflection-run") && p.endsWith("reflection"))).toBe(true);
      for (let i = 1; i <= 60; i += 1) {
        expect(existsSync(join(outsideRuns, `reflection-run-${i}`))).toBe(true);
      }
      expect(report.deleted.some((p) => p.includes("reflection-run"))).toBe(false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("claims 台账损坏：facts-queue 整刀跳过（transcripts 刀不受影响）", () => {
    const fx = makeFixture();
    try {
      const project = join(fx.root, "proj-e");
      const runtime = fx.makeRuntime(project);
      const seeded = seedRuntime(fx, runtime);
      writeFileSync(join(runtime, "facts-queue", "claims.json"), "{broken-json");

      const report = runRuntimeRetention({ memoryHome: fx.home, projects: [project], now: NOW, enabled: true });

      expect(report.skippedFactsClaims).toHaveLength(1);
      expect(existsSync(seeded.oldFacts)).toBe(true);
      expect(existsSync(seeded.oldTranscriptDir)).toBe(false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("runtime 缺失的项目跳过不报错；同一 identity 去重", () => {
    const fx = makeFixture();
    try {
      const project = join(fx.root, "proj-missing");
      const report = runRuntimeRetention({ memoryHome: fx.home, projects: [project, project], now: NOW });
      expect(report.skippedRuntimes).toHaveLength(1);
      expect(report.runtimeRoots).toEqual([]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe("bootGitDiagnostics", () => {
  test("非 git 目录：静默降级不抛（inRepo=false）", () => {
    const fx = makeFixture();
    try {
      const r = bootGitDiagnostics({ cwd: fx.root });
      expect(r.gitAvailable).toBe(true);
      expect(r.inRepo).toBe(false);
      expect(r.commit).toBeNull();
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("git 二进制不存在：gitAvailable=false 静默不抛", () => {
    const r = bootGitDiagnostics({ gitBinary: "/nonexistent-git-binary-xyz" });
    expect(r.gitAvailable).toBe(false);
    expect(r.inRepo).toBe(false);
  });

  test("本 worktree cwd：inRepo=true 且 commit 形如对象名", () => {
    const r = bootGitDiagnostics();
    expect(r.gitAvailable).toBe(true);
    expect(r.inRepo).toBe(true);
    expect(r.commit).toMatch(/^[0-9a-f]{40,64}$/);
  });
});
