import { Hono, type Context } from "hono";
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { join, relative } from "node:path";
import { readFileSync } from "node:fs";
import { agentDir, DATA_DIR, engineRegistryPath, HOST, metaDbPath, PORT, STATIC_DIR, siteName } from "./config";
import { initDiagnosticsFlags } from "./conf/diagnostics-flags";
import { confirmUpdateOutcome } from "./update/installer";
initDiagnosticsFlags(DATA_DIR);
// 更新结果标记确认（2026-11-11 批）：首轮启动把安装后待确认标记置 ok:true；服务没
// 起来标记停在待确认，前端 lastInstall 可区分成功/未完成
confirmUpdateOutcome(DATA_DIR);
import { loadEmbeddedStatic, embeddedRelPath, injectSiteName } from "./embedded-static";
import { toErrorResponse } from "./api/http";
import { createAuth, resolvePassword } from "./auth/password";
import { openMetaDb } from "./db/meta";
import { openConfigStore } from "./conf/config-store";
import { EngineProcessManager, resolveEnginePaths } from "./engine/process-manager";
import { runEngineVersionCheck } from "./engine/version-check";
import { ScheduleRunnerSupervisor } from "./engine/schedule-runner";
import { createScheduleRoutes, createScheduleDeliverHandler, type ScheduleRouteDeps } from "./api/routes-schedule";
import { abandonSessionJobs, scheduleDir } from "./api/schedule-store";
import {
  createProjectConfigStores,
  migrateProjectPreferences,
  permissionPresetSpawnArgs,
  readProjectPreferences,
  toolsSpawnArgsFromConfig,
} from "./api/config-migration";
import { EngineRuntimeRegistry } from "./api/engine-runtime";
import { TitleGenService } from "./title-gen";
import { EventBus, attachEventBus, publishPermissionsInvalidated } from "./engine/events";
import {
  attachBackgroundTaskLedger,
  handleProjectEngineDeath,
} from "./api/background-task-ledger";
import { sessionBackgroundRunning } from "./api/background-tasks";
import { sseRoutes, setEventBus, sseConnectionCount } from "./api/sse";
import { createDiagnosticsRoutes } from "./api/routes-diagnostics";
import { buildEngineAdminRows, createEngineAdminRoutes, type EngineAdminRow } from "./api/routes-engines";
import {
  createEngineMetricsRoutes,
  deriveRecentErrors,
  makeBoundSessionResolver,
} from "./api/routes-engine-metrics";
import { ReclaimRing, createEngineReclaimsRoutes } from "./api/routes-engine-reclaims";
import { ProcMetricsSampler } from "./engine/proc-metrics";
import { createUpdateRoutes } from "./api/routes-update";
import { log } from "./obs/logger";
import { createSessionRoutes } from "./api/routes-session";
import { createRebindRoutes } from "./api/routes-rebind";
import { createMetaRoutes } from "./api/routes-meta";
import { createCommandsRoutes, invalidateCommandsCache } from "./api/routes-commands";
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
import { bootGitDiagnostics, runRuntimeRetention } from "./lib/runtime-retention";
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
// 任务 7（C4-B）第四判据数据面（同 sessionBackgroundRunning 注入先例）：排队工作
// 永不回收。数据源 = wire queue_update 帧（引擎整队变动必发、清空也发，
// ordered/steering/followUp 三列全空 = 无排队；agent-session.d.ts 实证形态）。
// 组合根订阅 manager engine_event 维护会话粒度集合后注入同步谓词；引擎退出
// ready（回收/崩溃/停止）即清键，防陈旧键永久卡死同会话后续引擎的重拉回收
// （换代重开会话时引擎 restore 会重发 queue_update，空队自然解锁）。
// 任务 7 第四判据 + engine-ux-visibility 任务 1：会话排队深度（Map 化，既供
// 排队豁免谓词（>0 即忙，语义与原 Set 版等价）也供 metrics 端点 rpcQueueDepth
// 透出）。queue_update 帧维护，引擎退出 ready 清键。被动事件驱动，非采样。
const queueDepth = new Map<string, number>();
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
  // multi-session-parallel T2：空闲回收第三判据——会话 jsonl 派生 background_running
  // 视为忙不回收（2026-11-04 3h53m 误杀事故防回归）。与 routes-session 会话列表
  // 第四态同源同一实现（jsonl 探测半边；内存 backgroundTaskLedger 是 api 层状态，
  // 按计划不取）。mtime+size 指纹缓存摊销，回收判定读到的是当前落盘态非快照。
  sessionBackgroundRunning,
  // 任务 7 第四判据：排队中视为忙不回收（集合由下方 detachQueueTracking 订阅维护）
  sessionQueuedWork: (sessionPath) => (queueDepth.get(sessionPath) ?? 0) > 0,
});
// 2026-11-04：空闲回收时长配置化（meta_kv engine.idleTimeoutMinutes：分钟数或 "never"；
// 缺省 7 天见 process-manager DEFAULTS）。启动时读一次，设置页改档经
// onSettingsChanged 钩子即时生效（下方 deps 装配处回调）。
const applyIdleTimeoutFromKv = (): void => {
  const raw = meta.getKv("engine.idleTimeoutMinutes");
  if (raw === null) return;
  if (raw === "never") {
    manager.setIdleTimeoutMs(0);
    return;
  }
  const minutes = Number(raw);
  if (Number.isFinite(minutes) && minutes > 0) manager.setIdleTimeoutMs(minutes * 60_000);
};
applyIdleTimeoutFromKv();
// 任务 7（C4-B）灰度档：meta_kv engine.activityWindowMinutes（分钟数或 "never"；
// 缺省 5 分钟）。"never"/0 = 关闭探活窗档（未发消息引擎回落 idleTimeoutMs 梯子，
// 即本批前行为）；engine.idleTimeoutMinutes="never" 仍是总逃生口（两档全停）。
// 设置写入后同钩子即时生效（下方 onSettingsChanged 回调）。改档仅影响后续判定，
// 已拉起引擎的挂起定时器由 setActivityWindowMs 重排。
const applyActivityWindowFromKv = (): void => {
  const raw = meta.getKv("engine.activityWindowMinutes");
  if (raw === null) return;
  if (raw === "never") {
    manager.setActivityWindowMs(0);
    return;
  }
  const minutes = Number(raw);
  if (Number.isFinite(minutes) && minutes >= 0) manager.setActivityWindowMs(minutes * 60_000);
};
applyActivityWindowFromKv();
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
  // 思考档三链 A：既有会话重开时若会话 jsonl 无落定记录，取项目偏好档随 open 下发
  //（损坏降级 null = 不传，与 routes-project 同一合并读链）
  projectThinkingLevel: (projectPath) => readProjectPreferences(projectConfigs, meta, projectPath).preferredThinkingLevel,
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
// 后台任务内存账本（orphan-ledger 2026-10-31，spike §3.2）：订阅 omo.task.updated
// 实时扇出，abort 竞态下 spawn 回执不落 jsonl 时任务仍可见（零轮询，纯帧驱动）。
const detachTaskLedger = attachBackgroundTaskLedger(eventBus);
setEventBus(eventBus, {
  heartbeatMs: 8000,
  // sessionPath = 桥附源引擎绑定（A→B 串显修复 2026-11-06）：透传进双键查表，
  // 帧归属只解析该引擎绑定态（兼容查表仅限无绑定的合成帧，多引擎下不猜）
  durableLookup: (projectPath, handle, sessionPath) => engines.durableSessionIdFor(projectPath, handle, sessionPath),
  // 重放过滤条件 (c)（W1 #4）：项目引擎进程 ready 才视为可应答权限请求
  // multi-session-parallel：引擎按会话键后，「项目引擎 ready」= 该项目任一
  // 会话引擎 ready；T4 已落地——墓碑杀者另带会话可解析性门槛，单引擎重启
  // 不误清兄弟会话 replay
  isEngineRunning: (projectPath) =>
    manager.getAllStatus().some((s) => s.projectPath === projectPath && s.state === "ready"),
});

