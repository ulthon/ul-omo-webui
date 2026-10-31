// 前端统一观测层（2026-10-31 日志采集增强批）。
// 与服务端 obs/logger.ts + /api/diagnostics/* 同构配套：
// - 内存环形缓冲（默认 3000 条）——刷新即丢，由批量上报冲服务端补持久性；
// - 级别 trace/debug/info/warn/error：localStorage ulomo_log_level（缺省 info）、
//   URL ?logLevel= 覆盖（QA）；诊断面板运行时切换立即生效，无需重启
//   （直击 docs/08「perf 埋点默认关需重启才开」痛点）；
// - 全局捕获（幂等安装）：window.onerror / unhandledrejection / visibilitychange
//   （切后台/回前台时间锚点，hidden 即冲一次上报）/ online/offline / pagehide；
// - 批量上报：满 40 条或 30s 节拍或 hidden/pagehide 时增量 POST
//   /api/diagnostics/frontend-log（keepalive），失败静默下轮重试（pending 有界）；
// - 发送链追踪 sendTrace：点发送 → POST 回执 → SSE 首帧 → 回合落定四点三段，
//   汇总一行 [perf] send（info 级默认可见）；
// - 隐私：只记元数据（id 前缀/长度/条数/耗时/状态码），不记正文与凭证。
// 项目纪律：模块顶层不触碰 document/navigator/localStorage——级别首读惰性，
// 上报/捕获由 shell 显式 installDiagGlobalCapture/startDiagReporter 启动。

export type DiagLevel = "trace" | "debug" | "info" | "warn" | "error";
export const DIAG_LEVELS: readonly DiagLevel[] = ["trace", "debug", "info", "warn", "error"];
export const DIAG_LEVEL_KEY = "ulomo_log_level";

export type DiagVal = string | number | boolean | null | undefined;

export interface DiagEntry {
  seq: number;
  t: string;
  lvl: DiagLevel;
  mod: string;
  ev: string;
  f?: Record<string, DiagVal>;
}

function levelValue(lvl: DiagLevel): number {
  return DIAG_LEVELS.indexOf(lvl);
}

/** 解析级别字面量；缺失/非法返回 null */
export function parseDiagLevel(raw: string | null | undefined): DiagLevel | null {
  const v = (raw ?? "").trim().toLowerCase();
  return (DIAG_LEVELS as readonly string[]).includes(v) ? (v as DiagLevel) : null;
}

/** 首读来源：URL ?logLevel= > localStorage > 默认 info（全部 try 守卫，无 DOM 走默认） */
function readInitialLevel(): DiagLevel {
  try {
    if (typeof window !== "undefined") {
      const fromUrl = parseDiagLevel(new URLSearchParams(window.location.search).get("logLevel"));
      if (fromUrl) return fromUrl;
    }
    if (typeof localStorage !== "undefined") {
      const stored = parseDiagLevel(localStorage.getItem(DIAG_LEVEL_KEY));
      if (stored) return stored;
    }
  } catch {
    // 存储不可用：走默认
  }
  return "info";
}

let cachedLevel: DiagLevel | null = null;

/** 当前生效级别（惰性首读 + setDiagLevel 更新缓存） */
export function diagLevel(): DiagLevel {
  if (cachedLevel === null) cachedLevel = readInitialLevel();
  return cachedLevel;
}

/** 运行时切级别（诊断面板用）：立即生效 + 镜像 localStorage（失败静默） */
export function setDiagLevel(level: DiagLevel): void {
  cachedLevel = level;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(DIAG_LEVEL_KEY, level);
  } catch {
    // 存储不可用：仅内存态生效
  }
}

/** 8 位请求关联 id（与服务端 newRid 同款格式，日志两侧肉眼可对齐） */
export function newRid8(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  } catch {
    return Math.random().toString(16).slice(2, 10);
  }
}

const CAPACITY = 3000;
const ring: Array<DiagEntry | undefined> = new Array(CAPACITY);
let ringHead = 0;
let ringSize = 0;
let seqCounter = 0;

/** 控制台镜像方法（info 以下对应原方法，方便 DevTools 过滤） */
const CONSOLE: Record<DiagLevel, (args: unknown[]) => void> = {
  trace: (a) => console.debug(...a),
  debug: (a) => console.debug(...a),
  info: (a) => console.log(...a),
  warn: (a) => console.warn(...a),
  error: (a) => console.error(...a),
};

