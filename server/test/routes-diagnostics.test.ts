/**
 * 2026-10-31 日志采集增强批：诊断端点单测（无鉴权中间件的最小 Hono 装配）。
 * 覆盖：
 * 1. GET /api/diagnostics/logs：环形缓冲+文件行按 seq 合并去重、过滤
 *    （level/mod 前缀/contains/since）、limit 截断与 truncated 标记；
 * 2. GET /api/diagnostics/summary：boot/engines/sse/log 四段组装；
 * 3. POST /api/diagnostics/frontend-log：合法批 relay（fe. 前缀+原始级别）、
 *    形状非法条目跳过计数、空数组/超限 400；
 * 4. parseLogLine 行契约解析。
 */
import { describe, expect, test } from "vitest";
import { ObsLogger, type LogEntry } from "../src/obs/logger";
import {
  createDiagnosticsRoutes,
  filterLogEntries,
  mergeLogSources,
  parseLogLine,
  sanitizeFeEntry,
} from "../src/api/routes-diagnostics";

function makeLogger(): ObsLogger {
  return new ObsLogger({
    level: "trace",
    capacity: 64,
    dir: null,
    stderr: () => undefined,
    now: () => new Date("2026-10-31T10:00:00.000Z"),
  });
}

describe("parseLogLine", () => {
  test("合法行四段解析", () => {
    const parsed = parseLogLine('2026-10-31T09:15:32.123Z W seq=0042 [gw] resolve.miss rows=3 msg="没找到 x"');
    expect(parsed).not.toBeNull();
    expect(parsed?.lvl).toBe("warn");
    expect(parsed?.seq).toBe(42);
    expect(parsed?.mod).toBe("gw");
    expect(parsed?.ev).toBe("resolve.miss");
  });
  test("非法行返回 null", () => {
    expect(parseLogLine("garbage line")).toBeNull();
    expect(parseLogLine("")).toBeNull();
  });
});

describe("mergeLogSources", () => {
  test("文件行与缓冲去重（缓冲条目优先）、seq 升序", () => {
    const buffer: LogEntry[] = [
      {
        t: "2026-10-31T10:00:01.000Z",
        lvl: "info",
        seq: 2,
        mod: "gw",
        ev: "op",
        f: { op: "prompt" },
        line: "... [gw] op op=prompt",
      },
    ];
    const fileLines = [
      "2026-10-31T10:00:00.000Z I seq=0001 [boot] ready port=7788",
      "2026-10-31T10:00:01.000Z I seq=0002 [gw] op op=prompt ms=5",
      "2026-10-31T10:00:02.000Z W seq=0003 [engine] crash pid=99",
    ];
    const merged = mergeLogSources(buffer, fileLines);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3]);
    // seq=2 缓冲条目胜出（带结构化 f）
    expect(merged[1].f).toEqual({ op: "prompt" });
  });
});

describe("filterLogEntries", () => {
  const entries = mergeLogSources(
    [
      {
        t: "2026-10-31T10:00:03.000Z",
        lvl: "debug",
        seq: 3,
        mod: "http",
        ev: "req",
        line: "... [http] req m=POST path=/api/sessions/abc/prompt st=200",
      },
    ],
    [
      "2026-10-31T10:00:01.000Z I seq=0001 [boot] ready port=7788",
      "2026-10-31T10:00:02.000Z W seq=0002 [engine] crash pid=99",
      "2026-10-31T10:00:04.000Z I seq=0004 [fe.ui] click session=abc",
    ],
  );
  test("级别下限过滤", () => {
    expect(filterLogEntries(entries, { level: "warn" }).map((e) => e.seq)).toEqual([2]);
  });
  test("模块前缀过滤（fe.* 命名空间）", () => {
    expect(filterLogEntries(entries, { mod: "fe" }).map((e) => e.mod)).toEqual(["fe.ui"]);
  });
  test("contains 不区分大小写", () => {
    expect(filterLogEntries(entries, { contains: "PROMPT" }).map((e) => e.seq)).toEqual([3]);
  });
  test("since 起始时间", () => {
    expect(filterLogEntries(entries, { since: "2026-10-31T10:00:02.500Z" }).map((e) => e.seq)).toEqual([3, 4]);
  });
});

