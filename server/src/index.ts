import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { relative } from "node:path";
import { DATA_DIR, HOST, PORT, STATIC_DIR } from "./config";
import { createAuth, resolvePassword } from "./auth/password";

const auth = createAuth(DATA_DIR, resolvePassword(DATA_DIR));

const app = new Hono();

// 公开端点：登录/登出（登录端点必须匿名可达，否则永远进不了门）
app.post("/api/auth/login", auth.login);
app.post("/api/auth/logout", auth.logout);

// 保护全部 /api/*：后续 todo 9/10 追加的业务路由自动纳入保护
app.use("/api/*", auth.middleware);
app.get("/api/health", (c) => c.json({ ok: true }));

// 静态资源匿名可访问：SPA 是单页壳，index.html 与 assets 同时承担登录页，
// 页面路由的未授权跳转由前端依据 API 401 处理（todo 13）。
// hono/bun 的 serveStatic root 参数相对 process.cwd()，这里换算成相对路径，
// 从任意目录启动都能解析回同一绝对目录。
const staticRoot = relative(process.cwd(), STATIC_DIR);
app.use("*", serveStatic({ root: staticRoot }));

// SPA fallback：非 /api 的未命中路径全部回落 index.html；/api 未命中返回 404 JSON
const serveIndex = serveStatic({ root: staticRoot, path: "index.html" });
app.get("*", async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "not found" }, 404);
  }
  return (await serveIndex(c, async () => {})) ?? c.json({ error: "not found" }, 404);
});

try {
  const server = Bun.serve({ fetch: app.fetch, hostname: HOST, port: PORT });
  console.log(`senpi-webui listening on http://${server.hostname}:${server.port}`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes("EADDRINUSE") ||
    message.includes("Address already in use") ||
    message.includes("in use")
  ) {
    console.error(
      `启动失败：地址 ${HOST}:${PORT} 已被占用。按部署约定不静默换端口，请释放端口或改用 SENPI_WEBUI_PORT 指定其他端口。`,
    );
  } else {
    console.error(`启动失败：${message}`);
  }
  process.exit(1);
}
