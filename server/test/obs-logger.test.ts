/**
 * 2026-10-31 日志采集增强批：obs 统一日志器单测。
 * 覆盖：
 * 1. 级别过滤：默认 info 时 debug/trace 零输出零入缓冲；warn/error 恒过；
 * 2. 行契约：时间/级别字符/seq/模块/事件/字段渲染（含空白引号包裹、数值 1 位小数、
 *    缺省占位"-"）；
 * 3. 环形缓冲：容量淘汰 O(1) 语义（最旧被挤掉、有序快照旧→新）；
 * 4. 文件落盘：注入目录真实写文件（行数=条数、跨天滚动、retainDays 清理）、
 *    dir=null 零文件、连续失败 3 次禁用并告警一次；
 * 5. parseLevel 入参矩阵。
 */
import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLogLine, ObsLogger, type LogEntry } from "../src/obs/logger";
import { levelValue, parseLevel, type LogLevel } from "../src/obs/level";

function makeLogger(overrides: Partial<ConstructorParameters<typeof ObsLogger>[0]> = {}) {
  const lines: string[] = [];
  const logger = new ObsLogger({
    level: "info",
    capacity: 8,
    dir: null,
    stderr: (l) => lines.push(l),
    now: () => new Date("2026-10-31T09:15:32.123Z"),
    ...overrides,
  });
  return { logger, lines };
}

describe("parseLevel", () => {
  test("合法值大小写不敏感", () => {
    expect(parseLevel("DEBUG")).toBe("debug");
    expect(parseLevel(" warn ")).toBe("warn");
  });
  test("缺失/非法返回 null", () => {
    expect(parseLevel(undefined)).toBeNull();
    expect(parseLevel("")).toBeNull();
    expect(parseLevel("verbose")).toBeNull();
  });
  test("levelValue 全序", () => {
    const vals = (["trace", "debug", "info", "warn", "error"] as LogLevel[]).map(levelValue);
    expect(vals).toEqual([...vals].sort((a, b) => a - b));
  });
});

describe("formatLogLine", () => {
  test("字段渲染：数值 1 位小数、空白引号包裹、缺省占位", () => {
    const line = formatLogLine({
      t: "2026-10-31T09:15:32.123Z",
      lvl: "debug",
      seq: 42,
      mod: "http",
      ev: "req",
      f: { m: "POST", ms: 35.26, path: "/api/sessions", err: null },
    });
    expect(line).toBe(
      '2026-10-31T09:15:32.123Z D seq=0042 [http] req m=POST ms=35.3 path=/api/sessions err=-',
    );
  });
  test("级别字符与无字段形态", () => {
    expect(
      formatLogLine({ t: "t", lvl: "warn", seq: 1, mod: "obs", ev: "boot" }),
    ).toBe("t W seq=0001 [obs] boot");
  });
});

describe("ObsLogger 级别过滤", () => {
  test("默认 info：debug/trace 零输出零入缓冲", () => {
    const { logger, lines } = makeLogger();
    logger.debug("gw", "op", { op: "prompt" });
    logger.trace("gw", "x");
    expect(lines).toHaveLength(0);
    expect(logger.entries()).toHaveLength(0);
    logger.info("gw", "op", { op: "prompt" });
    logger.warn("obs", "warn1");
    expect(lines).toHaveLength(2);
    expect(logger.entries()).toHaveLength(2);
  });
  test("debug 级别启用后 debug 行可见", () => {
    const { logger, lines } = makeLogger({ level: "debug" });
    logger.debug("gw", "op", { op: "prompt" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(" [gw] op op=prompt");
  });
});

describe("ObsLogger 环形缓冲", () => {
  test("容量淘汰：只留最新 capacity 条，序旧→新，seq 单调", () => {
    const { logger } = makeLogger({ capacity: 3 });
    for (let i = 1; i <= 5; i++) logger.info("m", `e${i}`);
    const entries = logger.entries() as LogEntry[];
    expect(entries.map((e) => e.ev)).toEqual(["e3", "e4", "e5"]);
    expect(entries.map((e) => e.seq)).toEqual([3, 4, 5]);
  });
});

describe("ObsLogger 文件落盘", () => {
  test("真实写文件：行数=条数、文件名按 UTC 日", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-log-"));
    try {
      const { logger } = makeLogger({ dir, level: "info" });
      logger.info("boot", "start", { port: 7788 });
      logger.warn("engine", "crash", { pid: 123 });
      await new Promise((r) => setTimeout(r, 50));
      const names = readdirSync(dir);
      expect(names).toEqual(["webui-2026-10-31.log"]);
      const content = readFileSync(join(dir, "webui-2026-10-31.log"), "utf8");
      expect(content.split("\n").filter(Boolean)).toHaveLength(2);
      expect(content).toContain("[boot] start port=7788");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("retainDays 清理：旧文件删除、窗口内保留", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-log-"));
    try {
      // 手造一个 10 天前的旧文件与一个昨天的窗口内文件
      writeFileSync(join(dir, "webui-20261001.log"), "old\n");
      writeFileSync(join(dir, "webui-2026-10-30.log"), "recent\n");
      const { logger } = makeLogger({ dir });
      logger.info("boot", "start");
      await new Promise((r) => setTimeout(r, 50));
      expect(readdirSync(dir).sort()).toEqual(["webui-2026-10-30.log", "webui-2026-10-31.log"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("连续失败 3 次禁用文件并 stderr 告警一次", async () => {
    let calls = 0;
    const { logger, lines } = makeLogger({
      dir: "/nonexistent-obs-dir",
      appendImpl: () => {
        calls++;
        return Promise.reject(new Error("disk down"));
      },
    });
    logger.info("a", "1");
    logger.info("a", "2");
    logger.info("a", "3");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(3);
    expect(lines.filter((l) => l.includes("file_disabled"))).toHaveLength(1);
    // 禁用后再写：零追加尝试，stderr/缓冲不受影响
    logger.info("a", "4");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(3);
    expect(lines.filter((l) => l.includes("[a]"))).toHaveLength(4);
    expect(logger.stats().file).toBe("disabled");
  });
  test("dir=null 时 stats.file=off 且 readFileTail 为空", () => {
    const { logger } = makeLogger({ dir: null });
    logger.info("a", "1");
    expect(logger.stats().file).toBe("off");
    expect(logger.readFileTail()).toEqual([]);
  });
});

describe("ObsLogger readFileTail", () => {
  test("读今天+昨天文件尾部", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-log-"));
    try {
      writeFileSync(join(dir, "webui-2026-10-30.log"), "y1\ny2\n");
      writeFileSync(join(dir, "webui-2026-10-31.log"), "t1\nt2\nt3\n");
      const { logger } = makeLogger({ dir });
      expect(logger.readFileTail(4)).toEqual(["y2", "t1", "t2", "t3"]);
      expect(logger.readFileTail(2)).toEqual(["t2", "t3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
