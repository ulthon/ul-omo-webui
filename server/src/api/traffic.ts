// 宽带流量监控（docs08-2026-10-22 批次任务 28）：
// (a) webui 请求级计量——轻量中间件按端点聚合 req/res 字节，内存日账 + 零点自动重置；
//     SSE 单列（连接数 / 事件数估算 / 事件字节 + 连接时长）；
// (b) 系统记账透出——GET /api/stats/traffic 只读查询，附带 vnstat（eth0 日/月账）
//     快照；vnstat 缺失或执行失败时降级 available=false，绝不 5xx。
// Must NOT（计划约束）：计量不落盘只内存日账；热路径只累计数字不做结构化加工；
// 不监控引擎↔提供商层（系统级 nethogs 覆盖，不在产品代码内）。
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { route } from "./http";

const execFileAsync = promisify(execFile);

/** 本地日期键（零点重置的比对基线），YYYY-MM-DD */
export function dayKeyOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface EndpointStat {
  endpoint: string;
  requests: number;
  reqBytes: number;
  resBytes: number;
  sseConnections: number;
  sseEvents: number;
  sseBytes: number;
  /** SSE 累计连接时长（毫秒，连接关闭时入账） */
  sseDurationMs: number;
}

interface MutableStat extends EndpointStat {}

/** 内存日账：跨零点首次写入/读取自动清零（旧日数据清零不残留） */
export class TrafficMeter {
  private dayKey = dayKeyOf(new Date());
  private stats = new Map<string, MutableStat>();

  private roll(now = new Date()): void {
    const key = dayKeyOf(now);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.stats.clear();
    }
  }

  private stat(endpoint: string): MutableStat {
    let s = this.stats.get(endpoint);
    if (!s) {
      s = {
        endpoint,
        requests: 0,
        reqBytes: 0,
        resBytes: 0,
        sseConnections: 0,
        sseEvents: 0,
        sseBytes: 0,
        sseDurationMs: 0,
      };
      this.stats.set(endpoint, s);
    }
    return s;
  }

  /** 普通（非 SSE）请求入账 */
  record(endpoint: string, reqBytes: number, resBytes: number, now = new Date()): void {
    this.roll(now);
    const s = this.stat(endpoint);
    s.requests += 1;
    s.reqBytes += reqBytes;
    s.resBytes += resBytes;
  }

  /** SSE 连接收尾入账（事件数 = event: 帧计数估算，字节 = 实际流过字节数） */
  recordSse(endpoint: string, eventBytes: number, events: number, durationMs: number, now = new Date()): void {
    this.roll(now);
    const s = this.stat(endpoint);
    s.requests += 1;
    s.sseConnections += 1;
    s.sseEvents += events;
    s.sseBytes += eventBytes;
    s.sseDurationMs += durationMs;
  }

  /** 只读快照（按响应字节降序）；读取即触发跨零点重置 */
  snapshot(now = new Date()): { day: string; endpoints: EndpointStat[] } {
    this.roll(now);
    return {
      day: this.dayKey,
      endpoints: [...this.stats.values()]
        .map((s) => ({ ...s }))
        .sort((a, b) => b.resBytes + b.sseBytes - (a.resBytes + a.sseBytes)),
    };
  }
}

/** 端点归并键：优先 hono 路由模板（/api/sessions/:id/messages），兜底把
 * 数字/十六进制长段折叠为 :id，防同一 API 形态被会话 id 炸成千行。 */
export function endpointKeyOf(c: Context): string {
  const routePath = (c.req as unknown as { routePath?: string }).routePath;
  if (typeof routePath === "string" && routePath.length > 0) return routePath;
  return "/" + c.req.path.split("/").map((seg) => (/^[0-9a-fA-F-]{8,}$/.test(seg) || /^\d+$/.test(seg) ? ":id" : seg)).join("/");
}

/** 包装响应流只计数不缓冲：热路径零结构化加工；客户端断开走 cancel 回调入账
 * （tee 分支在写侧永不结束时会挂起，绝不作为入账时机）。 */
