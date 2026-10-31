// 诊断端点（2026-10-31 日志采集增强批）：
// - GET  /api/diagnostics/logs         环形缓冲 + 当日/昨日滚动文件合并查询
//   （过滤 level/mod/contains/since，按 seq 去重排序，默认尾部 1000 条，上限 5000）
// - GET  /api/diagnostics/summary      运行快照（boot 元信息/引擎进程表/SSE 连接数/日志统计）
// - POST /api/diagnostics/frontend-log 前端日志批量上报（页面刷新/丢弃/崩溃前已冲服务端，
//   前后端日志持久性拉平；单批 ≤200 条，逐条按原始级别经统一 logger 落盘，模块加 fe. 前缀）
// 认证：随既有 /api/* cookie 中间件（挂载顺序在 auth.middleware 之后）。
import { Hono, type Context } from "hono";
import type { ObsLogger, LogEntry, LogVal } from "../obs/logger";
import { levelValue, LOG_LEVELS, type LogLevel } from "../obs/level";
import { ApiError, parseJsonBody, route } from "./http";
import { getDiagnosticsFlags, setDiagnosticsFlags } from "../conf/diagnostics-flags";

export interface DiagnosticsRouteDeps {
  logger: Pick<ObsLogger, "entries" | "readFileTail" | "stats" | "relay">;
  /** 引擎进程表快照（组合根注入；projectPath 全路径——诊断导出面向本人，无需脱敏） */
  engines?: () => Array<Record<string, unknown>>;
  /** SSE 活跃连接数（组合根注入） */
  sseConnections?: () => number;
  /** 启动元信息（组合根注入：node 版本/启动时刻/运行时长等） */
  bootInfo?: () => Record<string, unknown>;
}

/** 文件行 → 结构化条目（环形缓冲淘汰后的补充源；无 f 字段，仅行文本） */
const LINE_RE = /^(\S+) ([TDIWE]) seq=(\d+) \[([^\]]+)\] (\S+)(?: (.*))?$/;
const CH_TO_LEVEL: Record<string, LogLevel> = { T: "trace", D: "debug", I: "info", W: "warn", E: "error" };

export interface ParsedLogEntry {
  t: string;
  lvl: LogLevel;
  seq: number;
  mod: string;
  ev: string;
  line: string;
}

export function parseLogLine(line: string): ParsedLogEntry | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const lvl = CH_TO_LEVEL[m[2]];
  if (!lvl) return null;
  const seq = Number(m[3]);
  if (!Number.isInteger(seq) || seq <= 0) return null;
  return { t: m[1], lvl, seq, mod: m[4], ev: m[5], line };
}

/** 解析 1..5000 正整数查询参数；非法回落默认 */
function parseLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 5000 ? n : fallback;
}

interface LogsQuery {
  level?: string;
  mod?: string;
  contains?: string;
  since?: string;
}

