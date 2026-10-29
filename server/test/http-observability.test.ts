// r11-2026-10-29-batch todo 9 单测：route() 慢请求采样与 5xx 单行日志（默认开）。
// 契约（与 http.ts route() 注释一致）：
//   [slow] <method> <path> ms=<n> status=<s>   —— 耗时 > 阈值（默认 1000ms，UL_OMO_WEBUI_SLOW_MS 可调）
//   [5xx]  <method> <path> status=<s> code=<code> message=<message>
// 四态（慢/快/5xx/2xx）全部走假时钟（vi.useFakeTimers 推进 Date.now，零真实等待）+
// 捕获 process.stderr.write；[slow] 与 [5xx] 独立判定（慢且 5xx = 两行）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";
import { ApiError, route, slowThresholdMs } from "../src/api/http";
import { EngineAdapterError } from "../src/adapter/engine-adapter";

const SLOW_ENV_KEY = "UL_OMO_WEBUI_SLOW_MS";

/** 捕获 process.stderr.write（单行日志断言用）；afterEach 统一 vi.restoreAllMocks 还原 */
function captureStderr(): { lines: string[] } {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { lines };
}

type Handler = (c: Context) => Promise<Response> | Response;

/** 单路由最小 app：直接驱动 route() 包装层 */
function appWith(path: string, handler: Handler): Hono {
  const app = new Hono();
  app.get(path, route(handler));
  return app;
}

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[SLOW_ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[SLOW_ENV_KEY];
  else process.env[SLOW_ENV_KEY] = savedEnv;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("slowThresholdMs（UL_OMO_WEBUI_SLOW_MS 解析）", () => {
  test("缺省回落默认 1000", () => {
    expect(slowThresholdMs(undefined)).toBe(1000);
  });
  test("非法值（空串/非数值/0/负数）回落默认", () => {
    for (const v of ["", "abc", "0", "-5"]) {
      expect(slowThresholdMs(v)).toBe(1000);
    }
  });
  test("正数生效", () => {
    expect(slowThresholdMs("200")).toBe(200);
  });
});

describe("route() 观测日志四态（假时钟 + stderr 捕获）", () => {
  test("慢 2xx：恰一行 [slow]，字段按契约", async () => {
    vi.useFakeTimers();
    const { lines } = captureStderr();
    const app = appWith("/api/obs/slow", async (c) => {
      await vi.advanceTimersByTimeAsync(1500);
      return c.json({ ok: true });
    });
    const res = await app.request("/api/obs/slow");
    expect(res.status).toBe(200);
    expect(lines).toEqual(["[slow] GET /api/obs/slow ms=1500 status=200\n"]);
  });

  test("快 2xx：零输出", async () => {
    vi.useFakeTimers();
    const { lines } = captureStderr();
    const app = appWith("/api/obs/fast", (c) => c.json({ ok: true }));
    const res = await app.request("/api/obs/fast");
    expect(res.status).toBe(200);
    expect(lines).toEqual([]);
  });

  test("5xx（抛 ApiError）：恰一行，含 code 与 message", async () => {
    vi.useFakeTimers();
    const { lines } = captureStderr();
    const app = appWith("/api/obs/boom", async () => {
      throw new ApiError(500, "engine_down", "引擎不可用");
    });
    const res = await app.request("/api/obs/boom");
    expect(res.status).toBe(500);
    expect(lines).toEqual(["[5xx] GET /api/obs/boom status=500 code=engine_down message=引擎不可用\n"]);
  });

  test("5xx（抛 EngineAdapterError → 503）：恰一行，adapter code 直出", async () => {
    vi.useFakeTimers();
    const { lines } = captureStderr();
    const app = appWith("/api/obs/adapter", async () => {
      throw new EngineAdapterError("engine_not_ready", "引擎未就绪");
    });
    const res = await app.request("/api/obs/adapter");
    expect(res.status).toBe(503);
    expect(lines).toEqual(["[5xx] GET /api/obs/adapter status=503 code=engine_not_ready message=引擎未就绪\n"]);
  });

  test("5xx（handler 直返 Response）：JSON 体提取 code/message；非 JSON 体不读、code 兜底 internal", async () => {
    vi.useFakeTimers();
    const { lines } = captureStderr();
    // sse.ts 总线未配置 500 同款形状：{error: "<字符串>"} 直返
    const app = new Hono();
    app.get("/api/obs/ret500", route((c) => c.json({ error: "event bus not configured: call setEventBus() first" }, 500)));
    app.get("/api/obs/ret502", route(() => new Response("nope", { status: 502 })));
    const res1 = await app.request("/api/obs/ret500");
    const res2 = await app.request("/api/obs/ret502");
    expect(res1.status).toBe(500);
    expect(res2.status).toBe(502);
    expect(lines).toEqual([
      "[5xx] GET /api/obs/ret500 status=500 code=internal message=event bus not configured: call setEventBus() first\n",
      "[5xx] GET /api/obs/ret502 status=502 code=internal message=\n",
    ]);
  });

  test("慢且 5xx：[slow] 与 [5xx] 各恰一行（独立判定，先 slow 后 5xx）", async () => {
    vi.useFakeTimers();
    const { lines } = captureStderr();
    const app = appWith("/api/obs/slow-boom", async () => {
      await vi.advanceTimersByTimeAsync(1200);
      throw new ApiError(503, "engine_not_ready", "引擎未就绪");
    });
    const res = await app.request("/api/obs/slow-boom");
    expect(res.status).toBe(503);
    expect(lines).toEqual([
      "[slow] GET /api/obs/slow-boom ms=1200 status=503\n",
      "[5xx] GET /api/obs/slow-boom status=503 code=engine_not_ready message=引擎未就绪\n",
    ]);
  });
});

describe("阈值边界与 env 覆盖", () => {
  test("耗时恰等于阈值不记（超阈值语义为严格大于）", async () => {
    vi.useFakeTimers();
    const { lines } = captureStderr();
    const app = appWith("/api/obs/edge", async (c) => {
      await vi.advanceTimersByTimeAsync(1000);
      return c.json({ ok: true });
    });
    const res = await app.request("/api/obs/edge");
    expect(res.status).toBe(200);
    expect(lines).toEqual([]);
  });

  test("UL_OMO_WEBUI_SLOW_MS=200：150ms 零输出、250ms 记一行", async () => {
    vi.useFakeTimers();
    process.env[SLOW_ENV_KEY] = "200";
    const app = new Hono();
    app.get(
      "/api/obs/t150",
      route(async (c) => {
        await vi.advanceTimersByTimeAsync(150);
        return c.json({ ok: true });
      }),
    );
    app.get(
      "/api/obs/t250",
      route(async (c) => {
        await vi.advanceTimersByTimeAsync(250);
        return c.json({ ok: true });
      }),
    );
    const { lines } = captureStderr();
    const res1 = await app.request("/api/obs/t150");
    expect(res1.status).toBe(200);
    expect(lines).toEqual([]);
    const res2 = await app.request("/api/obs/t250");
    expect(res2.status).toBe(200);
    expect(lines).toEqual(["[slow] GET /api/obs/t250 ms=250 status=200\n"]);
  });
});
