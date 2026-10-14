// SSE 客户端（计划 todo 14 + 健壮性后续）：整页单条连接 /api/events，自动重连指数退避，
// 事件统一经 lib/event-dispatch 的 dispatchSseEvent 入口分发进 stores。
//
// 传输双路径：
//   1. EventSource（主路径）——OPEN 后 stallTimeoutMs 内零消息判定停摆，关闭并永久切换
//      fetch 流（模式粘滞，页面生命周期内不回退）。停滞检测针对的环境病见 learnings
//      W4 todo 23：Chrome 153 的 EventSource 对 Bun SSE 流间歇停摆（OPEN 后零解析，
//      同页 fetch 流正常）。每次连接 OPEN 后布防，收到任何帧即解除——活跃收流期绝不误触发。
//   2. fetch 流（降级路径）——fetch('/api/events', {headers: Last-Event-ID}) + ReadableStream
//      手写 SSE 帧解析（event/data/id 行、多行 data 合并、心跳注释行跳过、chunk 边界缓冲），
//      断线走同一套指数退避，重连请求自带 Last-Event-ID 头（游标取自分发层记账）。
//   QA 强制开关：localStorage senpi_sse_transport=fetch 或 URL ?transport=fetch（生产用户无感）。
//
// 服务端契约（server/src/api/sse.ts）：event 行 = wire type；data 行 =
// {projectPath, event, durableSessionId?}；id 行 = 全局自增游标；游标越界先发 event: gap
// 再从最旧可用续发；心跳注释行保活。分发层据 gap 帧与游标回退做活动会话全量重取兜底。
import { dispatchSseEvent, getDispatchCursor } from "@/lib/event-dispatch";
import { useUiStore } from "@/stores/ui";

/** 客户端监听的 SSE event: 类型集合。服务端 wire type 是开放集，EventSource 模式下未列出
 * 的类型浏览器不派发（fetch 模式则全量派发、由分发层容错忽略——语义一致）；后续需消费
 * 新类型时在此追加。 */
const HANDLED_EVENT_TYPES: readonly string[] = [
  "gap",
  "message_start",
  "message_update",
  "message_end",
  "turn_end",
  "tool_execution_start",
  "tool_execution_end",
  "agent_start",
  "agent_end",
  "agent_settled",
  "agent_idle",
  "extension_ui_request", // 四型权限/表单请求（todo 15 状态点"等待权限"信号；按 method 过滤噪音）
  "engine_event", // 服务端对无 type wire 事件的兜底 event 行名
  "thinking_level_changed", // 引擎落定的思考档回显（W2 todo 8：仅选中会话同步 chip）
];

/** CONNECTING 停留超过该时长视为僵死，回前台时强制重建 */
const CONNECTING_STALE_MS = 5000;

/** fetch 流空闲上限毫秒：服务端心跳 8s，超过 3 倍窗口全静默（含心跳）视为半死连接，
 * 主动断开走重连（fetch 无原生保活感知，半死连接不会自行报错） */
const FETCH_IDLE_MS = 25000;

