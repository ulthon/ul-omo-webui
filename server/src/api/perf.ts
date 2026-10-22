// 性能测量埋点（docs08-2026-10-22-batch 任务 1 / Fix0）：切换链路四层耗时观测。
// 开关 UL_OMO_WEBUI_DEBUG_PERF 默认关——关闭时零输出、零行为差异（先例：config.ts
// DEBUG_SSE 同款真值集合与 dlog 管道）。行格式契约（计划任务 1）：
//   [perf] op=<name> proj=<hash8> session=<id8> ensureMs= queueWaitMs= switchToMs= rpcMs= entries=<n>
// 四层归因模型（docs/08:391-397）：ensureMs=④冷 spawn、queueWaitMs=②runExclusive 串行、
// switchToMs=③每次开仓、rpcMs=①全量拉取（含传输+解析的引擎侧往返）。
import { createHash } from "node:crypto";

/** env 真值判定（导出供单测）：1/true/yes/on 不分大小写视为开，其余（含缺省）关 */
export function perfEnabled(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(raw ?? "");
}

/** 进程级开关（模块加载期读 env，与 DEBUG_SSE 同口径；默认关零输出） */
export const DEBUG_PERF = perfEnabled(process.env.UL_OMO_WEBUI_DEBUG_PERF);

/** 一次 gateway op 的分段耗时（毫秒，performance.now 差值）。段可得才落字段。 */
export interface PerfSpan {
  op: string;
  /** 项目路径 8 位摘要（不落全路径，日志可外发可聚合） */
  proj: string;
  /** 会话 id（日志取前 8 位） */
  session?: string;
  /** ④ ensure()：引擎进程确保就绪（冷项目首触=spawn 等待） */
  ensureMs?: number;
  /** ② runExclusive 互斥队列等待（同项目在飞调用串行排队） */
  queueWaitMs?: number;
  /** ③ switchTo：open_session 切换 RPC（同会话活跃态早退≈0） */
  switchToMs?: number;
  /** ① 主 RPC（messages=getEntries 全量；prompt 含 setModel） */
  rpcMs?: number;
  /** 载荷条数：messages=条目数、questionsList=帧数、queueList=ordered 长度 */
  entries?: number;
  /** 失败错误码（冷启动 503 engine_not_ready 归因关键） */
  err?: string;
}

/** 项目路径 → 稳定 8 位 hash（同一项目跨日志可聚合） */
export function projHash8(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 8);
}

/** 会话 id → 前 8 位短标识 */
export function sessionId8(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function round1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** span → 单行日志（纯函数，逐字段断言见 test/perf.test.ts）；可选段缺省即省略 */
export function formatPerfLine(span: PerfSpan): string {
  const parts: string[] = [
    `[perf] op=${span.op}`,
    `proj=${span.proj}`,
  ];
  if (span.session !== undefined) parts.push(`session=${sessionId8(span.session)}`);
  if (span.ensureMs !== undefined) parts.push(`ensureMs=${round1(span.ensureMs)}`);
  if (span.queueWaitMs !== undefined) parts.push(`queueWaitMs=${round1(span.queueWaitMs)}`);
  if (span.switchToMs !== undefined) parts.push(`switchToMs=${round1(span.switchToMs)}`);
  if (span.rpcMs !== undefined) parts.push(`rpcMs=${round1(span.rpcMs)}`);
  if (span.entries !== undefined) parts.push(`entries=${span.entries}`);
  if (span.err !== undefined) parts.push(`err=${span.err}`);
  return parts.join(" ");
}

/** 按开关输出一行（enabled 参数供单测注入；生产走 DEBUG_PERF 缺省） */
export function logPerfLine(line: string, enabled: boolean = DEBUG_PERF): void {
  if (enabled) console.log(line);
}

/** gateway op 收尾统一落一行（开关关时零输出；enabled 供单测注入） */
export function logPerfSpan(span: PerfSpan, enabled: boolean = DEBUG_PERF): void {
  logPerfLine(formatPerfLine(span), enabled);
}

/** HTTP 路由计时行（GET /api/sessions/:id/messages）：[perf] http op=messages status=<n> ms=<total> entries=<n> */
export function logPerfHttp(status: number, ms: number, entries: number | undefined): void {
  if (!DEBUG_PERF) return;
  const tail = entries !== undefined ? ` entries=${entries}` : "";
  console.log(`[perf] http op=messages status=${status} ms=${round1(ms)}${tail}`);
}
