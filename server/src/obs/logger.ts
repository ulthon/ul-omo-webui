// 统一结构化日志器（2026-10-31 日志采集增强批）。
// 三路输出：
//   1. stderr 单行（沿用既有运维习惯，与 [slow]/[5xx] 行并存）
//   2. 进程内环形缓冲（默认 5000 条；GET /api/diagnostics/logs 主数据源）
//   3. 按天滚动文件 <dir>/webui-YYYYMMDD.log，保留 7 天
//      （UL_OMO_WEBUI_LOG_FILE=0/false/no/off 关闭；目录 LOG_DIR 随 DATA_DIR）
// 行契约（诊断面板与导出文件解析依据）：
//   2026-10-31T09:15:32.123Z D seq=0042 [http] req m=POST path=/api/... st=200 ms=35 rid=ab12cd34
// 级别字符 T/D/I/W/E；字段值含空白或等号时双引号包裹；单行截断 2000 字符。
// 兼容声明：既有 [slow]/[5xx]/[perf]/[sse-debug] 行契约原样保留，本层为并行新增；
// 默认 info 级下 debug 行零输出（与既有"默认关零输出"语义一致）。
import { appendFile } from "node:fs/promises";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR, LOG_FILE_ENABLED } from "../config";
import { levelValue, parseLevel, type LogLevel } from "./level";

export type LogVal = string | number | boolean | null | undefined;

export interface LogEntry {
  /** ISO 时间戳 */
  t: string;
  lvl: LogLevel;
  /** 进程内单调序号（跨环形淘汰仍递增；文件与缓冲对齐键） */
  seq: number;
  /** 模块（http/gw/rpc/engine/sse/bridge/fe.* …） */
  mod: string;
  /** 事件名（req/resolve/frame/crash …） */
  ev: string;
  /** 结构化字段（诊断端点 JSON 原样返回） */
  f?: Record<string, LogVal>;
  /** 渲染后单行（stderr/文件原样） */
  line: string;
}

export interface ObsLoggerOptions {
  level?: LogLevel;
  /** 环形缓冲容量（默认 5000） */
  capacity?: number;
  /** 落盘目录；null = 不落盘（仅 stderr + 环形缓冲） */
  dir?: string | null;
  /** 文件保留天数（默认 7） */
  retainDays?: number;
  /** stderr 写入口（默认 process.stderr.write；测试注入） */
  stderr?: (line: string) => void;
  /** 时钟（默认真实时间；测试注入） */
  now?: () => Date;
  /** 文件追加实现（默认真实 appendFile；测试注入） */
  appendImpl?: (file: string, text: string) => Promise<void>;
}