// 任务 7 第四判据维护面 + 任务 1 队列深度：queue_update 帧更新会话排队深度
// （ordered/steering/followUp 三列合计；全零出键）；引擎退出 ready 清键
// （state_changed 全部退出路径覆盖：崩溃退 backoff/回收停 stopping→stopped/
// unavailable），关停时随其余订阅一并退订
const detachQueueTracking = manager.onEvent((e) => {
  if (e.type === "engine_event") {
    const wire = e.event as { type?: string; ordered?: unknown[]; steering?: unknown[]; followUp?: unknown[] };
    if (wire?.type !== "queue_update") return;
    const depth =
      (wire.ordered?.length ?? 0) + (wire.steering?.length ?? 0) + (wire.followUp?.length ?? 0);
    if (depth > 0) queueDepth.set(e.sessionPath, depth);
    else queueDepth.delete(e.sessionPath);
    return;
  }
  if (e.type === "state_changed" && e.to !== "ready") queueDepth.delete(e.sessionPath);
});

// 斜杠命令缓存失效（批次三 2026-11-07）：引擎 commands_changed（扩展/提示词/技能
// 增减）到达即清该项目命令缓存，前端事件驱动重拉立取新值，不受 60s TTL 滞后。
const detachCommandInvalidation = manager.onEvent((e) => {
  if (e.type === "engine_event") {
    const wire = e.event as { type?: string };
    if (wire?.type === "commands_changed" && e.projectPath) invalidateCommandsCache(e.projectPath);
  }
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
    publishPermissionsInvalidated(eventBus, e.projectPath); // 保持项目级：T4 sessionResolvable 已兜兄弟会话重放
    // 引擎死亡失效（spike §3.3 + §5.2 第二缺陷；multi-session-parallel 收缩为会话
    // 粒度）：三个信号 = 死亡引擎（e.sessionPath 键）死亡，其任务子会话被 owner-fd
    // 看门狗 ≤2s 连带杀死，该会话启动态回执可证明已死。只清该会话的账本快照 +
    // 只冻结该会话 jsonl 指纹（修复「回执已落盘 + 引擎死亡 → background_running
    // 永久卡死」的假阳性）；兄弟会话引擎双源不受扰——按项目清/冻会把 B 的安静
    // 后台任务误判为已死，等空闲回收连根杀（2026-11-04 3h53m 事故同型）。
    handleProjectEngineDeath(e.projectPath, [e.sessionPath]);
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

// 引擎版本分叉启动断言（engine-upgrade-5169 批 4b）：宿主包 vs spawn 侧 cli 上溯版本，
// 不一致仅告警不阻断（resolveEnginePaths 命中模块级缓存，无额外开销）
runEngineVersionCheck();

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
  // 设置写入后回调：引擎空闲时长改档即时生效（不重启）
  onSettingsChanged: (keys: string[]) => {
    if (keys.includes("engine.idleTimeoutMinutes")) applyIdleTimeoutFromKv();
    if (keys.includes("engine.activityWindowMinutes")) applyActivityWindowFromKv();
  },
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
// 诊断面（采集增强批）：日志查询/运行快照/前端日志上报；随 /api/* 鉴权中间件保护
// engines 摘要与进程管理路由共用同一 rows 构造器 buildEngineAdminRows（单一来源，
// T5 从组合根移入 routes-engines.ts）：每会话引擎一行（projectPath+sessionPath
// 记录对），无引擎的已知项目保留 inactive 行；前端每会话一行是 T6。
const engineAdminRows = (): EngineAdminRow[] =>
  buildEngineAdminRows(manager.getAllStatus(), meta.listProjectMeta());
app.route(
  "/",
  createDiagnosticsRoutes({
    logger: log,
    engines: engineAdminRows,
    sseConnections: () => sseConnectionCount(),
    bootInfo: () => ({
      node: process.version,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      uptimeSec: Math.round(process.uptime()),
      pid: process.pid,
    }),
  }),
);
// 更新面（2026-10-31 update 批）：check + install；shutdown 注入——安装成功由路由
// 响应后延迟触发本文件的优雅关停路径（引擎子进程/元库同收口），路由不碰 process.exit
app.route("/", createUpdateRoutes({ shutdown: () => void shutdown() }));
// 引擎进程管理面（2026-11-04）：列表 + 手动停；与诊断摘要同源
app.route(
  "/",
  createEngineAdminRoutes({
    listEngines: engineAdminRows,
    // T5：sessionPath 定向停单会话引擎；project 级停该项目全部会话引擎
    stopEngine: (sessionPath) => manager.stop(sessionPath),
    stopProject: (projectPath) => manager.stopProject(projectPath),
    isKnownProject: (projectPath) => meta.listProjectMeta().some((p) => p.projectPath === projectPath),
  }),
);
// 引擎指标采样面（engine-ux-visibility 任务 1）：一次性纯读采样，每引擎一行。
// 采样器为进程级单例（cpuPct 基线跨请求保持，请求驱动刷新，无定时器）。
// 全部依赖纯读：getAllStatus 内存快照 / /proc / 会话 jsonl 首块 / meta 直查 /
// log 环 / queue 跟踪 Map——零 ensure/spawn。
app.route(
  "/",
  createEngineMetricsRoutes({
    listStatuses: () => manager.getAllStatus(),
    sampler: new ProcMetricsSampler(),
    resolveBoundSession: makeBoundSessionResolver(meta),
    recentErrors: (sessionPath) => deriveRecentErrors(log.entries(), sessionPath),
    rpcQueueDepth: (sessionPath) => queueDepth.get(sessionPath) ?? 0,
    // 探活窗暴露（engine-ux-visibility 任务 2）：回收事实只读 getter + 第三判据
    // 同源注入（与 manager 构造处的 sessionBackgroundRunning 同一实现，纯读）
    reclaimFacts: (sessionPath) => manager.getReclaimFacts(sessionPath),
    backgroundRunning: (sessionPath) => sessionBackgroundRunning(sessionPath),
    now: () => Date.now(),
  }),
);
// 引擎回收历史（engine-ux-visibility 任务 6）：订阅既有 engine_reclaimed 发射点喂数
// 有界内存环——纯旁路记录，零回收路径改动；路由纯读环，无定时器无引擎交互，重启
// 即清空（易失观测面）。总览折叠诊断区「最近 N 次回收」数据源。
const reclaimRing = new ReclaimRing();
const detachReclaimHistory = manager.onEvent((e) => {
  if (e.type === "engine_reclaimed") {
    reclaimRing.push({ sessionPath: e.sessionPath, reason: e.reason });
  }
});
app.route("/", createEngineReclaimsRoutes({ listReclaims: () => reclaimRing.list() }));
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

// 站点名（engine-upgrade 2026-10-30 批次 todo3）：env 单源，进程期不变，启动时预计算。
// 未设置时 servedIndexHtml 恒等原资产对象、磁盘路拦截不注册——未设置全链与历史版本逐字节一致。
const site = siteName();

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
  // SPA fallback 与直接 /index.html 命中共用注入版（启动时一次性替换，逐请求零开销）
  const servedIndexHtml = site ? { data: injectSiteName(indexHtml.data, site), binary: false } : indexHtml;
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
    // 站点名已设置时 /index.html 显式命中也走注入版（未设置沿原路，缓存语义不变）
    if (site && relPath === "index.html") {
      return embeddedAssetResponse(relPath, servedIndexHtml, "no-cache");
    }
    const asset = embeddedStatic[relPath];
    if (asset) {
      // vite 产物 assets/ 文件名带内容 hash，可长缓存 immutable
      const cache = relPath.startsWith("assets/") ? "public, max-age=31536000, immutable" : "public, max-age=300";
      return embeddedAssetResponse(relPath, asset, cache);
    }
    // SPA fallback：非文件路径全部回落 index.html（登录页与前端路由依赖）
    return embeddedAssetResponse("index.html", servedIndexHtml, "no-cache");
  });
} else {
  const staticRoot = relative(process.cwd(), STATIC_DIR);
  // 磁盘路同源注入（engine-upgrade 2026-10-30 批次 todo3，勿只改一路）：@hono/node-server
  // 的 serveStatic 对 GET / 命中目录索引 index.html（statSync 目录后拼 index.html 直达）、
  // 对 GET /index.html 显式命中原文件——两处都会绕过 SPA fallback，拦截须注册在中间件
  // 之前。逐请求读盘注入：开发期 web 重建后注入值跟随最新产物（no-cache 语义）。
  const serveDiskIndexHtml = site
    ? (c: Context): Response => {
        let html: string;
        try {
          html = readFileSync(join(STATIC_DIR, "index.html"), "utf8");
        } catch {
          return c.json({ error: { code: "not_found", message: "route not found" } }, 404);
        }
        return new Response(injectSiteName(html, site), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
        });
      }
    : null;
  if (serveDiskIndexHtml) {
    app.get("/", serveDiskIndexHtml);
    app.get("/index.html", serveDiskIndexHtml);
  }
  app.use("*", serveStatic({ root: staticRoot }));

  // SPA fallback：非 /api 的未命中路径全部回落 index.html；/api 未命中返回 404 JSON
  const serveIndex = serveStatic({ root: staticRoot, path: "index.html" });
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: { code: "not_found", message: "route not found" } }, 404);
    }
    // 站点名已设置时 fallback 同步走读盘注入（SPA 路由如 /login 的标签页标题同源）
    if (serveDiskIndexHtml) return serveDiskIndexHtml(c);
    return (await serveIndex(c, async () => {})) ?? c.json({ error: { code: "not_found", message: "route not found" } }, 404);
  });
}

