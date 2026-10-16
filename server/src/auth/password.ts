import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export const COOKIE_NAME = "ul_omo_session";
// 30 天，秒
export const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

// ---- 时序安全比较：先哈希到定长再比较，规避 timingSafeEqual 长度不等抛错与长度泄露 ----
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ---- 密码解析：env 优先；缺省时读 data/password；首次生成随机密码落盘并打印 ----
export function resolvePassword(dataDir: string): string {
  const fromEnv = process.env.UL_OMO_WEBUI_PASSWORD;
  if (fromEnv) return fromEnv;

  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "password");
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return saved;
  }

  const generated = randomBytes(18).toString("base64url");
  writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  console.log(`UL_OMO_WEBUI_PASSWORD 未设置，已生成随机密码：${generated}`);
  console.log(`（已写入 ${file}，后续启动直接读取该文件）`);
  return generated;
}

// ---- cookie 会话：HMAC 签名的过期时间戳，无状态、服务重启后仍有效 ----
// secret 持久化在 data/session-secret（0600），不与密码绑定（改密码不使已发会话失效，
// 若需全局失效删除该文件即可）。
function loadSessionSecret(dataDir: string): Buffer {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "session-secret");
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return Buffer.from(saved, "hex");
  }
  const secret = randomBytes(32);
  writeFileSync(file, secret.toString("hex"), { mode: 0o600 });
  return secret;
}

function sign(secret: Buffer, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/** 生成会话 token：`<过期毫秒时间戳>.<hmac>`。export 供测试构造过期/篡改样本。 */
export function createToken(secret: Buffer, issuedAtMs: number): string {
  const expiry = String(issuedAtMs + COOKIE_MAX_AGE * 1000);
  return `${expiry}.${sign(secret, expiry)}`;
}

function verifyToken(secret: Buffer, token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expiry = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(expiry)) return false;
  if (Number(expiry) <= Date.now()) return false;
  return safeEqual(mac, sign(secret, expiry));
}

export interface Auth {
  /** 保护性中间件：cookie 无效时返回 401 JSON */
  middleware: (c: Context, next: Next) => Promise<Response | void>;
  /** POST /api/auth/login：校验密码，成功 Set-Cookie */
  login: (c: Context) => Promise<Response>;
  /** POST /api/auth/logout：清除 cookie */
  logout: (c: Context) => Response;
}

export function createAuth(dataDir: string, password: string): Auth {
  const secret = loadSessionSecret(dataDir);

  const middleware = async (c: Context, next: Next) => {
    const token = getCookie(c, COOKIE_NAME);
    if (!verifyToken(secret, token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };

  const login = async (c: Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const candidate =
      typeof body === "object" && body !== null
        ? (body as { password?: unknown }).password
        : undefined;
    if (typeof candidate !== "string" || !safeEqual(candidate, password)) {
      return c.json({ error: "invalid password" }, 401);
    }
    setCookie(c, COOKIE_NAME, createToken(secret, Date.now()), {
      httpOnly: true,
      sameSite: "Lax",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });
    return c.json({ ok: true });
  };

  const logout = (c: Context) => {
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  };

  return { middleware, login, logout };
}