const MAX_LINE = 2000;
const LEVEL_CH: Record<LogLevel, string> = { trace: "T", debug: "D", info: "I", warn: "W", error: "E" };
/** 单文件读取上限（字节）：超出跳过该文件（防异常巨文件拖垮诊断端点） */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** 字段值渲染：空/缺省 "-"；含空白或等号双引号包裹（内嵌引号替换防破行）；数值保留 1 位小数 */
export function renderVal(v: LogVal): string {
  if (v === null || v === undefined) return "-";
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(Math.round(v * 10) / 10) : String(v)) : String(v);
  if (s === "") return '""';
  return /[\s"=]/.test(s) ? `"${s.replace(/"/g, "'").slice(0, MAX_LINE)}"` : s.slice(0, MAX_LINE);
}

/** 条目 → 单行（纯函数，单测逐字段断言） */
export function formatLogLine(e: Pick<LogEntry, "t" | "lvl" | "seq" | "mod" | "ev" | "f">): string {
  const parts = [`[${e.mod}]`, e.ev];
  if (e.f) for (const [k, v] of Object.entries(e.f)) parts.push(`${k}=${renderVal(v)}`);
  return `${e.t} ${LEVEL_CH[e.lvl]} seq=${String(e.seq).padStart(4, "0")} ${parts.join(" ")}`.slice(0, MAX_LINE);
}

export class ObsLogger {
  private readonly level: LogLevel;
  private readonly capacity: number;
  private readonly dir: string | null;
  private readonly retainDays: number;
  private readonly stderrFn: (line: string) => void;
  private readonly nowFn: () => Date;
  private readonly appendFn: (file: string, text: string) => Promise<void>;

  /** 环形缓冲（定长数组 + 头指针，淘汰 O(1)） */
  private readonly ring: Array<LogEntry | undefined>;
  private ringHead = 0;
  private ringSize = 0;
  private seqCounter = 0;

  /** 文件落盘状态：链式追加防交错；连续失败 3 次禁用并告警一次（防递归刷屏） */
  private fileChain: Promise<void> = Promise.resolve();
  private fileFailCount = 0;
  private fileDead = false;
  private fileDay = "";
  private lastCleanupDay = "";

  constructor(opts: ObsLoggerOptions = {}) {
    this.level = opts.level ?? "info";
    this.capacity = Math.max(1, opts.capacity ?? 5000);
    this.dir = opts.dir === undefined ? null : opts.dir;
    this.retainDays = opts.retainDays ?? 7;
    this.stderrFn = opts.stderr ?? ((line) => process.stderr.write(line + "\n"));
    this.nowFn = opts.now ?? (() => new Date());
    this.appendFn = opts.appendImpl ?? ((file, text) => appendFile(file, text, "utf8"));    this.ring = new Array<LogEntry | undefined>(this.capacity);
  }

  /** 级别启用判定（热路径先判再构造 fields，省对象分配） */
  enabled(level: LogLevel): boolean {
    return levelValue(level) >= levelValue(this.level);
  }

  isDebugEnabled(): boolean {
    return this.enabled("debug");
  }

  trace(mod: string, ev: string, f?: Record<string, LogVal>): void {
    this.write("trace", mod, ev, f);
  }

  debug(mod: string, ev: string, f?: Record<string, LogVal>): void {
    this.write("debug", mod, ev, f);
  }

  info(mod: string, ev: string, f?: Record<string, LogVal>): void {
    this.write("info", mod, ev, f);
  }

  warn(mod: string, ev: string, f?: Record<string, LogVal>): void {
    this.write("warn", mod, ev, f);
  }

  error(mod: string, ev: string, f?: Record<string, LogVal>): void {
    this.write("error", mod, ev, f);
  }

  private write(lvl: LogLevel, mod: string, ev: string, f?: Record<string, LogVal>): void {
    if (!this.enabled(lvl)) return;
    const seq = ++this.seqCounter;
    const t = this.nowFn().toISOString();
    const fields = f && Object.keys(f).length > 0 ? f : undefined;
    const entry: LogEntry = { t, lvl, seq, mod, ev, f: fields, line: "" };
    entry.line = formatLogLine(entry);
    this.stderrFn(entry.line);
    const slot = (this.ringHead + this.ringSize) % this.capacity;
    this.ring[slot] = entry;
    if (this.ringSize < this.capacity) this.ringSize++;
    else this.ringHead = (this.ringHead + 1) % this.capacity;
    this.appendToFile(entry);
  }

  /** 外部来源（前端批量上报）按原始级别中转落盘；服务端级别门控仍生效 */
  relay(lvl: LogLevel, mod: string, ev: string, f?: Record<string, LogVal>): void {
    this.write(lvl, mod, ev, f);
  }

  /** 当日文件名（UTC 日期，跨天自动滚动） */
  private fileFor(day: string): string {
    return join(this.dir as string, `webui-${day}.log`);
  }

  private appendToFile(entry: LogEntry): void {
    if (!this.dir || this.fileDead) return;
    const day = entry.t.slice(0, 10);
    const file = this.fileFor(day);
    // 惰性建目录 + 旧文件清理（每日一次）：首次写才触碰磁盘，测试环境零副作用
    try {
      mkdirSync(this.dir, { recursive: true });
      if (this.lastCleanupDay !== day) {
        this.lastCleanupDay = day;
        this.cleanupOldFiles(day);
      }
    } catch {
      this.disableFile("mkdir/cleanup 失败");
      return;
    }
    this.fileDay = day;
    this.fileChain = this.fileChain
      .then(() => this.appendFn(file, entry.line + "\n"))
      .catch((err: unknown) => {
        this.fileFailCount++;
        if (this.fileFailCount >= 3) {
          this.disableFile(err instanceof Error ? err.message : String(err));
        }
        // 未达阈值静默重试（下一行再试；不 stderr 告警防失败风暴）
      });
  }

  private disableFile(reason: string): void {
    if (this.fileDead) return;
    this.fileDead = true;
    this.stderrFn(formatLogLine({ t: this.nowFn().toISOString(), lvl: "warn", seq: ++this.seqCounter, mod: "obs", ev: "file_disabled", f: { reason } }));
  }

  /** 清理超过保留天数的旧滚动文件（失败静默：清理是尽力而为） */
  private cleanupOldFiles(today: string): void {
    const dir = this.dir;
    if (!dir) return;
    try {
      const cutoff = new Date(`${today}T00:00:00Z`).getTime() - this.retainDays * 86400_000;
      for (const name of readdirSync(dir)) {
        const m = /^webui-(\d{4})(\d{2})(\d{2})\.log$/.exec(name);
        if (!m) continue;
        const fileDay = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getTime();
        if (Number.isFinite(fileDay) && fileDay < cutoff) rmSync(join(dir, name), { force: true });
      }
    } catch {
      // 目录不可读等：跳过本次清理
    }
  }

  /** 环形缓冲有序快照（旧→新） */
  entries(): LogEntry[] {
    const out: LogEntry[] = [];
    for (let i = 0; i < this.ringSize; i++) {
      const e = this.ring[(this.ringHead + i) % this.capacity];
      if (e) out.push(e);
    }
    return out;
  }

  /** 读最近滚动文件行（今天+昨天，存在才读；尾部 maxLines；单文件超 32MB 跳过） */
  readFileTail(maxLines = 5000): string[] {
    if (!this.dir) return [];
    const today = this.nowFn().toISOString().slice(0, 10);
    const yesterday = new Date(this.nowFn().getTime() - 86400_000).toISOString().slice(0, 10);
    const lines: string[] = [];
    for (const day of [yesterday, today]) {
      const file = this.fileFor(day);
      try {
        const st = statSync(file);
        if (st.size > MAX_FILE_BYTES) continue;
        // 文本行与环形缓冲/结构化解析同构：诊断端点把两源按 seq 合并
        lines.push(...readFileSyncLines(file));
      } catch {
        // 文件不存在/不可读：跳过
      }
    }
    return lines.slice(-maxLines);
  }

  /** 运行统计（诊断 summary 端点用） */
  stats(): { level: LogLevel; capacity: number; buffered: number; seq: number; file: "on" | "off" | "disabled" } {
    return {
      level: this.level,
      capacity: this.capacity,
      buffered: this.ringSize,
      seq: this.seqCounter,
      file: this.fileDead ? "disabled" : this.dir ? "on" : "off",
    };
  }
}

/** 读文件为行数组（独立小函数便于将来按需替换流式读取） */
function readFileSyncLines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
}

/** 进程级默认单例：env 单源（UL_OMO_WEBUI_LOG_LEVEL / UL_OMO_WEBUI_LOG_FILE）。
 * 模块加载零副作用（目录在首次写入时惰性创建）。 */
export const log: ObsLogger = new ObsLogger({
  level: parseLevel(process.env.UL_OMO_WEBUI_LOG_LEVEL) ?? "info",
  dir: LOG_FILE_ENABLED ? LOG_DIR : null,
});
