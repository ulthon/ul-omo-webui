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

/** 路由包装：handler 抛错统一转 JSON 错误响应，避免每个 handler 重复 try/catch */
export function route(handler: (c: Context) => Promise<Response> | Response) {
  return async (c: Context): Promise<Response> => {
    try {
      return await handler(c);
    } catch (err) {
      return toErrorResponse(c, err);
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