function countWrap(body: ReadableStream, onDone: (bytes: number, events: number) => void): ReadableStream {
  const reader = body.getReader();
  let bytes = 0;
  let events = 0;
  let settled = false;
  const finish = (): void => {
    if (!settled) {
      settled = true;
      onDone(bytes, events);
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
        } else {
          bytes += value.byteLength;
          events += countSseEvents(value);
          controller.enqueue(value);
        }
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
}

function countSseEvents(chunk: Uint8Array): number {
  // 仅 SSE 流调用：粗数 event: 帧头出现次数（估算口径，计划允许）
  let n = 0;
  const text = new TextDecoder().decode(chunk);
  let idx = text.indexOf("event:");
  while (idx !== -1) {
    n += 1;
    idx = text.indexOf("event:", idx + 6);
  }
  return n;
}

/** 请求级计量中间件：挂在 /api/* 鉴权之后、业务路由之前 */
export function trafficMiddleware(meter: TrafficMeter): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = Date.now();
    await next();
    const res = c.res;
    const endpoint = endpointKeyOf(c);
    const reqBytes = Number(c.req.header("content-length") ?? 0) || 0;
    const isSse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
    const contentLength = res.headers.get("content-length");
    if (contentLength !== null) {
      const resBytes = Number(contentLength) || 0;
      if (isSse) {
        meter.recordSse(endpoint, resBytes, 0, Date.now() - startedAt);
      } else {
        meter.record(endpoint, reqBytes, resBytes);
      }
      return;
    }
    if (!res.body) {
      if (isSse) meter.recordSse(endpoint, 0, 0, Date.now() - startedAt);
      else meter.record(endpoint, reqBytes, 0);
      return;
    }
    // 无 content-length（分块/SSE 流）：旁路计数包装，客户端原样收到相同字节流
    c.res = new Response(countWrap(res.body, (bytes, events) => {
      if (isSse) {
        meter.recordSse(endpoint, bytes, events, Date.now() - startedAt);
      } else {
        meter.record(endpoint, reqBytes, bytes);
      }
    }), res);
  };
}

// ---------------------------------------------------------------- 系统记账（vnstat）

export interface VnstatSystem {
  available: true;
  interface: string;
  /** 最近一日账（字节） */
  day: { date: string; rx: number; tx: number };
  /** 本月累计账（字节） */
  month: { rx: number; tx: number };
}

export interface VnstatUnavailable {
  available: false;
  reason: string;
}

export function parseVnstatJson(raw: string): VnstatSystem | VnstatUnavailable {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { available: false, reason: "vnstat 输出不是合法 JSON" };
  }
  const interfaces = (doc as { interfaces?: unknown }).interfaces;
  if (!Array.isArray(interfaces) || interfaces.length === 0) {
    return { available: false, reason: "vnstat 输出无接口数据" };
  }
  const eth0 = interfaces.find((i) => (i as { name?: string }).name === "eth0") ?? interfaces[0];
  const traffic = (eth0 as { traffic?: { day?: unknown[]; month?: unknown[] } }).traffic;
  const dayList = Array.isArray(traffic?.day) ? traffic.day : [];
  const monthList = Array.isArray(traffic?.month) ? traffic.month : [];
  if (dayList.length === 0) {
    return { available: false, reason: "vnstat 尚无按日账（守护刚装/无数据）" };
  }
  const lastDay = dayList[dayList.length - 1] as {
    date?: { year?: number; month?: number; day?: number };
    rx?: number;
    tx?: number;
  };
  const d = lastDay.date ?? {};
  const monthTotal = monthList.reduce<{ rx: number; tx: number }>(
    (acc, m) => ({ rx: acc.rx + (Number((m as { rx?: number }).rx) || 0), tx: acc.tx + (Number((m as { tx?: number }).tx) || 0) }),
    { rx: 0, tx: 0 },
  );
  return {
    available: true,
    interface: (eth0 as { name?: string }).name ?? "eth0",
    day: {
      date: `${d.year ?? "?"}-${String(d.month ?? "?").padStart(2, "0")}-${String(d.day ?? "?").padStart(2, "0")}`,
      rx: Number(lastDay.rx) || 0,
      tx: Number(lastDay.tx) || 0,
    },
    month: monthTotal,
  };
}

async function readVnstatDefault(): Promise<string> {
  const { stdout } = await execFileAsync("vnstat", ["--json"], { timeout: 4000 });
  return stdout;
}

export interface TrafficRouteDeps {
  meter: TrafficMeter;
  readVnstat?: () => Promise<string>;
}

/** GET /api/stats/traffic 只读查询：webui 端点日账 + vnstat 系统账快照 */
export function createTrafficRoutes(deps: TrafficRouteDeps): Hono {
  const app = new Hono();
  const readVnstat = deps.readVnstat ?? readVnstatDefault;
  app.get("/api/stats/traffic", route(async (c: Context) => {
    const snap = deps.meter.snapshot();
    let system: VnstatSystem | VnstatUnavailable;
    try {
      system = parseVnstatJson(await readVnstat());
    } catch (err) {
      system = { available: false, reason: err instanceof Error ? err.message : String(err) };
    }
    return c.json({ ...snap, generatedAt: new Date().toISOString(), system });
  }));
  return app;
}
