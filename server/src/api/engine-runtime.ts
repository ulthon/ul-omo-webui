// 组合根运行时（todo 9）：引擎子进程管理器单例 + 按项目懒加载的 adapter。
//
// 单驱动纪律（docs/verification/05 P2-11 结论）：引擎无跨进程排他锁——两个驱动方
// open 同一 sessionPath 都会成功且写入交错进同一 JSONL，"already processing" 守卫
// 只在单进程内生效。webui 必须自律单驱动：
// - 每个项目运行时跟踪 streamingSessionId（当前处于 webui 驱动回合中的会话 durable id），
//   对它在回合中的再次 prompt 直接返回 409 already_processing（不等引擎守卫报错）；
//   即使外部因素绕过（事件丢失/外部驱动），引擎 "already processing" 错误也映射为 409。
// - 会话切换（openSession）走 per-project 互斥队列串行化：prompt 的「切换+发送」
//   原子化，防止并发请求把 prompt 路由到错误会话（RpcClient prompt 路由到最近 open
//   的会话，docs/verification/01 结论 4）。回合流式期间互斥已释放（prompt 在接受时
//   返回），读操作不长时间阻塞；/命令 prompt 的 RPC 会拖到对话框落定（verification/02
//   结论 4），期间该项目的会话操作排队等待——单用户产品可接受，已注释。
//
// 会话身份（todo 8 实证约束）：一律用 durable id（磁盘 header id，重启后 open
// sessionPath 不变）。open_session 响应里的 state.sessionId 是 host 侧 holder UUID
// （随进程变化），禁止持久化——仅当新会话尚未落盘、activeSessions 行还没有
// durableSessionId 时，把它作为进程内别名使用（内存 alias map，进程结束即失效）。
//
// 引擎生命周期归 EngineProcessManager（todo 8）：spawn/崩溃重启/退避/空闲回收/
// 孤儿清扫都在管理器内。adapter 通过 clientFactory 挂到管理器已 spawn 的连接上，
// 生命周期钩子（start/stop）为 no-op——引擎崩溃重启后管理器会造新 client，
// ensure() 检测到 client 更换即重建 adapter 并清空会话态。
import type { RpcClient } from "@code-yeongyu/senpi";
import { existsSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type EngineAdapter,
  type EngineEntry,
  type EngineMessagesPage,
  type EngineModelInfo,
  type EngineOpenSessionResult,
  type EnginePermissionReply,
  type EnginePromptInput,
  type EngineSessionSummary,
  type EngineThinkingLevel,
  type EngineUsageStats,
} from "../adapter/engine-adapter";
import { SenpiAdapter, type SenpiRpcClient } from "../adapter/senpi-adapter";
import type { EngineProcessManager } from "../engine/process-manager";
import { ApiError } from "./http";

/** 路由层依赖的引擎网关面（真实实现 = EngineRuntimeRegistry；单测注入 fake） */
export interface EngineGateway {
  /** 项目历史会话列表（SDK 直读会话库，不触发引擎 spawn） */
  sessionsList(project: string): Promise<EngineSessionSummary[]>;
  /** 新建会话（需引擎进程）；返回 durable id（未落盘时为进程内别名） */
  createSession(
    project: string,
    opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }>;
  /** 会话消息分页（游标 = 上页 leafId） */
  messages(sessionId: string, cursor?: string): Promise<EngineMessagesPage>;
  /**
   * 发送 prompt。单驱动约束：目标会话回合进行中抛 ApiError(409, "already_processing")。
   * model 为 "provider/model" 形态（可选，切换当前会话模型）。
   */
  prompt(
    sessionId: string,
    input: { text: string; images?: EnginePromptInput["images"]; model?: string },
  ): Promise<{ disposition: string }>;
  abort(sessionId: string): Promise<void>;
  permissionRespond(sessionId: string, requestId: string, reply: EnginePermissionReply): Promise<void>;
  usage(sessionId: string): Promise<EngineUsageStats>;
  modelsList(project: string): Promise<EngineModelInfo[]>;
  /**
   * 删除会话：引擎无删除协议面（rpc-client 全方法核对），实行为删磁盘会话文件
   * 与对应 -artifacts 目录（存在才删，删失败不阻塞），元数据行由路由层清理。
   */
  deleteSession(sessionId: string): Promise<{ sessionPath: string; fileExisted: boolean }>;
  /**
   * 引擎就绪时返回**回合进行中**（webui 驱动的流式回合）会话路径列表；
   * 未就绪返回 null（不触发 spawn），就绪且空闲返回 []。
   * 语义注意：不是引擎 open 会话全集——open 态在回合结束后仍保留，
   * 前端 `active` 字段语义 = 回合进行中（todo 15 实证修复）。
   */
  peekActiveSessionPaths(project: string): Promise<string[] | null>;
  stopAll(): Promise<void>;
}