export interface EventsClientOptions {
  /** SSE 端点（默认 /api/events） */
  url?: string;
  /** 首次重连退避毫秒（默认 1000） */
  baseBackoffMs?: number;
  /** 退避上限毫秒（默认 30000） */
  maxBackoffMs?: number;
  /** EventSource 停滞判定窗口毫秒（默认 5000）：OPEN 后该窗口内零消息即切 fetch 流 */
  stallTimeoutMs?: number;
  /** EventSource 工厂（单测注入 mock 用） */
  createEventSource?: (url: string) => EventSource;
  /** 延时调度（单测驱动退避/停滞序列用）；返回取消函数 */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** fetch 实现（默认 globalThis.fetch；单测注入可控流用） */
  fetchImpl?: typeof fetch;
  /** 强制 fetch 流模式（QA 注入用；生产走 resolveForceFetchTransport 的开关读取） */
  forceFetchTransport?: boolean;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/** QA/自救开关：localStorage senpi_sse_transport=fetch 或 URL ?transport=fetch 强制 fetch 流。
 * bun test 无 window/localStorage，guard 返回 false。 */
function resolveForceFetchTransport(): boolean {
  try {
    if (typeof window === "undefined" || typeof localStorage === "undefined") return false;
    if (new URLSearchParams(window.location.search).get("transport") === "fetch") return true;
    return localStorage.getItem("senpi_sse_transport") === "fetch";
  } catch {
    return false;
  }
}

/** D18 诊断开关：localStorage senpi_debug_sse=1 或 URL ?debugSse=1 时，连接状态迁移与
 * 帧到达经 console.debug 输出（与服务端 SENPI_WEBUI_DEBUG_SSE 互相独立；QA 时两端同开）。
 * function 声明保证 event-dispatch 循环 import 场景下的提升绑定。 */
export function sseDebugEnabled(): boolean {
  try {
    if (typeof window === "undefined" || typeof localStorage === "undefined") return false;
    if (new URLSearchParams(window.location.search).has("debugSse")) return true;
    return localStorage.getItem("senpi_debug_sse") === "1";
  } catch {
    return false;
  }
}

function dlog(line: string): void {
  if (sseDebugEnabled()) console.debug(`[sse-client] ${line}`);
}

export class EventsClient {
  private readonly url: string;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly stallTimeoutMs: number;
  private readonly createEs: (url: string) => EventSource;
  private readonly scheduleFn: (fn: () => void, ms: number) => () => void;
  private readonly fetchImpl: typeof fetch;

  private es: EventSource | null = null;
  private abortController: AbortController | null = null;
  private stopped = true;
  /** 下一次重连的退避时长；open 成功后复位 */
  private backoffMs: number;
  private cancelTimer: (() => void) | null = null;
  private stallCancel: (() => void) | null = null;
  private wakeHooked = false;
  private openedAt = 0;
  /** 当前连接是否健康（两条传输统一维护；wake 的"不折腾健康连接"判据） */
  private online = false;
  /** 当前 EventSource 连接是否收到过帧（零帧断开 = 通道零产出，也是停摆形态之一） */
  private gotFrame = false;
  /** 当前 EventSource 连接是否成功 OPEN 过（未 OPEN 的连接失败属建连问题，非停摆） */
  private opened = false;
  /** fetch 流模式粘滞标志：一旦置位页面生命周期内不回退 EventSource */
  private stickyFetch: boolean;

  constructor(options: EventsClientOptions = {}) {
    this.url = options.url ?? "/api/events";
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 5000;
    this.createEs = options.createEventSource ?? ((url) => new EventSource(url));
    this.scheduleFn = options.schedule ?? defaultSchedule;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.stickyFetch = options.forceFetchTransport ?? resolveForceFetchTransport();
    this.backoffMs = this.baseBackoffMs;
  }

  /** 启动连接（幂等；重复调用忽略） */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.backoffMs = this.baseBackoffMs;
    this.hookWake();
    this.open();
  }

  /** 停止并关闭连接（组件卸载/登出）；之后可重新 start */
  stop(): void {
    this.stopped = true;
    this.cancelScheduled();
    this.disarmStallWatch();
    this.closeTransport();
    this.unhookWake();
  }

  /** 页面回前台唤醒（visibilitychange/pageshow 调用；公开便于单测）：
   * 连接健康时不折腾；已死、退避等待中、或 CONNECTING 僵死则取消退避计时立即重建。 */
  wake(): void {
    if (this.stopped || this.online) return;
    if (!this.stickyFetch && this.es !== null) {
      if (this.es.readyState === EventSource.OPEN) return;
      const connectingStale = Date.now() - this.openedAt > CONNECTING_STALE_MS;
      if (this.es.readyState === EventSource.CONNECTING && !connectingStale) return;
    }
    this.cancelScheduled();
    this.disarmStallWatch();
    this.closeTransport();
    this.backoffMs = this.baseBackoffMs;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    if (this.stickyFetch) {
      this.openFetch();
      return;
    }
    if (this.es) return;
    this.openEventSource();
  }