function write(lvl: DiagLevel, mod: string, ev: string, f?: Record<string, DiagVal>): void {
  if (levelValue(lvl) < levelValue(diagLevel())) return;
  const entry: DiagEntry = {
    seq: ++seqCounter,
    t: new Date().toISOString(),
    lvl,
    mod,
    ev,
    f: f && Object.keys(f).length > 0 ? f : undefined,
  };
  const slot = (ringHead + ringSize) % CAPACITY;
  ring[slot] = entry;
  if (ringSize < CAPACITY) ringSize++;
  else ringHead = (ringHead + 1) % CAPACITY;
  CONSOLE[lvl]([`[diag ${lvl}] [${mod}] ${ev}`, entry.f ?? ""]);
  enqueueReport(entry);
}

export const diag = {
  trace: (mod: string, ev: string, f?: Record<string, DiagVal>) => write("trace", mod, ev, f),
  debug: (mod: string, ev: string, f?: Record<string, DiagVal>) => write("debug", mod, ev, f),
  info: (mod: string, ev: string, f?: Record<string, DiagVal>) => write("info", mod, ev, f),
  warn: (mod: string, ev: string, f?: Record<string, DiagVal>) => write("warn", mod, ev, f),
  error: (mod: string, ev: string, f?: Record<string, DiagVal>) => write("error", mod, ev, f),
  /** 交互事件（info 级语义别名）：会话操作/权限应答/提问提交等用户可感知动作 */
  event: (ev: string, f?: Record<string, DiagVal>) => write("info", "ui", ev, f),
  /** 有序快照（旧→新） */
  entries(): DiagEntry[] {
    const out: DiagEntry[] = [];
    for (let i = 0; i < ringSize; i++) {
      const e = ring[(ringHead + i) % CAPACITY];
      if (e) out.push(e);
    }
    return out;
  },
};

// ---------- 批量上报（浏览器可选启动；bun test 环境不启动） ----------

const REPORT_BATCH = 40;
const REPORT_INTERVAL_MS = 30_000;
const PENDING_CAP = 600;

let reportUrl: string | null = null;
let reportTimer: ReturnType<typeof setInterval> | null = null;
let reporting = false;
let fetchImpl: ((url: string, init: RequestInit) => Promise<Response>) | null = null;
const pending: DiagEntry[] = [];

function enqueueReport(entry: DiagEntry): void {
  if (!reportUrl) return;
  pending.push(entry);
  if (pending.length > PENDING_CAP) pending.splice(0, pending.length - PENDING_CAP);
  if (pending.length >= REPORT_BATCH) void flushDiagReport();
}

/** 启动批量上报（幂等；shell 引导期调用一次）。fetchImpl 供单测注入 */
export function startDiagReporter(
  url = "/api/diagnostics/frontend-log",
  opts?: { fetchImpl?: (url: string, init: RequestInit) => Promise<Response> },
): void {
  if (typeof window === "undefined") return;
  reportUrl = url;
  fetchImpl = opts?.fetchImpl ?? ((u, init) => fetch(u, init));
  if (reportTimer === null) {
    reportTimer = setInterval(() => void flushDiagReport(), REPORT_INTERVAL_MS);
  }
}

/** 增量冲刷：成功才出队，失败保留下一轮重试；空队/无 reporter 直接返回 */
export async function flushDiagReport(): Promise<void> {
  if (!reportUrl || !fetchImpl || reporting || pending.length === 0) return;
  reporting = true;
  const batch = pending.slice(0, 200);
  try {
    const res = await fetchImpl(reportUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: batch.map(({ t, lvl, mod, ev, f }) => ({ t, lvl, mod, ev, f })),
      }),
      keepalive: true,
    });
    if (res.ok) pending.splice(0, batch.length);
  } catch {
    // 网络失败：保留 pending 下一轮重试
  } finally {
    reporting = false;
  }
}

// ---------- 全局捕获（幂等安装） ----------

let captureInstalled = false;
let hiddenAt = 0;

/** 安装全局错误/前后台/网络状态捕获（幂等；shell 引导期调用一次） */
export function installDiagGlobalCapture(): void {
  if (captureInstalled || typeof window === "undefined") return;
  captureInstalled = true;
  window.addEventListener("error", (e: ErrorEvent) => {
    diag.error("global", "onerror", {
      msg: String(e.message).slice(0, 200),
      src: (e.filename ?? "").slice(-64),
      line: e.lineno,
    });
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    diag.error("global", "rejection", { reason: String(e.reason).slice(0, 200) });
  });
  document.addEventListener("visibilitychange", () => {
    const hidden = document.visibilityState === "hidden";
    diag.info("page", "visibility", {
      hidden,
      // 回前台时的离开时长（分析「切回来才发现异常」类问题的时间锚点）
      awayMs: !hidden && hiddenAt > 0 ? Date.now() - hiddenAt : undefined,
    });
    if (hidden) {
      hiddenAt = Date.now();
      // 转后台瞬间冲一次上报（浏览器最可靠的送达时机）
      void flushDiagReport();
    }
  });
  window.addEventListener("online", () => diag.info("page", "online", {}));
  window.addEventListener("offline", () => diag.warn("page", "offline", {}));
  window.addEventListener("pagehide", () => void flushDiagReport());
}

