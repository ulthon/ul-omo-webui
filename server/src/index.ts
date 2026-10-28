import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { relative } from "node:path";
import { agentDir, DATA_DIR, engineRegistryPath, HOST, metaDbPath, PORT, STATIC_DIR } from "./config";
import { loadEmbeddedStatic, embeddedRelPath } from "./embedded-static";
import { toErrorResponse } from "./api/http";
import { createAuth, resolvePassword } from "./auth/password";
import { openMetaDb } from "./db/meta";
import { openConfigStore } from "./conf/config-store";
import { EngineProcessManager, resolveEnginePaths } from "./engine/process-manager";
import { ScheduleRunnerSupervisor } from "./engine/schedule-runner";
import { createScheduleRoutes, createScheduleDeliverHandler, type ScheduleRouteDeps } from "./api/routes-schedule";
import { abandonSessionJobs, scheduleDir } from "./api/schedule-store";
import {
  createProjectConfigStores,
  migrateProjectPreferences,
  permissionPresetSpawnArgs,
  toolsSpawnArgsFromConfig,
} from "./api/config-migration";
import { EngineRuntimeRegistry } from "./api/engine-runtime";
import { TitleGenService } from "./title-gen";
import { EventBus, attachEventBus, publishPermissionsInvalidated } from "./engine/events";
import { sseRoutes, setEventBus } from "./api/sse";
import { createSessionRoutes } from "./api/routes-session";
import { createRebindRoutes } from "./api/routes-rebind";
import { createMetaRoutes } from "./api/routes-meta";
import { createCommandsRoutes } from "./api/routes-commands";
import { createProjectRoutes } from "./api/routes-project";
import { createGitRoutes } from "./api/routes-git";
import { createFsRoutes } from "./api/routes-fs";
import { createFsWriteRoutes } from "./api/routes-fs-write";
import { createSnippetsRoutes } from "./api/routes-snippets";
import { createTagsRoutes } from "./api/routes-tags";
import { createNotesRoutes } from "./api/routes-notes";
import { createPlansRoutes } from "./api/routes-plans";
import { createMemoryRoutes } from "./api/routes-memory";
import { createTipsRoutes, type TipsRouteDeps } from "./api/routes-tips";
import { createExtensionsRoutes } from "./api/routes-extensions";
import { resolveEngineCli } from "./api/extensions-store";
import { attachmentsRoot, purgeStaleAttachments } from "./api/attachments";
import { TrafficMeter, trafficMiddleware, createTrafficRoutes } from "./api/traffic";

const auth = createAuth(DATA_DIR, resolvePassword(DATA_DIR));