  // ---------- 传输 1：EventSource ----------

  private openEventSource(): void {
    if (this.stopped || this.es) return;
    this.openedAt = Date.now();
    this.gotFrame = false;
    this.opened = false;
    dlog(`es connecting url=${this.url}`);
    const es = this.createEs(this.url);
    this.es = es;
    es.onopen = () => {
      dlog("es open");
      this.backoffMs = this.baseBackoffMs; // 恢复在线复位退避
      this.online = true;
      this.opened = true;
      useUiStore.getState().setConnection("online");
      this.armStallWatch(); // OPEN 后布防首消息停滞判定
    };
    es.onerror = () => {
      dlog(`es error opened=${this.opened} gotFrame=${this.gotFrame} stickyFetch=${this.stickyFetch}`);
      this.online = false;
      this.disarmStallWatch();
      // OPEN 过但零帧即断（无论停滞超时还是 Chrome 侧提前断开）= EventSource 通道零产出，
      // 属停摆形态，粘滞切换 fetch 流（切换无害：fetch 模式功能等价且正是环境病解法）；
      // 未 OPEN 的连接失败属建连问题（401/拒连），fetch 同样连不上，不做切换
      if (this.opened && !this.gotFrame) this.stickyFetch = true;
      useUiStore.getState().setConnection("reconnecting");
      this.closeEs();
      this.scheduleReconnect();
    };
    for (const type of HANDLED_EVENT_TYPES) {
      es.addEventListener(type, (ev) => this.onEventSourceFrame(ev as MessageEvent));
    }
  }

  private onEventSourceFrame(ev: MessageEvent): void {
    dlog(`es frame type=${ev.type} cursor=${ev.lastEventId || "-"}`);
    this.gotFrame = true;
    this.disarmStallWatch(); // 有消息即解除停滞判定（本连接内不再检测）
    const raw = ev.lastEventId;
    const parsed = Number(raw);
    const cursor = raw !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    dispatchSseEvent(ev.type, ev.data, cursor);
  }

  /** OPEN 后 stallTimeoutMs 内零消息 → 判定 EventSource 停摆，粘滞切换 fetch 流 */
  private armStallWatch(): void {
    this.disarmStallWatch();
    this.stallCancel = this.scheduleFn(() => {
      dlog(`es stall-timeout ${this.stallTimeoutMs}ms zero-frame -> sticky fetch`);
      this.stallCancel = null;
      this.stickyFetch = true;
      this.online = false;
      useUiStore.getState().setConnection("reconnecting");
      this.closeEs();
      this.scheduleReconnect();
    }, this.stallTimeoutMs);
  }

  private disarmStallWatch(): void {
    this.stallCancel?.();
    this.stallCancel = null;
  }

  // ---------- 传输 2：fetch 流 ----------

