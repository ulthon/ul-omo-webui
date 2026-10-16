import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  COOKIE_NAME,
  createAuth,
  createToken,
  resolvePassword,
} from "../src/auth/password";

function buildApp(dataDir: string, password: string) {
  const auth = createAuth(dataDir, password);
  const app = new Hono();
  app.post("/api/auth/login", auth.login);
  app.post("/api/auth/logout", auth.logout);
  app.use("/api/*", auth.middleware);
  app.get("/api/health", (c) => c.json({ ok: true }));
  return app;
}

function dataSecret(dataDir: string): Buffer {
  return Buffer.from(readFileSync(join(dataDir, "session-secret"), "utf8").trim(), "hex");
}

describe("resolvePassword", () => {
  const savedEnv = process.env.UL_OMO_WEBUI_PASSWORD;
  let dataDir: string;

  beforeEach(() => {
    delete process.env.UL_OMO_WEBUI_PASSWORD;
    dataDir = mkdtempSync(join(tmpdir(), "senpi-auth-test-"));
  });

  afterEach(() => {
    if (savedEnv !== undefined) process.env.UL_OMO_WEBUI_PASSWORD = savedEnv;
    else delete process.env.UL_OMO_WEBUI_PASSWORD;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("环境变量优先，不写密码文件", () => {
    process.env.UL_OMO_WEBUI_PASSWORD = "env-pass";
    expect(resolvePassword(dataDir)).toBe("env-pass");
    expect(existsSync(join(dataDir, "password"))).toBe(false);
  });

  test("缺省时生成随机密码并写入文件", () => {
    const generated = resolvePassword(dataDir);
    expect(generated.length).toBeGreaterThan(0);
    const file = join(dataDir, "password");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe(generated);
  });

  test("再次启动读取已生成的密码文件", () => {
    const first = resolvePassword(dataDir);
    expect(resolvePassword(dataDir)).toBe(first);
  });
});

describe("auth 中间件与登录端点", () => {
  const savedEnv = process.env.UL_OMO_WEBUI_PASSWORD;
  const password = "test-pass-123";
  let dataDir: string;
  let app: Hono;

  beforeEach(() => {
    delete process.env.UL_OMO_WEBUI_PASSWORD;
    dataDir = mkdtempSync(join(tmpdir(), "senpi-auth-test-"));
    app = buildApp(dataDir, password);
  });

  afterEach(() => {
    if (savedEnv !== undefined) process.env.UL_OMO_WEBUI_PASSWORD = savedEnv;
    else delete process.env.UL_OMO_WEBUI_PASSWORD;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("无 cookie 访问受保护路由返回 401", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("错误密码登录返回 401 且不发会话 cookie", async () => {
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(login.status).toBe(401);
    expect(login.headers.get("Set-Cookie")).toBeNull();
    expect((await login.json()).error).toBe("invalid password");
  });

  test("非法 body 登录返回 400", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  test("正确密码登录返回 200 并 Set-Cookie（HttpOnly/SameSite=Lax/Max-Age 30 天/Path=/）", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(`${COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).toContain("Path=/");
  });

  test("带有效 cookie 访问受保护路由返回 200", async () => {
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";")[0];
    const res = await app.request("/api/health", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("篡改的 token 返回 401", async () => {
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const valid = (login.headers.get("Set-Cookie") ?? "").split(";")[0];
    const token = valid.split("=")[1];
    const tampered = `${token.slice(0, -2)}xy`;
    const res = await app.request("/api/health", {
      headers: { Cookie: `${COOKIE_NAME}=${tampered}` },
    });
    expect(res.status).toBe(401);
  });

  test("过期 token 返回 401", async () => {
    const expired = createToken(dataSecret(dataDir), Date.now() - 31 * 24 * 60 * 60 * 1000);
    const res = await app.request("/api/health", {
      headers: { Cookie: `${COOKIE_NAME}=${expired}` },
    });
    expect(res.status).toBe(401);
  });

  test("logout 清除 cookie", async () => {
    const res = await app.request("/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(`${COOKIE_NAME}=`);
    expect(cookie).toContain("Max-Age=0");
  });
});