export interface EngineRuntimeOptions {
  /** 已知项目列表（组合根注入，通常来自 meta_project），供会话 id 反查扫描 */
  listProjects(): string[];
  /** OMO_CODING_AGENT_DIR / SENPI_CODING_AGENT_DIR（缺省 ~/.pi/agent，W1 spawn 规范） */
  agentDir?: string;
  /**
   * 合成收尾事件出口（组合根接 EventBus.publish，进同一 SSE 信封管道）。
   * 仅在「prompt 已接受、引擎 get_state 复核已空闲、真实收尾事件宽限期内仍未到」
   * 时调用（todo 16 实证的收尾事件缺席缺陷的权威空闲判定回退），严禁常态化轮询。
   */
  publishSyntheticEvent?(projectPath: string, event: Record<string, unknown>): void;
  /** 新 assistant 消息落地回调（组合根接 meta.incrementUnread；未读计数服务端接线） */
  recordUnread?(projectPath: string, durableSessionId: string): void;
  /** 收尾监视轮询间隔毫秒（默认 2000，仅回合进行中运行）。 */
  settlePollMs?: number;
  /** 引擎空闲观察到真实收尾事件缺席时，合成前的宽限毫秒（默认 5000）。 */
  settleGraceMs?: number;
}

function defaultAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

