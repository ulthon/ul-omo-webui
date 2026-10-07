// 单测共享 mock 基建（bun test 运行；位于 tsconfig include 之外，不参与 tsc 构建）

export interface MockMessageEvent {
  type: string;
  data: string;
  lastEventId: string;
}

type FrameListener = (ev: MockMessageEvent) => void;

/** 可控行为的 EventSource 替身：测试代码用 emitOpen/emitError/emit 驱动回调 */
export class MockEventSource {
  static instances: MockEventSource[] = [];

  static reset(): void {
    MockEventSource.instances = [];
  }

  static get live(): MockEventSource[] {
    return MockEventSource.instances.filter((es) => !es.closed);
  }

  readonly url: string;
  /** 0=CONNECTING 1=OPEN 2=CLOSED（对齐 EventSource 常量） */
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, FrameListener[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: FrameListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  // ---- 测试驱动 ----

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emitError(): void {
    this.onerror?.();
  }

  /** 派发一帧（data 自动 JSON 序列化；cursor 缺省时 lastEventId 为空串） */
  emit(type: string, data: unknown, cursor?: number): void {
    const ev: MockMessageEvent = {
      type,
      data: JSON.stringify(data),
      lastEventId: cursor === undefined ? "" : String(cursor),
    };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
}

/** 可控延时调度：记录 (fn, ms)，flush 手动触发，用于断言退避序列 */
export class MockScheduler {
  entries: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  /** 累计注册过的全部延时（flush 不清，供断言退避序列） */
  history: number[] = [];

  schedule = (fn: () => void, ms: number): (() => void) => {
    const entry = { fn, ms, cancelled: false };
    this.entries.push(entry);
    this.history.push(ms);
    return () => {
      entry.cancelled = true;
    };
  };

  /** 触发全部未取消任务（一次性，按注册顺序） */
  flush(): void {
    const run = this.entries;
    this.entries = [];
    for (const entry of run) {
      if (!entry.cancelled) entry.fn();
    }
  }

  delays(): number[] {
    return this.history;
  }

  pendingCount(): number {
    return this.entries.filter((e) => !e.cancelled).length;
  }
}
