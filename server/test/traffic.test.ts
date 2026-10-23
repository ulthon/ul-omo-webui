// 宽带流量监控单测（docs08-2026-10-22 批次任务 28）：
// 计量累计 / SSE 单列 / 跨零点重置 / 响应体零改动 / 并发计数 / vnstat 解析
// （正常 fixture、缺 eth0、空接口、非法 JSON）与路由降级（vnstat 缺失 available=false）。
import { describe, expect, test } from "vitest";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  TrafficMeter,
  trafficMiddleware,
  createTrafficRoutes,
  parseVnstatJson,
  dayKeyOf,
} from "../src/api/traffic";

function buildApp(meter: TrafficMeter): Hono {
  const app = new Hono();
  app.use("/api/*", trafficMiddleware(meter));
  app.get("/api/ping", (c) => c.json({ pong: true, pad: "x".repeat(100) }));
  app.post("/api/echo", async (c) => c.json({ ok: true, echo: "y".repeat(50) }));
  app.post("/api/echo", async (c) => c.json({ ok: true, echo: "y".repeat(50) }));
  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "e1", data: "hello" });
      await stream.writeSSE({ event: "e2", data: "world" });
    }),
  );
  return app;
}

async function readBody(res: Response): Promise<unknown> {
  return res.json();
}

describe("TrafficMeter 累计与重置", () => {
  test("按端点累计 req/res 字节与请求数", async () => {
    const meter = new TrafficMeter();
    const app = buildApp(meter);
    await (await app.request("/api/ping")).text();
    await (await app.request("/api/ping")).text();
    const echoBody = JSON.stringify({ a: "z".repeat(40) });
    const echoRes = await app.request("/api/echo", { method: "POST", body: echoBody, headers: { "content-length": String(echoBody.length) } });
    await echoRes.text();
    // 旁路计数异步收敛：bounded 等待入账出现
    let echo = meter.snapshot().endpoints.find((e) => e.endpoint === "/api/echo");
    for (let i = 0; i < 50 && !echo; i++) {
      await new Promise((r) => setTimeout(r, 10));
      echo = meter.snapshot().endpoints.find((e) => e.endpoint === "/api/echo");
    }
    const snap = meter.snapshot();
    expect(snap.day).toBe(dayKeyOf(new Date()));
    let ping = meter.snapshot().endpoints.find((e) => e.endpoint === "/api/ping");
    for (let i = 0; i < 50 && !ping; i++) {
      await new Promise((r) => setTimeout(r, 10));
      ping = meter.snapshot().endpoints.find((e) => e.endpoint === "/api/ping");
    }
    expect(ping?.requests).toBe(2);
    expect(ping?.resBytes).toBeGreaterThan(100);
    expect(echo?.requests).toBe(1);
    expect(echo?.reqBytes).toBe(echoBody.length);
  });

  test("SSE 单列：连接数/事件数/事件字节单独入账，不混入 resBytes", async () => {
    const meter = new TrafficMeter();
    const app = buildApp(meter);
    const res = await app.request("/api/stream");
    await res.text();
    // 旁路计数异步收敛： bounded 等待快照出现（微任务级别即可）
    let sse = meter.snapshot().endpoints.find((e) => e.sseConnections > 0);
    for (let i = 0; i < 50 && !sse; i++) {
      await new Promise((r) => setTimeout(r, 10));
      sse = meter.snapshot().endpoints.find((e) => e.sseConnections > 0);
    }
    expect(sse).toBeDefined();
    expect(sse?.endpoint).toBe("/api/stream");
    expect(sse?.sseConnections).toBe(1);
    expect(sse?.sseEvents).toBe(2);
    expect(sse?.sseBytes).toBeGreaterThan(0);
    expect(sse?.resBytes).toBe(0);
    expect(sse?.sseDurationMs).toBeGreaterThanOrEqual(0);
  });

  test("跨零点重置：旧日数据清零不残留", async () => {
    const meter = new TrafficMeter();
    meter.record("/api/ping", 10, 20);
    expect(meter.snapshot().endpoints).toHaveLength(1);
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    meter.record("/api/ping", 10, 20, tomorrow);
    const snap = meter.snapshot(tomorrow);
    expect(snap.day).toBe(dayKeyOf(tomorrow));
    const ping = snap.endpoints.find((e) => e.endpoint === "/api/ping");
    expect(ping?.requests).toBe(1);
    expect(ping?.reqBytes).toBe(10);
  });

  test("并发请求计数正确（10 路并发恰好 10 次）", async () => {
    const meter = new TrafficMeter();
    const app = buildApp(meter);
    await Promise.all(Array.from({ length: 10 }, async () => { await (await app.request("/api/ping")).text(); }));
    let ping = meter.snapshot().endpoints.find((e) => e.endpoint === "/api/ping");
    for (let i = 0; i < 50 && (!ping || ping.requests < 10); i++) {
      await new Promise((r) => setTimeout(r, 10));
      ping = meter.snapshot().endpoints.find((e) => e.endpoint === "/api/ping");
    }
    expect(ping?.requests).toBe(10);
    expect(ping?.resBytes).toBeGreaterThan(0);
  });

  test("响应体零改动：JSON 内容与 content-type 原样透传", async () => {
    const meter = new TrafficMeter();
    const app = buildApp(meter);
    const res = await app.request("/api/ping");
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { pong: boolean; pad: string };
    // 计量入账 bounded 等待（包装流 pull 后才计数）
    let stat = meter.snapshot().endpoints.find((e) => e.endpoint === "/api/ping");
    for (let i = 0; i < 50 && !stat; i++) {
      await new Promise((r) => setTimeout(r, 10));
      stat = meter.snapshot().endpoints.find((e) => e.endpoint === "/api/ping");
    }
    expect(stat?.resBytes).toBeGreaterThan(0);
    expect(body.pong).toBe(true);
    expect(body.pad).toBe("x".repeat(100));
  });
});