// ---------- 发送链追踪：点发送 → 回执 → SSE 首帧 → 回合落定 ----------

interface SendSpan {
  t0: number;
  sendMs?: number;
  firstFrameMs?: number;
  meta?: Record<string, DiagVal>;
}

const sendSpans = new Map<string, SendSpan>();

function s8(sessionId: string): string {
  return sessionId.slice(0, 8);
}

export const sendTrace = {
  /** 点发送（composer 调用）：meta 记长度/附件数/模型/是否排队，不记正文 */
  begin(sessionId: string, meta?: Record<string, DiagVal>): void {
    sendSpans.set(sessionId, { t0: Date.now(), meta });
    diag.info("ui", "send", { session: s8(sessionId), ...meta });
  },
  /** POST /prompt 回执到达（api.prompt 调用侧） */
  receipt(sessionId: string, fields?: Record<string, DiagVal>): void {
    const span = sendSpans.get(sessionId);
    if (!span) return;
    span.sendMs = Date.now() - span.t0;
    diag.debug("perf", "send.receipt", { session: s8(sessionId), sendMs: span.sendMs, ...fields });
  },
  /** SSE message_start 首帧到达（event-dispatch 调用） */
  firstFrame(sessionId: string): void {
    const span = sendSpans.get(sessionId);
    if (!span || span.firstFrameMs !== undefined) return;
    span.firstFrameMs = Date.now() - span.t0;
  },
  /** 回合落定（agent_settled / turn_end）：汇总一行 info（默认可见） */
  settled(sessionId: string, reason = "settled"): void {
    const span = sendSpans.get(sessionId);
    if (!span) return;
    sendSpans.delete(sessionId);
    diag.info("perf", "send", {
      session: s8(sessionId),
      sendMs: span.sendMs,
      firstFrameMs: span.firstFrameMs,
      turnMs: Date.now() - span.t0,
      reason,
      ...span.meta,
    });
  },
  /** 链路异常终止（发送失败/会话切换）：收尾防悬挂 span */
  drop(sessionId: string, reason: string): void {
    const span = sendSpans.get(sessionId);
    if (!span) return;
    sendSpans.delete(sessionId);
    diag.warn("perf", "send.drop", { session: s8(sessionId), reason, sendMs: span.sendMs });
  },
};

// ---------- 诊断导出包（组装纯函数，供面板与单测复用） ----------

export interface DiagBundle {
  meta: {
    exportedAt: string;
    level: DiagLevel;
    userAgent: string;
    language: string;
    screen: string;
    timezone: string;
    page: string;
  };
  frontend: DiagEntry[];
  server: unknown;
  serverSummary: unknown;
  serverError?: string;
}

/** 组装导出包（环境字段读取带守卫；server 两段可缺省——后端不通时仍可导出前端段） */
export function buildDiagBundle(
  frontend: DiagEntry[],
  server: unknown,
  serverSummary: unknown,
  serverError?: string,
): DiagBundle {
  const env = (fn: () => string, fallback = ""): string => {
    try {
      return fn() || fallback;
    } catch {
      return fallback;
    }
  };
  return {
    meta: {
      exportedAt: new Date().toISOString(),
      level: diagLevel(),
      userAgent: env(() => navigator.userAgent),
      language: env(() => navigator.language),
      screen: env(() => `${window.screen.width}x${window.screen.height}`),
      timezone: env(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
      page: env(() => window.location.pathname),
    },
    frontend,
    server,
    serverSummary,
    ...(serverError !== undefined ? { serverError } : {}),
  };
}

/** 测试复位（仅 bun test 用）：清缓冲/级别缓存/pending，停 reporter */
export function resetDiagForTest(): void {
  ring.fill(undefined);
  ringHead = 0;
  ringSize = 0;
  seqCounter = 0;
  cachedLevel = null;
  pending.length = 0;
  reportUrl = null;
  fetchImpl = null;
  reporting = false;
  if (reportTimer !== null) {
    clearInterval(reportTimer);
    reportTimer = null;
  }
  sendSpans.clear();
}