  private openFetch(): void {
    if (this.stopped || this.abortController) return;
    const controller = new AbortController();
    this.abortController = controller;
    const headers: Record<string, string> = {};
    const cursor = getDispatchCursor();
    if (cursor !== null) headers["Last-Event-ID"] = String(cursor);
    dlog(`fetch connecting lastEventId=${cursor ?? "-"}`);
    void this.fetchImpl(this.url, { headers, signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
          throw new Error(`sse fetch HTTP ${res.status}`);
        }
        if (!res.body) throw new Error("sse fetch 无响应体");
        dlog("fetch open");
        this.online = true;
        this.backoffMs = this.baseBackoffMs;
        useUiStore.getState().setConnection("online");
        return this.pumpSseStream(res.body);
      })
      .catch((err: unknown) => {
        dlog(`fetch error aborted=${controller.signal.aborted} stopped=${this.stopped} msg=${err instanceof Error ? err.message : String(err)}`);
        if (controller.signal.aborted || this.stopped) return; // 主动关闭不重连
        controller.abort(); // 幂等：异常退出（idle timeout / stream ended）时中止半死的响应流，防连接累积
        this.abortController = null; // 连接已结束，允许下次 open 重建
        this.online = false;
        useUiStore.getState().setConnection("reconnecting");
        this.scheduleReconnect();
      });
  }

  /** 逐行解析 SSE 流直到流结束（结束 = 断线，throw 走重连路径）。帧解析按 WHATWG 规范：
   * 空行派发累积事件；event/data/id 字段；注释行（心跳 : ping）跳过；多行 data 以 \n 合并；
   * chunk 边界切断的行缓冲到齐为止。 */
  private async pumpSseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType = "message";
    let dataLines: string[] = [];
    let eventCursorRaw = "";
    let hasEvent = false;
    const flushEvent = () => {
      if (!hasEvent) return;
      const cursorRaw = eventCursorRaw;
      const parsed = Number(cursorRaw);
      const cursor = cursorRaw !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      dispatchSseEvent(eventType, dataLines.join("\n"), cursor);
      eventType = "message";
      dataLines = [];
      eventCursorRaw = "";
      hasEvent = false;
    };
    for (;;) {
      // 空闲检测：read 挂起超过 FETCH_IDLE_MS（服务端心跳 8s 应至少到一次）即断线重连
      const result = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("sse fetch idle timeout")), FETCH_IDLE_MS);
        reader.read().then(
          (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          (e) => {
            clearTimeout(timer);
            reject(e);
          },
        );
      });
      const { done, value } = result;
      if (done) {
        dlog("fetch stream-ended");
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          flushEvent();
          continue;
        }
        if (line.startsWith(":")) continue; // 心跳/注释行
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value2 = colon === -1 ? "" : line.slice(colon + 1);
        if (value2.startsWith(" ")) value2 = value2.slice(1);
        if (field === "event") {
          eventType = value2;
          hasEvent = true;
        } else if (field === "data") {
          dataLines.push(value2);
          hasEvent = true;
        } else if (field === "id") {
          eventCursorRaw = value2;
          hasEvent = true;
        }
        // retry 字段不支持（服务端未使用），忽略
      }
    }
    // 流结束：不足一行的残包按规范丢弃；结束本身视为断线
    throw new Error("sse fetch stream ended");
  }

  // ---------- 公共 ----------

  private scheduleReconnect(): void {
    if (this.stopped || this.cancelTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    dlog(`reconnect scheduled in ${delay}ms stickyFetch=${this.stickyFetch}`);
    this.cancelTimer = this.scheduleFn(() => {
      this.cancelTimer = null;
      this.open();
    }, delay);
  }

  private cancelScheduled(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private closeEs(): void {
    if (!this.es) return;
    this.es.onopen = null;
    this.es.onerror = null;
    this.es.close();
    this.es = null;
  }

  private abortFetch(): void {
    if (!this.abortController) return;
    this.abortController.abort();
    this.abortController = null;
  }

  private closeTransport(): void {
    this.online = false;
    this.closeEs();
    this.abortFetch();
  }

  private hookWake(): void {
    if (this.wakeHooked || typeof document === "undefined" || typeof window === "undefined") return;
    this.wakeHooked = true;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("pageshow", this.onPageShow);
  }

  private unhookWake(): void {
    if (!this.wakeHooked) return;
    this.wakeHooked = false;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("pageshow", this.onPageShow);
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") this.wake();
  };

  private onPageShow = (): void => {
    this.wake();
  };
}

// ---------- 页面级单例（整页全程仅 1 条连接） ----------

let client: EventsClient | null = null;

/** 连接 SSE（应用主布局挂载时调用）。重复调用先关旧连接再开新连接，任一时刻至多 1 条。 */
export function connectEvents(options?: EventsClientOptions): void {
  disconnectEvents();
  client = new EventsClient(options);
  client.start();
}

/** 关闭 SSE（主布局卸载/登出时调用） */
export function disconnectEvents(): void {
  client?.stop();
  client = null;
}
