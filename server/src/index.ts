import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { relative } from "node:path";
import { agentDir, DATA_DIR, engineRegistryPath, HOST, metaDbPath, PORT, STATIC_DIR } from "./config";
import { createAuth, resolvePassword } from "./auth/password";
import { openMetaDb } from "./db/meta";
import { EngineProcessManager } from "./engine/process-manager";
import { EngineRuntimeRegistry, permissionPresetArgs } from "./api/engine-runtime";
import { EventBus, attachEventBus } from "./engine/events";
import { sseRoutes, setEventBus } from "./api/sse";
import { createSessionRoutes } from "./api/routes-session";
import { createMetaRoutes } from "./api/routes-meta";
import { createProjectRoutes } from "./api/routes-project";
import { createGitRoutes } from "./api/routes-git";
import { createFsRoutes } from "./api/routes-fs";

const auth = createAuth(DATA_DIR, resolvePassword(DATA_DIR));

// 组合根装配（todo 9）：元数据库 → 引擎子进程管理器单例 → 按项目懒加载运行时 → 注入各路由
// meta 库默认 <DATA_DIR>/meta.db（显式 SENPI_WEBUI_META_DB 仍最高优先）；
// PID 登记表同属运行数据目录——隔离部署（覆盖 DATA_DIR）三者随行，互不共享。
const meta = openMetaDb({ path: metaDbPath() });
const manager = new EngineProcessManager({
  // W2 spawn 规范：显式 OMO_CODING_AGENT_DIR（缺省 ~/.pi/agent，见 process-manager）
  agentDir: agentDir(),
  // PID 登记表（孤儿清扫记录）随运行数据目录
  registryPath: engineRegistryPath(),
  // 按项目权限预设（meta_kv 键 permission-preset:<projectPath>，值如 read-only）：
  // spawn 参数级，变更后经 POST /api/projects/restart 让项目引擎重建生效
  extraSpawnArgs: (projectPath) => permissionPresetArgs((key) => meta.getKv(key), projectPath),
});
const engines = new EngineRuntimeRegistry(manager, {
  listProjects: () => meta.listProjectMeta().map((p) => p.projectPath),
  // agentDir 必须与 spawn 同源：SDK 侧路径推导（models-store 直读降级、
  // SessionManager.list 的 sessionDir）全部依赖它（todo 22 QA 移交修复）
  agentDir: agentDir(),
  // 收尾监视的合成 agent_settled 进同一事件桥（todo 16 实证：个别回合收尾
  // wire 事件全部缺席；get_state 复核空闲 + 宽限后合成，带 synthetic 标记）
  publishSyntheticEvent: (projectPath, event) => {
    eventBus.publish(projectPath, event as never);
  },
  // 未读计数服务端接线：assistant 消息落地 → meta_session.unread_count++
  //（主动查看中的会话同样递增；前端回合落定时对选中会话补发 read 清零）
  recordUnread: (_projectPath, durableSessionId) => {
    meta.incrementUnread(durableSessionId);
  },
});

// SSE 事件桥装配（todo 10 收口 + todo 9 后续修复）：manager 的 engine_event 透传进桥
// → 注入 sseRoutes（进程启动期一次）；完整路径 GET /api/events，自动处于上方
// /api/* 鉴权中间件保护内。关停时退订（attachEventBus 返回值）。
// - heartbeatMs=8000：Bun 空闲连接超时实测 ~12s，心跳周期必须小于它，
//   否则空闲 SSE 连接被服务端周期性掐断（客户端虽自愈但有无谓重连）。
// - durableLookup：wire sessionId 是 routing handle，REST/前端会话身份是
//   durable id（磁盘 header id）；data 帧注入 durableSessionId 供前端按 durable 键路由。
const eventBus = new EventBus({ capacity: 1000 });
const detachEventBus = attachEventBus(manager, eventBus);
setEventBus(eventBus, {
  heartbeatMs: 8000,
  durableLookup: (projectPath, handle) => engines.durableSessionIdFor(projectPath, handle),
});

// 启动孤儿清扫：清理上次遗留的引擎子进程（todo 8 语义，registry+cwd+argv 三因子判定）
void manager
  .reapOrphans(engines.listProjectPaths())
  .then((r) => {
    if (r.killed.length > 0) console.log(`孤儿引擎清扫：${r.killed.length} 个（${r.killed.map((k) => k.pid).join(",")}）`);
  })
  .catch((err: unknown) => {
    console.warn(`孤儿引擎清扫失败：${err instanceof Error ? err.message : String(err)}`);
  });

const app = new Hono();

// 公开端点：登录/登出（登录端点必须匿名可达，否则永远进不了门）
app.post("/api/auth/login", auth.login);
app.post("/api/auth/logout", auth.logout);

// 保护全部 /api/*：后续追加的业务路由自动纳入保护
app.use("/api/*", auth.middleware);
app.get("/api/health", (c) => c.json({ ok: true }));

// 业务路由（todo 9）。SSE 事件桥（todo 10）由后续任务统一收口挂载。
const deps = { meta, engines };
app.route("/", createSessionRoutes(deps));
app.route("/", createMetaRoutes(deps));
app.route("/", createProjectRoutes(deps));
app.route("/", createGitRoutes(deps));
app.route("/", createFsRoutes(deps));
app.route("/api", sseRoutes);

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
    return c.json({ error: { code: "not_found", message: "route not found" } }, 404);
  }
  return (await serveIndex(c, async () => {})) ?? c.json({ error: { code: "not_found", message: "route not found" } }, 404);
});

// 优雅关停：停全部引擎子进程（SIGTERM→兜底强杀）+ 关元数据库
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  detachEventBus();
  try {
    await engines.stopAll();
  } catch {
    // 尽力关停
  }
  meta.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

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
