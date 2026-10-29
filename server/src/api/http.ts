// REST 统一错误形状与路由包装（todo 9）。
// 全部业务路由错误统一 {error: {code, message}}；
// 鉴权 401（todo 12 的 {error:"unauthorized"}）与登录端点不在本层管辖。
import type { Context } from "hono";
import { EngineAdapterError } from "../adapter/engine-adapter";

/** 业务错误：REST 层按 status/code 直接序列化 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** EngineAdapterError code → HTTP 状态映射（docs/verification/01-05 实证错误面） */
function adapterErrorStatus(code: string): number {
  switch (code) {
    case "unsupported":
      return 501;
    case "no_active_session":
    case "not_started":
      return 409;
    case "engine_not_ready":
      return 503;
    case "timeout":
      return 504;
    default:
      return 500;
  }
}

export function toErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  }
  if (err instanceof EngineAdapterError) {
    return c.json(
      { error: { code: err.code, message: err.message } },
      adapterErrorStatus(err.code) as 500,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: { code: "internal", message } }, 500);
}

/** 慢请求阈值默认值（毫秒）；UL_OMO_WEBUI_SLOW_MS 可调 */
export const DEFAULT_SLOW_MS = 1000;

/** 慢阈值解析（导出供单测）：正数生效，缺省/非数值/0/负数回落默认 */
export function slowThresholdMs(raw: string | undefined = process.env.UL_OMO_WEBUI_SLOW_MS): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SLOW_MS;
}

/** 5xx 的 code/message 提取：抛错走错误对象；handler 直返 5xx 从 JSON 体取（仅 application/json，流式体不读防悬挂） */
async function errorFields(res: Response, err: unknown): Promise<{ code: string; message: string }> {
  if (err instanceof ApiError) return { code: err.code, message: err.message };
  if (err instanceof EngineAdapterError) return { code: err.code, message: err.message };
  if (err !== undefined) {
    return { code: "internal", message: err instanceof Error ? err.message : String(err) };
  }
  try {
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
      return { code: "internal", message: "" };
    }
    const body = (await res.clone().json()) as { error?: unknown } | null;
    if (typeof body?.error === "string") return { code: "internal", message: body.error };
    const fields = body?.error as { code?: unknown; message?: unknown } | undefined;
    return {
      code: typeof fields?.code === "string" ? fields.code : "internal",
      message: typeof fields?.message === "string" ? fields.message : "",
    };
  } catch {
    return { code: "internal", message: "" };
  }
}

/** 观测单行输出（默认开，r11 todo 9）：与 perf.ts 同款单行契约，只落 method/path/status/code/message，不落请求体与载荷 */
async function logRouteObservation(c: Context, res: Response, ms: number, err: unknown): Promise<void> {
  const method = c.req.method;
  const path = c.req.path;
  if (ms > slowThresholdMs()) {
    process.stderr.write(`[slow] ${method} ${path} ms=${ms} status=${res.status}\n`);
  }
  if (res.status < 500) return;
  const { code, message } = await errorFields(res, err);
  // 单行契约：压平 message 内换行，防多行错误破坏逐行解析
  process.stderr.write(
    `[5xx] ${method} ${path} status=${res.status} code=${code} message=${message.replace(/[\r\n]+/g, " ")}\n`,
  );
}

/**
 * 路由包装：handler 抛错统一转 JSON 错误响应，避免每个 handler 重复 try/catch；
 * 同时默认开两层观测日志（r11 todo 9）：
 *   [slow] <method> <path> ms=<n> status=<s>   —— 耗时 > 阈值（默认 1000ms，UL_OMO_WEBUI_SLOW_MS 可调）
 *   [5xx]  <method> <path> status=<s> code=<code> message=<message>
 * 流式路径判定（拍死，不留二选一）：耗时只计到 handler 返回 Response 为止，即「连接建立」。
 * SSE 帧（streamSSE 回调）与文件流传输都发生在 Response 返回之后，永不进入本层计时，
 * 故流式端点不产生帧级 [slow]；连接建立本身超阈值才记一行（status=200）。建立期失败
 * 抛出/直返的 5xx 仍恰记一行 [5xx]。[slow] 与 [5xx] 独立判定：慢且 5xx = 两行。
 * 注：/api/events 当前在 sse.ts 以裸 handler 注册、不经本包装，本层对其零打点；
 * 经 route() 的流式端点（如 /api/fs/download）按上述判定只计建立耗时。
 */
export function route(handler: (c: Context) => Promise<Response> | Response) {
  return async (c: Context): Promise<Response> => {
    const startedAt = Date.now();
    try {
      const res = await handler(c);
      await logRouteObservation(c, res, Date.now() - startedAt, undefined);
      return res;
    } catch (err) {
      const res = toErrorResponse(c, err);
      await logRouteObservation(c, res, Date.now() - startedAt, err);
      return res;
    }
  };
}

/** 解析 JSON 对象请求体；非法形状统一 400 invalid_json */
export async function parseJsonBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "请求体必须是合法 JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid_json", "请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

/** 必填路径参数（泛型 Context 下 param 返回 string | undefined，统一收敛） */
export function requireParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new ApiError(400, "invalid_request", `路径参数 ${name} 必填`);
  return value;
}