// 组合根装配（todo 9）：元数据库 → 引擎子进程管理器单例 → 按项目懒加载运行时 → 注入各路由
// meta 库默认 <DATA_DIR>/meta.db（显式 UL_OMO_WEBUI_META_DB 仍最高优先）；
// PID 登记表同属运行数据目录——隔离部署（覆盖 DATA_DIR）三者随行，互不共享。
const meta = openMetaDb({ path: metaDbPath() });
// 配置存储（todo 4/6）：全局目录实例 + 按项目根派生解析器（组合根创建一次全链共用，
// 同项目的合并读/迁移/PATCH 写共用同一条 config-store 写链）
const configs = openConfigStore();
const projectConfigs = createProjectConfigStores(configs);
const manager = new EngineProcessManager({
  // W2 spawn 规范：显式 OMO_CODING_AGENT_DIR（缺省 ~/.pi/agent，见 process-manager）
  agentDir: agentDir(),
  // PID 登记表（孤儿清扫记录）随运行数据目录
  registryPath: engineRegistryPath(),
  // 按项目权限预设（todo 6：来源 = 项目 .ul-omo-webui.json 的 permissionPreset 合并读取，
  // 迁移过渡期库值未迁清仍生效、文件损坏降级无参数；meta_kv permission-preset:<projectPath>
  // 仅作存量过渡来源不再写入）：spawn 参数级，变更后经 POST /api/projects/restart
  // 让项目引擎重建生效
  // r10 todo 17：权限预设 + 工具启停（--tools/--exclude-tools/--no-tools）两类 spawn 参数
  // 按项目合并附加；工具启停变更后同经 POST /api/projects/restart 生效
  extraSpawnArgs: (projectPath) => [
    ...permissionPresetSpawnArgs(projectConfigs, meta, projectPath),
    ...toolsSpawnArgsFromConfig(projectConfigs, meta, projectPath),
  ],
});
// 标题生成服务（W2 todo 8）：jsonl 直读取数 + 独立 HTTP 调模型，零引擎会话污染。
// resolveSessionRow 不触发引擎 spawn（活跃态/store 直查/别名三级，纯读）。
const titleGen = new TitleGenService({
  meta,
  // agentDir 与 spawn 同源（凭证读 auth.json，缺 key 时自动路径 warn 不崩）
  agentDir: agentDir(),
  resolveSessionRow: (id) => engines.resolveSessionRow(id),
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
  // 回合落定 → 自动生成标题（正常事件路径 + watchdog 合成路径，crashSettle 排除）。
  // 强制 .catch：Bun 未处理 rejection 默认退出进程（凭证缺失/超时/断网皆常见）
  onRoundSettled: (projectPath, settleInfo, reason) => {
    void titleGen.handleRoundSettled(projectPath, settleInfo, reason).catch((err: unknown) => {
      console.warn(
        `[title-gen] 自动标题生成异常（${settleInfo.sessionPath}）：${err instanceof Error ? err.message : String(err)}`,
      );
    });
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
  // 重放过滤条件 (c)（W1 #4）：项目引擎进程 ready 才视为可应答权限请求
  isEngineRunning: (projectPath) => manager.getStatus(projectPath)?.state === "ready",
});

// 权限失效墓碑（W1 #4）：引擎进程死亡/回收/显式停止后向事件桥发一条
// engine_permissions_invalidated 帧，重连重放据此丢弃旧进程的挂起权限请求
// （不重放 = 前端输入区不再被永无人应答的请求锁死）。三个信号都要订阅：
// - process_crashed：崩溃监督轮询路径；
// - engine_reclaimed：空闲回收路径；
// - state_changed(to=stopped)：干净停止路径（restartProject / 手动 stop 不发
//   前两者，漏订阅这条 = POST /api/projects/restart 依旧复现 #4）。
// 重复发布无害：重放过滤按「请求之后存在墓碑」判定，幂等。
const detachTombstones = manager.onEvent((e) => {
  if (
    e.type === "process_crashed" ||
    e.type === "engine_reclaimed" ||
    (e.type === "state_changed" && e.to === "stopped")
  ) {
    publishPermissionsInvalidated(eventBus, e.projectPath);
  }
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

// schedule 定时任务（docs08-r7 任务 21）：runner 托管 + CRUD 路由 + 投递回注桥。
// spawn 失败连续达上限时降级为「列表+取消只读」（POST 503），不阻断 server 启动。
const scheduleDeliverToken = randomBytes(24).toString("hex");
let scheduleSupervisor: ScheduleRunnerSupervisor | null = null;
try {
  const { cliPath } = resolveEnginePaths();
  scheduleSupervisor = new ScheduleRunnerSupervisor({
    cliPath,
    agentDir: agentDir(),
    dataDir: DATA_DIR,
    deliverUrl: `http://127.0.0.1:${PORT}/api/schedule/deliver`,
    deliverToken: scheduleDeliverToken,
  });
  scheduleSupervisor.start();
  console.log("[schedule] runner 已托管启动（omo schedule run --watch）");
} catch (err) {
  console.warn(`[schedule] runner 托管启动失败，定时任务降级为列表+取消只读：${err instanceof Error ? err.message : String(err)}`);
}
// 会话行解析/prompt 注入复用既有网关能力（resolveSessionRow 纯读不 spawn）
const scheduleDeps: ScheduleRouteDeps = {
  agentDir: agentDir(),
  resolveSession: async (id) => {
    const row = await engines.resolveSessionRow(id);
    return row ? { path: row.path, cwd: row.cwd } : null;
  },
  promptSession: (id, text) => engines.prompt(id, { text }),
  runnerAlive: () => scheduleSupervisor?.alive() ?? false,
  degraded: () => scheduleSupervisor?.degraded() ?? false,
  deliverToken: scheduleDeliverToken,
};

// tips 用法提示（docs08 plan 任务 25）：引擎 CLI --list-tips 缓存路由（启动缓存+5min
// TTL，失败用缓存）。引擎运行时缺失时回落 PATH 上的 omo；仍失败即空表，前端无 tip 区。
let tipsCliPath: string | undefined;
try {
  tipsCliPath = resolveEnginePaths().cliPath;
} catch {
  // 引擎运行时缺失：路由内回落 PATH omo（resolveEnginePaths 已在 schedule 装配尝试过，
  // 此处重复调用命中其模块级缓存，无额外开销）
}
const tipsDeps: TipsRouteDeps = { agentDir: agentDir(), cliPath: tipsCliPath };

const app = new Hono();

// 投递回注端点：免登录中间件（自带每次启动随机 bearer token 校验），
// 必须在 /api/* 鉴权之前挂载（同登录端点先例）
app.post("/api/schedule/deliver", createScheduleDeliverHandler(scheduleDeps));

// 公开端点：登录/登出（登录端点必须匿名可达，否则永远进不了门）
app.post("/api/auth/login", auth.login);
app.post("/api/auth/logout", auth.logout);

// 保护全部 /api/*：后续追加的业务路由自动纳入保护
app.use("/api/*", auth.middleware);
app.get("/api/health", (c) => c.json({ ok: true }));

// 请求级流量计量（docs08 批次任务 28）：/api/* 全端点按路由模板聚合 req/res 字节，
// 内存日账零点自动重置；GET /api/stats/traffic 只读查询（下方业务路由块挂载）
const trafficMeter = new TrafficMeter();
app.use("/api/*", trafficMiddleware(trafficMeter));

// 业务路由（todo 9）。SSE 事件桥（todo 10）由后续任务统一收口挂载。
// configs（todo 4）：全局目录取 UL_OMO_WEBUI_CONFIG_DIR / ~/.config/ul-omo-webui/；
// 项目 scope 配置经 projectConfigs 按注册项目派生（todo 6 合并读取与迁移共用）。
const deps = {
  meta,
  engines,
  configs,
  projectConfigs,
  titleGen,
  // 会话删除 → 该会话 pending 定时任务标 invalid（abandoned 语义，任务 21c）
  schedule: {
    onSessionDeleted: (sessionId: string) =>
      abandonSessionJobs(scheduleDir(agentDir()), sessionId, "abandoned: session deleted"),
  },
  // 会话 rebind（r10 todo 18）：与 spawn 同源的 agent 目录（会话库定位依据）
  agentDir: agentDir(),
};
app.route("/", createScheduleRoutes(scheduleDeps));
app.route("/", createSessionRoutes(deps));
app.route("/", createRebindRoutes(deps));
app.route("/", createMetaRoutes(deps));
app.route("/", createCommandsRoutes(deps));
app.route("/", createProjectRoutes(deps));
app.route("/", createGitRoutes(deps));
app.route("/", createFsRoutes(deps));
app.route("/", createFsWriteRoutes(deps));
app.route("/", createSnippetsRoutes(deps));
app.route("/", createTagsRoutes(deps));
app.route("/", createNotesRoutes(deps));
// 计划执行进度只读面（r10 todo 12）：会话→boulder 绑定→计划 todo 勾选态速览
app.route("/", createPlansRoutes({ engines }));
app.route("/", createMemoryRoutes(deps));
app.route("/", createTipsRoutes(tipsDeps));
// 扩展资源面与 auth 凭证检查（docs08-r7 任务 24）：CLI 缺失时 install/remove/update 降级报错
app.route("/", createExtensionsRoutes({ agentDir: agentDir(), engineCli: resolveEngineCli(resolveEnginePaths().pluginDir) }));
app.route("/", createTrafficRoutes({ meter: trafficMeter }));
app.route("/api", sseRoutes);

// 静态资源匿名可访问：SPA 是单页壳，index.html 与 assets 同时承担登录页，
// 页面路由的未授权跳转由前端依据 API 401 处理（todo 13）。
// 双路径（W6 todo 29）：
// - 内嵌资产（编译产物 / 构建脚本生成模块）：内存直出，不依赖磁盘；
//   index.html no-cache（保 SPA 更新即时生效），带 hash 的 assets/ 长缓存
// - 磁盘 web/dist（源码形态，hono/bun serveStatic）：root 参数相对 process.cwd()，
//   换算成相对路径后从任意目录启动都能解析回同一绝对目录
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

function mimeTypeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? (MIME_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream") : "application/octet-stream";
}

const embeddedStatic = await loadEmbeddedStatic();

function embeddedAssetResponse(relPath: string, asset: { data: string; binary: boolean }, cacheControl: string): Response {
  const body = asset.binary ? Buffer.from(asset.data, "base64") : asset.data;
  return new Response(body, {
    headers: { "content-type": mimeTypeOf(relPath), "cache-control": cacheControl },
  });
}

if (embeddedStatic) {
  const indexHtml = embeddedStatic["index.html"];
  if (!indexHtml) {
    console.error("启动失败：内嵌静态资产缺少 index.html（构建产物不完整），请重跑 scripts/build-binary.ts");
    process.exit(1);
  }
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: { code: "not_found", message: "route not found" } }, 404);
    }
    // 裸 handler 不在 route() 包装内：畸形百分号编码（如 /%zz）须就地转 400 JSON，
    // 否则 URIError 落 Hono 默认 onError 返回纯文本 500
    let relPath: string;
    try {
      relPath = embeddedRelPath(c.req.path);
    } catch (err) {
      return toErrorResponse(c, err);
    }
    const asset = embeddedStatic[relPath];
    if (asset) {
      // vite 产物 assets/ 文件名带内容 hash，可长缓存 immutable
      const cache = relPath.startsWith("assets/") ? "public, max-age=31536000, immutable" : "public, max-age=300";
      return embeddedAssetResponse(relPath, asset, cache);
    }
    // SPA fallback：非文件路径全部回落 index.html（登录页与前端路由依赖）
    return embeddedAssetResponse("index.html", indexHtml, "no-cache");
  });
} else {
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
}