/** models-store.json 直读降级（形态见 docs/verification/00-env.md；读取失败返回空列表） */
function readModelsStore(agentDir: string): EngineModelInfo[] {
  const file = join(agentDir, "models-store.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      { models?: Array<{ id?: unknown; reasoning?: unknown; contextWindow?: unknown; thinkingLevelMap?: unknown }> }
    >;
    const out: EngineModelInfo[] = [];
    for (const [provider, entry] of Object.entries(parsed)) {
      for (const model of entry.models ?? []) {
        const info: EngineModelInfo = { provider, id: String(model.id ?? "") };
        if (!info.id) continue;
        if (typeof model.contextWindow === "number") info.contextWindow = model.contextWindow;
        if (typeof model.reasoning === "boolean") info.reasoning = model.reasoning;
        if (model.thinkingLevelMap && typeof model.thinkingLevelMap === "object") {
          info.supportedThinkingLevels = Object.keys(model.thinkingLevelMap);
        }
        out.push(info);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 把管理器已 spawn 的 RpcClient 包装成 adapter 的 client 面：
 * start/stop 为 no-op（生命周期归管理器），其余方法全部委托。
 * 整体 cast 原因：getEntries 的 SessionEntry 与 adapter 的 EngineEntry 是同一 wire
 * 形态（adapter 层已按此假设映射，见 senpi-adapter.ts 的默认工厂同样处理）。
 */
function wrapLifecycleClient(client: RpcClient): SenpiRpcClient {
  // adapter 的就绪探测直接取 client.send（senpi-adapter.ts start()），包装层必须暴露
  const rawSend = (client as unknown as { send: (m: unknown) => Promise<{ success: boolean }> }).send.bind(client);
  const wrapped = {
    start: async () => {},
    stop: async () => {},
    send: (message: unknown) => rawSend(message),
    setClientInfo: (width: number, capabilities?: string[]) => client.setClientInfo(width, capabilities),
    openSession: (options: Parameters<SenpiRpcClient["openSession"]>[0]) =>
      client.openSession(options as never),
    closeSession: (sessionId?: string) => client.closeSession(sessionId),
    listSessions: () => client.listSessions(),
    getEntries: (since?: string) => client.getEntries(since),
    prompt: (message: string, options?: { thinkingLevel?: string; images?: EnginePromptInput["images"] }) =>
      client.prompt(message, options as never),
    abort: () => client.abort(),
    onEvent: (listener: (event: { type: string; [key: string]: unknown }) => void) =>
      client.onEvent(listener as never),
    sendExtensionUIResponse: (response: Record<string, unknown>) =>
      client.sendExtensionUIResponse(response as never),
    getAvailableModels: () => client.getAvailableModels(),
    getAvailableThinkingLevels: () => client.getAvailableThinkingLevels(),
    getSessionStats: () => client.getSessionStats(),
    getMedia: (toolCallId: string, contentIndex: number) => client.getMedia(toolCallId, contentIndex),
  };
  return wrapped as unknown as SenpiRpcClient;
}

/** 单项目运行时：adapter 挂管 + 会话态 + 操作互斥 */
class ProjectRuntime {
  private adapter: EngineAdapter | null = null;
  private wrappedClient: RpcClient | null = null;
  /** API 世界的活跃会话 id（durable id 或未落盘别名） */
  private activeId: string | null = null;
  /** 当前处于 webui 驱动回合中的会话 id（单驱动 409 依据） */
  private streamingId: string | null = null;
  /** wire sessionId（routing handle）→ durable id 映射（SSE 信封注入用）：
   * 只记录 store 验证过的 durable id（open_session 响应 handle + activeSessions 行），
   * 查不到的 handle 如实透传不猜。引擎重启 handle 全换，invalidate 时清空。 */
  private readonly handleToDurable = new Map<string, string>();
  /** 防抖：handle 查询 miss 时至多一个在途的 activeSessions 刷新 */
  private refreshInFlight = false;
  /** 已验证的 durable id 集合（合成事件 sessionId 直接是 durable id，
   * 信封 durableLookup 需要能识别它以注入 durableSessionId）。 */
  private readonly knownDurable = new Set<string>();
  /** 未落盘新会话的 holder UUID → sessionPath 别名（仅内存，禁止持久化） */
  private readonly aliases = new Map<string, string>();
  /** 操作互斥链：串行化「切换活跃会话 + 作用于活跃会话」的关键区 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 回合进行中会话的 sessionPath（GET /api/sessions 的 active 字段依据，todo 15 修复） */
  private streamingPath: string | null = null;
  /** 回合序号：每次 prompt 接受自增；收尾监视的过期判定用 */
  private roundSeq = 0;
  /** 收尾监视定时器（仅回合进行中运行，严禁常态化轮询） */
  private settleTimer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 已计过未读的 assistant 消息 id（幂等去重；封顶防泄漏） */
  private readonly countedMessages = new Set<string>();

  constructor(
    private readonly manager: EngineProcessManager,
    readonly projectPath: string,
    private readonly opts: EngineRuntimeOptions,
  ) {}

  /** 引擎进程是否已就绪（不触发 spawn） */
  isReady(): boolean {
    return this.manager.getStatus(this.projectPath)?.state === "ready" && this.adapter !== null;
  }

  /**
   * 确保引擎进程就绪且 adapter 可用。管理器崩溃自动重启后会造新 client，
   * 检测到 client 更换即重建 adapter（旧 adapter 挂着死连接）并清空会话态。
   */
  async ensure(): Promise<void> {
    await this.manager.ensureRunning(this.projectPath);
    const client = this.manager.getClient(this.projectPath);
    if (!client) {
      throw new ApiError(503, "engine_not_ready", `项目引擎未就绪：${this.projectPath}`);
    }
    if (!this.adapter || this.wrappedClient !== client) {
      this.wrappedClient = client;
      this.activeId = null;
      this.streamingId = null;
      this.streamingPath = null;
      this.aliases.clear();
      this.handleToDurable.clear();
      this.knownDurable.clear();
      this.stopSettleWatch();
      const adapter: SenpiAdapter = new SenpiAdapter({
        projectDir: this.projectPath,
        agentDir: this.opts.agentDir ?? defaultAgentDir(),
        clientFactory: () => wrapLifecycleClient(client),
      });
      await adapter.start();
      this.adapter = adapter;
      // 回合结束信号：abort 与正常收尾都会发 agent_end / agent_settled
      // （docs/verification/01 abort 实证），清单驱动标记与收尾监视。
      adapter.events((event) => {
        const wire = event as {
          type?: string;
          sessionId?: unknown;
          entry?: { type?: unknown; id?: unknown; message?: { role?: unknown } };
        };
        const type = wire.type;
        if (type === "agent_end" || type === "agent_settled" || type === "agent_idle") {
          this.settleRound();
          return;
        }
        // 未读计数接线（todo 15 发现刷新归零）：assistant 消息条目落地即 unread+1。
        // 事件源取 entry_appended（entry.type==="message" 且 role=assistant）——
        // entry.id 是磁盘条目 id，天然满足「按 entryId 幂等」；message_end 的
        // message 体无 id 字段（实证），不作未读源。
        // 设计取舍：主动查看中的会话同样递增——前端在回合落定时对当前选中会话
        // 补发 POST /:id/read（清零+last_read），服务端不做「正在看」判定。
        if (type === "entry_appended" && wire.entry && wire.entry.type === "message") {
          const role = wire.entry.message?.role;
          const entryId = typeof wire.entry.id === "string" ? wire.entry.id : undefined;
          const handle = typeof wire.sessionId === "string" ? wire.sessionId : undefined;
          if (role === "assistant" && entryId && handle) {
            this.recordUnreadFor(handle, entryId);
          }
        }
      });
    }
  }

  /** assistant 消息条目落地 → unread+1；按 entry id 幂等（同一 entry 只计一次）。 */
  private recordUnreadFor(handle: string, entryId: string): void {
    if (this.countedMessages.has(entryId)) return;
    this.countedMessages.add(entryId);
    if (this.countedMessages.size > 2000) {
      // Set 保持插入序，裁掉最早的半量，防长驻进程缓慢泄漏
      for (const key of [...this.countedMessages].slice(0, 1000)) this.countedMessages.delete(key);
    }
    const durable = this.durableSessionIdFor(handle);
    if (durable) this.opts.recordUnread?.(this.projectPath, durable);
  }

  // ---- 收尾监视（todo 16 实证：个别回合收尾 wire 事件全部缺席）----
  // prompt 接受后以 settlePollMs 间隔 get_state 辅助监视：引擎确实空闲
  // （isStreaming=false）且宽限期内真实收尾事件未到 → 合成 agent_settled
  //（synthetic:true）进事件流，保证下游「回合结束」语义完整。仅在回合
  // 进行中运行，回合正常收尾即停；消息内容补全靠前端 GET messages 兜底。

  /** prompt 接受后启动收尾监视（幂等；同一时刻只有一个回合在驱动的项目级单例） */
  private startSettleWatch(): void {
    if (this.settleTimer) return;
    const pollMs = this.opts.settlePollMs ?? 2000;
    this.settleTimer = setInterval(() => {
      void this.checkSettle().catch(() => undefined);
    }, pollMs);
    this.settleTimer.unref?.();
  }

  private stopSettleWatch(): void {
    if (this.settleTimer) {
      clearInterval(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private async checkSettle(): Promise<void> {
    if (this.streamingId === null || !this.adapter) {
      this.stopSettleWatch();
      return;
    }
    const seq = this.roundSeq;
    const client = this.wrappedClient;
    if (!client) return;
    let isStreaming: unknown;
    try {
      const state = await (client as unknown as { getState: () => Promise<{ isStreaming?: unknown }> }).getState();
      isStreaming = state.isStreaming;
    } catch {
      return; // get_state 偶发失败不判收尾，下一轮再查
    }
    if (isStreaming !== false || this.streamingId === null || seq !== this.roundSeq) return;
    // 引擎已空闲但真实收尾事件未到：宽限一次（真实事件迟到则落定后跳过）
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.streamingId === null || seq !== this.roundSeq) return;
      this.synthesizeSettled(seq);
    }, this.opts.settleGraceMs ?? 5000);
    this.graceTimer.unref?.();
  }

  /** 合成 agent_settled：带 synthetic 标记；sessionId 直接用 durable id
   *（流式中的会话必已 open，identity 已知），前端信封回退路径可直接路由。 */
  private synthesizeSettled(seq: number): void {
    if (this.streamingId === null || seq !== this.roundSeq) return;
    const sessionId = this.streamingId;
    this.settleRound();
    this.opts.publishSyntheticEvent?.(this.projectPath, {
      type: "agent_settled",
      synthetic: true,
      sessionId,
      reason: "settle_watchdog",
    });
  }

  /** 回合落定：清流式标记（GET /api/sessions active 随之清位）+ 停监视 */
  private settleRound(): void {
    this.streamingId = null;
    this.streamingPath = null;
    this.stopSettleWatch();
  }

  /** 崩溃/重启时清空会话态（adapter 留给 ensure() 按 client 更换重建）。
   * handle→durable 映射一并清空：旧 handle 属于已死进程，保留只会误映射。 */
  invalidate(): void {
    this.activeId = null;
    this.streamingId = null;
    this.streamingPath = null;
    this.aliases.clear();
    this.handleToDurable.clear();
    this.knownDurable.clear();
    this.stopSettleWatch();
  }

  /** 引擎就绪时的**回合进行中**会话路径（active 字段语义 = 回合进行中，todo 15 修复） */
  async activeSessionPaths(): Promise<string[]> {
    if (!this.adapter) return [];
    // open 态行有副产物价值：顺带回填 handle→durable 映射（权威来源）
    try {
      const rows = await this.adapter.activeSessions();
      this.rememberHandleRows(rows);
    } catch {
      // 探询失败不阻塞 active 判定
    }
    return this.streamingPath ? [this.streamingPath] : [];
  }

  /** 活跃会话行的 handle→durableSessionId 回填（list_sessions 行两个字段都有，权威来源） */
  private rememberHandleRows(rows: Array<{ sessionId?: string; durableSessionId?: string }>): void {
    for (const row of rows) {
      if (row.sessionId && row.durableSessionId) {
        this.handleToDurable.set(row.sessionId, row.durableSessionId);
        this.knownDurable.add(row.durableSessionId);
      }
    }
  }

  /** wire sessionId → durable id：routing handle 查映射；合成事件的 sessionId
   * 本身就是 durable id（直认）。其余（未知 handle）返回 undefined（透传不猜）。
   * miss 时异步刷新一次活跃会话行（去重防事件风暴期间 RPC 刷屏）。 */
  durableSessionIdFor(handle: string): string | undefined {
    const hit = this.handleToDurable.get(handle);
    if (hit !== undefined) return hit;
    if (this.knownDurable.has(handle)) return handle;
    if (!this.refreshInFlight && this.adapter) {
      this.refreshInFlight = true;
      void this.adapter
        .activeSessions()
        .then((rows) => this.rememberHandleRows(rows))
        .catch(() => undefined)
        .finally(() => {
          this.refreshInFlight = false;
        });
    }
    return undefined;
  }

  /** SDK 直读会话库（不依赖引擎进程，sessionsList 不走 rpc） */
  async listStore(): Promise<EngineSessionSummary[]> {
    if (!this.adapter) {
      // 未 start 的 adapter 只有 options + sessionsList 可用（sessionsList 不调 rpc）
      this.adapter = new SenpiAdapter({
        projectDir: this.projectPath,
        agentDir: this.opts.agentDir ?? defaultAgentDir(),
      });
    }
    return this.adapter.sessionsList(this.projectPath);
  }

  /** 在本项目中按 id 查会话（活跃态 → store 行 → 未落盘别名）；查不到抛 404 */
  async resolveSession(sessionId: string): Promise<EngineSessionSummary> {
    // 活跃会话快捷路径：刚创建未落盘的会话不在 store 行内，活跃态即可定位
    if (this.activeId === sessionId) {
      const active = this.adapter?.getActiveSession();
      if (active) {
        return {
          path: active.sessionPath,
          id: sessionId,
          cwd: this.projectPath,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 0,
          firstMessage: "",
        };
      }
    }
    const rows = await this.listStore();
    const row = rows.find((r) => r.id === sessionId);
    if (row) return row;
    const aliasPath = this.aliases.get(sessionId);
    if (aliasPath) {
      return {
        path: aliasPath,
        id: sessionId,
        cwd: this.projectPath,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 0,
        firstMessage: "",
      };
    }
    throw new ApiError(404, "session_not_found", `会话不存在（项目 ${this.projectPath}）：${sessionId}`);
  }

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** 确保目标会话是 adapter 活跃会话（open 切换；同会话幂等） */
  private async switchTo(sessionId: string): Promise<void> {
    const adapter = this.requireAdapter();
    if (this.activeId === sessionId && adapter.getActiveSession()) return;
    const row = await this.resolveSession(sessionId);
    const opened = await adapter.openSession({ sessionPath: row.path });
    this.activeId = sessionId;
    // wire 事件的 sessionId 就是这个 routing handle（open_session 响应顶层的
    // sessionId）；store 行解析出的 id（非别名）即可作为 durable 映射记录
    if (!this.aliases.has(sessionId)) this.rememberHandle(opened.routingId, sessionId);
  }

  private rememberHandle(handle: string | undefined, durableId: string | undefined): void {
    if (!handle || !durableId) return;
    this.handleToDurable.set(handle, durableId);
    this.knownDurable.add(durableId);
  }

  requireAdapter(): EngineAdapter {
    if (!this.adapter) throw new ApiError(409, "not_started", "项目运行时未初始化");
    return this.adapter;
  }

  async createSession(opts: {
    provider?: string;
    modelId?: string;
    thinkingLevel?: EngineThinkingLevel;
  }): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    await this.ensure();
    const adapter = this.requireAdapter();
    return this.runExclusive(async () => {
      const opened: EngineOpenSessionResult = await adapter.openSession({
        provider: opts.provider,
        modelId: opts.modelId,
        thinkingLevel: opts.thinkingLevel,
      });
      // durable id 解析：活跃会话行的 durableSessionId 是引擎侧磁盘 header id
      // （docs/verification/05 P1-1：list_sessions 行含 durableSessionId）。
      // 新会话未落盘时行可能缺失 durableSessionId，退化为 holder 别名（仅内存）。
      let id = opened.sessionId;
      let durable = false;
      try {
        const rows = await adapter.activeSessions();
        this.rememberHandleRows(rows);
        const row = rows.find((r) => r.sessionPath === opened.sessionPath && r.durableSessionId);
        if (row?.durableSessionId) {
          id = row.durableSessionId;
          durable = true;
        }
      } catch {
        // 活跃行查询失败不影响建会话，退化为别名
      }
      if (!durable) {
        this.aliases.set(id, opened.sessionPath);
      } else {
        // open_session 响应顶层 sessionId 即 routing handle（wire 事件同源）
        this.rememberHandle(opened.routingId, id);
      }
      this.activeId = id;
      return { id, sessionPath: opened.sessionPath, durable };
    });
  }

  async messages(sessionId: string, cursor?: string): Promise<EngineMessagesPage> {
    await this.ensure();
    return this.runExclusive(async () => {
      await this.switchTo(sessionId);
      return this.requireAdapter().messages(cursor);
    });
  }

  async prompt(
    sessionId: string,
    input: { text: string; images?: EnginePromptInput["images"]; model?: string },
  ): Promise<{ disposition: string }> {
    await this.ensure();
    return this.runExclusive(async () => {
      // 单驱动约束（P2-11）：目标会话已有 webui 驱动回合时明确 409，不排队不双驾驶
      if (this.streamingId === sessionId) {
        throw new ApiError(409, "already_processing", "该会话已有进行中的回合（单驱动约束，请先 abort 或等待回合结束）");
      }
      await this.switchTo(sessionId);
      if (input.model) {
        await this.switchModel(input.model);
      }
      const adapter = this.requireAdapter();
      try {
        const receipt = await adapter.prompt({ text: input.text, images: input.images });
        // disposition="handled"（如 /命令）表示没有开启回合，不等 agent_settled
        if (receipt.disposition !== "handled") {
          this.streamingId = sessionId;
          this.streamingPath = adapter.getActiveSession()?.sessionPath ?? null;
          this.roundSeq += 1;
          this.startSettleWatch();
        }
        return receipt;
      } catch (err) {
        // 外部驱动或事件丢失兜底：引擎进程内守卫的报错映射为同一 409 语义
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("already processing")) {
          throw new ApiError(409, "already_processing", "引擎报告会话正在处理中（单驱动约束）");
        }
        throw err;
      }
    });
  }

  /** adapter 无模型切换面（接口未含 setModel）；直接走协议命令，仅作用于当前活跃会话 */
  private async switchModel(model: string): Promise<void> {
    const slash = model.indexOf("/");
    if (slash <= 0) {
      throw new ApiError(400, "invalid_model", `model 需为 "provider/model" 形态：${model}`);
    }
    const provider = model.slice(0, slash);
    const modelId = model.slice(slash + 1);
    await this.wrappedClient?.setModel(provider, modelId);
  }

  async abort(sessionId: string): Promise<void> {
    await this.ensure();
    return this.runExclusive(async () => {
      await this.switchTo(sessionId);
      await this.requireAdapter().abort();
    });
  }

  async permissionRespond(sessionId: string, requestId: string, reply: EnginePermissionReply): Promise<void> {
    await this.ensure();
    return this.runExclusive(async () => {
      await this.switchTo(sessionId);
      await this.requireAdapter().permissionRespond(requestId, reply);
      // 应答 wire 上无事件回声，必须显式上报解除忙判定（todo 8 空闲回收口径）
      this.manager.reportPermissionAnswered(this.projectPath, requestId);
    });
  }

  async usage(sessionId: string): Promise<EngineUsageStats> {
    await this.ensure();
    return this.runExclusive(async () => {
      await this.switchTo(sessionId);
      return this.requireAdapter().usage();
    });
  }

  async modelsList(): Promise<EngineModelInfo[]> {
    // 引擎未就绪时不为模型列表触发冷启动 spawn，直接走模型目录降级
    if (!this.isReady()) return readModelsStore(this.opts.agentDir ?? defaultAgentDir());
    const adapter = this.requireAdapter();
    if (adapter.getActiveSession()) return adapter.modelsList();
    // 无活跃会话时协议面报 missing_session_id（多会话模式命令需会话路由）。
    // 降级：直读引擎同一份模型目录 models-store.json（W0 实证格式
    // {provider:{models:[{id,reasoning,cost,contextWindow,thinkingLevelMap,...}]}}）。
    // 与协议面的差异：协议面按当前 provider 过滤，此处为全 provider 超集。
    return readModelsStore(this.opts.agentDir ?? defaultAgentDir());
  }

  async deleteSession(sessionId: string): Promise<{ sessionPath: string; fileExisted: boolean }> {
    const row = await this.resolveSession(sessionId);
    if (this.adapter) {
      await this.runExclusive(async () => {
        if (this.streamingId === sessionId) {
          await this.requireAdapter().abort().catch(() => undefined);
        }
        if (this.activeId === sessionId && this.requireAdapter().getActiveSession()) {
          await this.requireAdapter().closeSession().catch(() => undefined);
          this.activeId = null;
        }
      });
    }
    // 引擎无会话删除协议面（rpc-client 全方法核对）——直接删磁盘会话文件。
    // 打开既有会话会追加扩展 bookkeeping 条目是正常语义，删除同理属文件级操作。
    let fileExisted = false;
    try {
      unlinkSync(row.path);
      fileExisted = true;
    } catch {
      // 文件尚未落盘（空会话）或已被删：仅清元数据
    }
    // 同清理 open_session 预建的 <sessionFile 去 .jsonl>-artifacts 目录
    //（todo 15 实证残留空目录）；存在才删，删失败不阻塞主删除。
    const artifactsDir = row.path.replace(/\.jsonl$/, "") + "-artifacts";
    try {
      if (existsSync(artifactsDir) && statSync(artifactsDir).isDirectory()) {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    } catch {
      // 残留不阻塞删除主流程
    }
    this.aliases.delete(sessionId);
    this.countedMessages.clear();
    return { sessionPath: row.path, fileExisted };
  }
}

/** 引擎网关：路由层唯一入口。按项目懒加载运行时，会话 id 全局反查。 */
export class EngineRuntimeRegistry implements EngineGateway {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  /** sessionId → 运行时索引（createSession 填充 + 已知项目扫描回填） */
  private readonly index = new Map<string, ProjectRuntime>();

  constructor(
    private readonly manager: EngineProcessManager,
    private readonly opts: EngineRuntimeOptions,
  ) {
    // 引擎崩溃/不可用即清对应运行时会话态（adapter 由 ensure() 按 client 更换重建）
    manager.onEvent((event) => {
      if (event.type === "process_crashed" || event.type === "engine_unavailable") {
        const projectPath = (event as { projectPath?: string }).projectPath;
        if (projectPath) this.runtimes.get(projectPath)?.invalidate();
      }
    });
  }

  listProjectPaths(): string[] {
    return this.opts.listProjects();
  }

  private runtimeFor(project: string): ProjectRuntime {
    let rt = this.runtimes.get(project);
    if (!rt) {
      rt = new ProjectRuntime(this.manager, project, this.opts);
      this.runtimes.set(project, rt);
    }
    return rt;
  }

  /** 全局反查会话所属项目（索引 → 已知项目逐个扫 store；扫描不触发 spawn） */
  private async resolveRuntime(sessionId: string): Promise<ProjectRuntime> {
    const hit = this.index.get(sessionId);
    if (hit) return hit;
    for (const project of this.opts.listProjects()) {
      const rt = this.runtimeFor(project);
      try {
        await rt.resolveSession(sessionId);
      } catch {
        continue;
      }
      this.index.set(sessionId, rt);
      return rt;
    }
    throw new ApiError(404, "session_not_found", `会话不存在于任何已知项目：${sessionId}`);
  }

  async sessionsList(project: string): Promise<EngineSessionSummary[]> {
    return this.runtimeFor(project).listStore();
  }

  async createSession(
    project: string,
    opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    const rt = this.runtimeFor(project);
    const created = await rt.createSession(opts);
    this.index.set(created.id, rt);
    return created;
  }

  async messages(sessionId: string, cursor?: string): Promise<EngineMessagesPage> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.messages(sessionId, cursor);
  }

  async prompt(
    sessionId: string,
    input: { text: string; images?: EnginePromptInput["images"]; model?: string },
  ): Promise<{ disposition: string }> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.prompt(sessionId, input);
  }

  async abort(sessionId: string): Promise<void> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.abort(sessionId);
  }

  async permissionRespond(sessionId: string, requestId: string, reply: EnginePermissionReply): Promise<void> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.permissionRespond(sessionId, requestId, reply);
  }

  async usage(sessionId: string): Promise<EngineUsageStats> {
    const rt = await this.resolveRuntime(sessionId);
    return rt.usage(sessionId);
  }

  async modelsList(project: string): Promise<EngineModelInfo[]> {
    return this.runtimeFor(project).modelsList();
  }

  async deleteSession(sessionId: string): Promise<{ sessionPath: string; fileExisted: boolean }> {
    const rt = await this.resolveRuntime(sessionId);
    const result = await rt.deleteSession(sessionId);
    this.index.delete(sessionId);
    return result;
  }

  async peekActiveSessionPaths(project: string): Promise<string[] | null> {
    const rt = this.runtimes.get(project);
    if (!rt || !rt.isReady()) return null;
    return rt.activeSessionPaths();
  }

  /** wire sessionId（routing handle）→ durable id（SSE 信封注入用）。
   * 不触发引擎 spawn；项目运行时不存在或映射不明返回 undefined（透传不猜）。 */
  durableSessionIdFor(projectPath: string, handle: string): string | undefined {
    return this.runtimes.get(projectPath)?.durableSessionIdFor(handle);
  }

  async stopAll(): Promise<void> {
    await this.manager.stopAll();
    // 引擎全停即会话态全失效：清流式标记并停收尾监视定时器
    for (const rt of this.runtimes.values()) rt.invalidate();
  }
}