describe("sanitizeFeEntry", () => {
  test("合法条目净化（ft 时间前缀 + 字段裁剪）", () => {
    const clean = sanitizeFeEntry({
      t: "2026-10-31T09:59:59.000Z",
      lvl: "warn",
      mod: "sse",
      ev: "reconnect",
      f: { attempt: 2, note: "x".repeat(600) },
    });
    expect(clean?.lvl).toBe("warn");
    expect(clean?.f?.ft).toBe("2026-10-31T09:59:59.000Z");
    expect(String(clean?.f?.note).length).toBe(500);
  });
  test("非法级别/空 mod 返回 null", () => {
    expect(sanitizeFeEntry({ lvl: "loud", mod: "x", ev: "y" })).toBeNull();
    expect(sanitizeFeEntry({ lvl: "info", mod: "", ev: "y" })).toBeNull();
    expect(sanitizeFeEntry({ lvl: "info", mod: "x", ev: "" })).toBeNull();
  });
});

describe("诊断路由", () => {
  function appWith(logger: ObsLogger) {
    return createDiagnosticsRoutes({
      logger,
      engines: () => [{ projectPath: "/tmp/demo", state: "ready", pid: 123, restarts: 0, runningSessions: 1, lastActivityAt: 1 }],
      sseConnections: () => 2,
      bootInfo: () => ({ node: "v24", startedAt: "2026-10-31T09:00:00Z", uptimeSec: 3600, pid: 1 }),
    });
  }

  test("GET /logs：合并文件行+缓冲，limit 截断与 truncated", async () => {
    const logger = makeLogger();
    logger.info("boot", "ready", { port: 7788 });
    logger.warn("engine", "crash", { pid: 99 });
    const app = appWith(logger);
    const res = await app.request("/api/diagnostics/logs?limit=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[]; matched: number; truncated: boolean };
    expect(body.matched).toBe(2);
    expect(body.entries).toHaveLength(1);
    expect(body.truncated).toBe(true);
    // 尾部语义：保留最新一条（crash）
    const last = body.entries[0] as { ev: string };
    expect(last.ev).toBe("crash");
  });

  test("GET /summary：四段组装", async () => {
    const app = appWith(makeLogger());
    const res = await app.request("/api/diagnostics/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { boot: { node: string }; engines: unknown[]; sseConnections: number; log: { level: string } };
    expect(body.boot.node).toBe("v24");
    expect(body.engines).toHaveLength(1);
    expect(body.sseConnections).toBe(2);
    expect(body.log.level).toBe("trace");
  });

  test("POST /frontend-log：合法批 relay 为 fe.* 条目、非法条目 skipped", async () => {
    const logger = makeLogger();
    const app = appWith(logger);
    const res = await app.request("/api/diagnostics/frontend-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: [
          { t: "2026-10-31T09:59:59.000Z", lvl: "info", mod: "ui", ev: "click.send", f: { len: 42 } },
          { lvl: "info", mod: "ui", ev: "click" },
          { lvl: "nonsense", mod: "ui", ev: "x" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { accepted: number }).toMatchObject({ ok: true, accepted: 2, skipped: 1 });
    const entries = logger.entries();
    expect(entries.map((e) => e.mod)).toEqual(["fe.ui", "fe.ui"]);
    expect(entries[0].f?.len).toBe(42);
    expect(entries[0].f?.ft).toBe("2026-10-31T09:59:59.000Z");
  });

  test("POST /frontend-log：空数组与超限 400", async () => {
    const app = appWith(makeLogger());
    const r1 = await app.request("/api/diagnostics/frontend-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: [] }),
    });
    expect(r1.status).toBe(400);
    const r2 = await app.request("/api/diagnostics/frontend-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: Array.from({ length: 201 }, () => ({ lvl: "info", mod: "a", ev: "b" })) }),
    });
    expect(r2.status).toBe(400);
  });
});