// 优雅关停：停全部引擎子进程（SIGTERM→兜底强杀）+ 关元数据库
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  detachEventBus();
  detachTombstones();
  try {
    await scheduleSupervisor?.stop();
  } catch {
    // 尽力关停
  }
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
  const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT, overrideGlobalObjects: false });
  server.on("error", (err: NodeJS.ErrnoException) => {
    const message = err?.message ?? String(err);
    if (err?.code === "EADDRINUSE" || message.includes("in use")) {
      console.error(
        `启动失败：地址 ${HOST}:${PORT} 已被占用。按部署约定不静默换端口，请释放端口或改用 UL_OMO_WEBUI_PORT 指定其他端口。`,
      );
    } else {
      console.error(`启动失败：${message}`);
    }
    process.exit(1);
  });
  const onListening = () => {
    console.log(`ul-omo-webui listening on http://${HOST}:${PORT}`);
    // 存量项目偏好迁移（todo 6）：监听就绪后 fire-and-forget——per-project 失败仅
    // console.warn 并保留库值（幂等下次补迁），allSettled 隔离单项目只读目录/挂死
    // （网络盘语义）不拖累其余项目，更不阻塞监听与请求
    void migrateProjectPreferences(projectConfigs, meta).catch((err: unknown) => {
      console.warn(`项目偏好迁移异常中断（下次启动补迁）：${err instanceof Error ? err.message : String(err)}`);
    });
    // 附件临时区按龄清理（docs08-r3 任务 17）：启动时扫 DATA_DIR/attachments/*/ 下
    // mtime>48h 的文件删除。发送成功后附件文件刻意留存（prompt 只带路径行，引擎
    // 随时按需读取），用户显式移除才即时删——此处是唯一的过期兜底，不是常规删除路径。
    try {
      const purged = purgeStaleAttachments(attachmentsRoot());
      if (purged > 0) console.log(`附件临时区清理：${purged} 个过期文件（>48h）`);
    } catch (err) {
      console.warn(`附件临时区清理失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // node-server 的 serve() 返回时可能已在监听（事件已发过），双保险挂接
  if (server.listening) onListening();
  else server.on("listening", onListening);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`启动失败：${message}`);
  process.exit(1);
}