describe("vnstat 解析与路由降级", () => {
  const fixture = JSON.stringify({
    vnstatversion: "2.6",
    interfaces: [
      { name: "lo", traffic: { day: [], month: [] } },
      {
        name: "eth0",
        traffic: {
          day: [
            { date: { year: 2026, month: 10, day: 22 }, rx: 1000, tx: 2000 },
            { date: { year: 2026, month: 10, day: 23 }, rx: 3000, tx: 4000 },
          ],
          month: [{ date: { year: 2026, month: 10 }, rx: 4000, tx: 6000 }],
        },
      },
    ],
  });

  test("正常 fixture：取 eth0 最近日账 + 月累计", () => {
    const sys = parseVnstatJson(fixture);
    expect(sys).toMatchObject({
      available: true,
      interface: "eth0",
      day: { date: "2026-10-23", rx: 3000, tx: 4000 },
      month: { rx: 4000, tx: 6000 },
    });
  });

  test("空接口/无按日账/非法 JSON 均降级 available=false", () => {
    expect(parseVnstatJson(JSON.stringify({ interfaces: [] })).available).toBe(false);
    expect(parseVnstatJson(JSON.stringify({ interfaces: [{ name: "eth0", traffic: { day: [] } }] })).available).toBe(false);
    expect(parseVnstatJson("not json").available).toBe(false);
  });

  test("GET /api/stats/traffic：端点账 + vnstat 快照拼装", async () => {
    const meter = new TrafficMeter();
    const app = new Hono();
    app.use("/api/*", trafficMiddleware(meter));
    app.route("/", createTrafficRoutes({ meter, readVnstat: async () => fixture }));
    const res = await app.request("/api/stats/traffic");
    const body = (await res.json()) as { day: string; endpoints: unknown[]; system: { available: boolean }; generatedAt: string };
    expect(body.system.available).toBe(true);
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.generatedAt).toBeTruthy();
  });

  test("vnstat 二进制缺失：路由仍 200，system.available=false 带原因", async () => {
    const meter = new TrafficMeter();
    const app = new Hono();
    app.use("/api/*", trafficMiddleware(meter));
    app.route("/", createTrafficRoutes({ meter, readVnstat: async () => { throw new Error("spawn vnstat ENOENT"); } }));
    const res = await app.request("/api/stats/traffic");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { system: { available: false; reason: string } };
    expect(body.system.available).toBe(false);
    expect(body.system.reason).toContain("ENOENT");
  });
});