// 优雅关停：停全部引擎子进程（SIGTERM→兜底强杀）+ 关元数据库
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  detachEventBus();
  detachTaskLedger();
  detachTombstones();
  detachQueueTracking();
  detachCommandInvalidation();
  detachReclaimHistory();
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
  log.info("boot", "ready", {
    host: HOST,
    port: PORT,
    dataDir: DATA_DIR,
    logLevel: log.stats().level,
    logFile: log.stats().file,
    node: process.version,
  });
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
    // 启动 git 诊断（engine-open-read-batch 任务 8）：同样监听就绪后一次性。非 git
    // 目录与 git 缺失静默降级；版本 <2.39 打 WARN——2026-11-05 实录死锁链：git
    // 2.30.2 不支持 --diff-merges=first-parent → omo memory 扩展反复 stall →
    // session worker 隔离 → 引擎宿主连环重启（notes/facts/
    // senpi-webui-active-session-interrupt-2026-11-05.md）
    try {
      bootGitDiagnostics();
    } catch (err) {
      console.warn(`启动 git 诊断失败：${err instanceof Error ? err.message : String(err)}`);
    }
    // runtime 保留 30d（engine-open-read-batch 任务 8）：只清 webui 已登记项目派生
    // 的引擎 runtime（identity 派生与 routes-memory 同源），DRY-RUN 默认仅日志输出
    // 可删清单；meta_kv runtime.retentionEnabled="true" 才实删（realpath 守卫
    // 限制删除不逃逸 runtime 目录，详见 lib/runtime-retention.ts 头注释）
    try {
      runRuntimeRetention({
        projects: meta.listProjectMeta().map((p) => p.projectPath),
        enabled: meta.getKv("runtime.retentionEnabled") === "true",
      });
    } catch (err) {
      console.warn(`runtime 保留策略执行失败：${err instanceof Error ? err.message : String(err)}`);
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
