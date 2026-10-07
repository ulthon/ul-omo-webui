// SSE 客户端（计划 todo 14）：整页单条 EventSource 连接 /api/events（cookie 鉴权自动携带），
// 自动重连指数退避，事件经 lib/event-dispatch 按 sessionId 分发进 stores。
//
// 服务端契约（server/src/api/sse.ts）：event 行 = wire type；data 行 = {projectPath, event}；
// id 行 = 全局自增游标；游标越界先发 event: gap 再从最旧可用续发；15s 心跳注释行保活。
//
// 重连策略：原生 EventSource 自动重连虽带 Last-Event-ID，但节奏固定不可控（~3s），
// 这里 onerror 即 close，改由自持退避重建（1s/2s/4s…上限 30s，open 成功复位）。
// 重建的新连接不带 Last-Event-ID（浏览器只对同一 EventSource 的自动重连回传游标），
// 服务端按新客户端续发环形缓冲（+越界时 gap 帧）；分发层据 gap 帧与游标回退做活动
// 会话全量重取兜底——覆盖断网期间丢帧与服务端重启游标归零两种场景。
import { dispatchSseEvent } from "@/lib/event-dispatch";
import { useUiStore } from "@/stores/ui";

/** 客户端监听的 SSE event: 类型集合。服务端 wire type 是开放集，未列出的类型浏览器
 * 不派发（等效"未知事件容错忽略"语义）；todo 15/16/17 需消费新类型时在此追加。 */
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
];

/** CONNECTING 停留超过该时长视为僵死，回前台时强制重建 */
const CONNECTING_STALE_MS = 5000;

export interface EventsClientOptions {
  /** SSE 端点（默认 /api/events） */
  url?: string;
  /** 首次重连退避毫秒（默认 1000） */
  baseBackoffMs?: number;
  /** 退避上限毫秒（默认 30000） */
  maxBackoffMs?: number;
  /** EventSource 工厂（单测注入 mock 用） */
  createEventSource?: (url: string) => EventSource;
  /** 延时调度（单测驱动退避序列用）；返回取消函数 */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export class EventsClient {
  private readonly url: string;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly createEs: (url: string) => EventSource;
  private readonly scheduleFn: (fn: () => void, ms: number) => () => void;

  private es: EventSource | null = null;
  private stopped = true;
  /** 下一次重连的退避时长；open 成功后复位 */
  private backoffMs: number;
  private cancelTimer: (() => void) | null = null;
  private wakeHooked = false;
  private openedAt = 0;

  constructor(options: EventsClientOptions = {}) {
    this.url = options.url ?? "/api/events";
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.createEs = options.createEventSource ?? ((url) => new EventSource(url));
    this.scheduleFn = options.schedule ?? defaultSchedule;
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
    this.closeEs();
    this.unhookWake();
  }

  /** 页面回前台唤醒（visibilitychange/pageshow 调用；公开便于单测）：
   * 连接不健康——已死、退避等待中、或 CONNECTING 僵死——则取消退避计时立即重建。 */
  wake(): void {
    if (this.stopped) return;
    if (this.es !== null && this.es.readyState === EventSource.OPEN) return;
    const connectingStale = this.es !== null && Date.now() - this.openedAt > CONNECTING_STALE_MS;
    if (this.es !== null && this.es.readyState === EventSource.CONNECTING && !connectingStale) return;
    this.cancelScheduled();
    this.closeEs();
    this.backoffMs = this.baseBackoffMs;
    this.open();
  }

  private open(): void {
    if (this.stopped || this.es) return;
    this.openedAt = Date.now();
    const es = this.createEs(this.url);
    this.es = es;
    es.onopen = () => {
      this.backoffMs = this.baseBackoffMs; // 恢复在线复位退避
      useUiStore.getState().setConnection("online");
    };
    es.onerror = () => {
      useUiStore.getState().setConnection("reconnecting");
      this.closeEs();
      this.scheduleReconnect();
    };
    for (const type of HANDLED_EVENT_TYPES) {
      es.addEventListener(type, (ev) => this.onFrame(ev as MessageEvent));
    }
  }

  private onFrame(ev: MessageEvent): void {
    const raw = ev.lastEventId;
    const parsed = Number(raw);
    const cursor = raw !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    dispatchSseEvent(ev.type, ev.data, cursor);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.cancelTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
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