/** 合并环形缓冲与文件行：按 seq 去重（缓冲条目带结构化字段优先），seq 升序 */
export function mergeLogSources(buffer: LogEntry[], fileLines: string[]): Array<LogEntry | ParsedLogEntry> {
  const bySeq = new Map<number, LogEntry | ParsedLogEntry>();
  for (const line of fileLines) {
    const parsed = parseLogLine(line);
    if (parsed) bySeq.set(parsed.seq, parsed);
  }
  // 缓冲条目覆盖同 seq 文件行（结构化 f 字段更全）
  for (const e of buffer) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** 过滤器：级别下限 / 模块前缀 / 行文本包含（不区分大小写）/ 起始时间（ISO 字符串序） */
export function filterLogEntries(
  entries: Array<LogEntry | ParsedLogEntry>,
  q: LogsQuery,
): Array<LogEntry | ParsedLogEntry> {
  const minLevel = (LOG_LEVELS as readonly string[]).includes(q.level ?? "") ? levelValue(q.level as LogLevel) : 0;
  const modPrefix = q.mod?.trim() || undefined;
  const contains = q.contains?.trim().toLowerCase() || undefined;
  const since = q.since?.trim() || undefined;
  return entries.filter((e) => {
    if (levelValue(e.lvl) < minLevel) return false;
    if (modPrefix && !e.mod.startsWith(modPrefix)) return false;
    if (contains && !e.line.toLowerCase().includes(contains)) return false;
    if (since && e.t < since) return false;
    return true;
  });
}

/** 前端上报条目（web/src/lib/diag.ts 批量冲刷；形状与 LogEntry 对齐减 line） */
interface FeLogEntry {
  t?: unknown;
  lvl?: unknown;
  mod?: unknown;
  ev?: unknown;
  f?: unknown;
}

/** 单条前端条目净化：级别合法、mod/ev 收敛为非空短串、f 原始值裁剪；非法返回 null */
export function sanitizeFeEntry(raw: FeLogEntry): { t: string; lvl: LogLevel; mod: string; ev: string; f?: Record<string, LogVal> } | null {
  const lvl = typeof raw.lvl === "string" && (LOG_LEVELS as readonly string[]).includes(raw.lvl) ? (raw.lvl as LogLevel) : null;
  if (!lvl) return null;
  const mod = typeof raw.mod === "string" && raw.mod.trim() !== "" ? raw.mod.trim().slice(0, 64) : null;
  const ev = typeof raw.ev === "string" && raw.ev.trim() !== "" ? raw.ev.trim().slice(0, 64) : null;
  if (!mod || !ev) return null;
  const f: Record<string, LogVal> = {};
  if (typeof raw.t === "string" && raw.t !== "") f.ft = raw.t.slice(0, 40);
  if (raw.f && typeof raw.f === "object" && !Array.isArray(raw.f)) {
    let count = 0;
    for (const [k, v] of Object.entries(raw.f as Record<string, unknown>)) {
      if (count >= 20) break;
      if (typeof v === "number" && Number.isFinite(v)) f[k.slice(0, 32)] = Math.round(v * 10) / 10;
      else if (typeof v === "boolean") f[k.slice(0, 32)] = v;
      else if (typeof v === "string") f[k.slice(0, 32)] = v.slice(0, 500);
      count++;
    }
  }
  return { t: "", lvl, mod, ev, f: Object.keys(f).length > 0 ? f : undefined };
}

export function createDiagnosticsRoutes(deps: DiagnosticsRouteDeps): Hono {
  const app = new Hono();

  app.get(
    "/api/diagnostics/logs",
    route((c: Context) => {
      const limit = parseLimit(c.req.query("limit"), 1000);
      const merged = mergeLogSources(deps.logger.entries(), deps.logger.readFileTail(5000));
      const filtered = filterLogEntries(merged, {
        level: c.req.query("level"),
        mod: c.req.query("mod"),
        contains: c.req.query("contains"),
        since: c.req.query("since"),
      });
      return c.json({
        entries: filtered.slice(-limit),
        matched: filtered.length,
        truncated: filtered.length > limit,
        log: deps.logger.stats(),
      });
    }),
  );

  app.get(
    "/api/diagnostics/summary",
    route((c: Context) => {
      return c.json({
        boot: deps.bootInfo?.() ?? {},
        engines: deps.engines?.() ?? [],
        sseConnections: deps.sseConnections?.() ?? 0,
        log: deps.logger.stats(),
      });
    }),
  );

  // 诊断开关（2026-10-31 面板化）：GET 生效值；POST 写入即生效免重启（env 为真项
  // 不可关，返回值始终为生效值供面板回显）
  app.get(
    "/api/diagnostics/flags",
    route(async (c: Context) => c.json(getDiagnosticsFlags())),
  );
  app.post(
    "/api/diagnostics/flags",
    route(async (c: Context) => {
      const body = await parseJsonBody(c);
      const patch: { perf?: boolean; sse?: boolean } = {};
      if (typeof body.perf === "boolean") patch.perf = body.perf;
      if (typeof body.sse === "boolean") patch.sse = body.sse;
      return c.json(setDiagnosticsFlags(patch));
    }),
  );

  app.post(
    "/api/diagnostics/frontend-log",
    route(async (c: Context) => {
      const body = await parseJsonBody(c);
      const raw = body.entries;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new ApiError(400, "invalid_request", "entries 必须是非空数组");
      }
      if (raw.length > 200) {
        throw new ApiError(400, "invalid_request", `单批上限 200 条，收到 ${raw.length}`);
      }
      let accepted = 0;
      let skipped = 0;
      for (const item of raw) {
        const clean = sanitizeFeEntry(item as FeLogEntry);
        if (!clean) {
          skipped++;
          continue;
        }
        // 按前端原始级别经统一 logger 落盘（模块加 fe. 前缀；服务端级别门控仍生效：
        // 服务端 info 级时 fe 的 debug 条目不落——但前端本地级别已先行过滤，
        // 本地 debug 关时不存在 debug 条目，两侧语义自洽）
        deps.logger.relay(clean.lvl, `fe.${clean.mod}`, clean.ev, clean.f);
        accepted++;
      }
      return c.json({ ok: true, accepted, skipped });
    }),
  );

  return app;
}
