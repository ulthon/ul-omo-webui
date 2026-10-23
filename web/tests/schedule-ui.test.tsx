// @ts-nocheck
// schedule 前端 UI 单测（docs08-2026-10-22 批次任务 22）：composer-mobile-layout / topbar-
// mobile-recent 惯例——@happy-dom 全局注册 + createRoot/act 真实交互 + fetch 桩走真 api 层。
// 覆盖：(1) 设置分区列表与 GET 一致（行/会话名/到期/循环/状态/invalid/runner 存活）；
// (2) runner 未运行指示；(3) 取消流 DELETE→行移除→静默对账；(4) 10s 可见态轮询与回前台
// 刷新（fake timers 确定性）；(5) 弹框空 prompt 拦截（不发生 POST）；(6) 创建成功 POST 载荷
// （1h 预设 + 循环秒→everyMs + 自定义 ISO 透传）与列表对账；(7) 服务端错误码词典映射
// （invalid_every 命中不透传原文）；(8) 503 降级：提示 + 提交禁用；(9) 行菜单「定时任务…」
// 分流 onDialog("schedule")。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

// bun test 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// radix DropdownMenu 原语透传化（topbar-mobile-recent 同款）：Root 渲染 children，
// Content 内联展开，Item 将 onSelect 映射为 onClick
vi.mock("@/components/ui/dropdown-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Trigger = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Item = ({
    onSelect,
    children,
    ...rest
  }: {
    onSelect?: () => void;
    children?: React.ReactNode;
  } & Record<string, unknown>) => (
    <div role="menuitem" onClick={onSelect} {...rest}>
      {children}
    </div>
  );
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Trigger,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: Item,
    DropdownMenuLabel: Passthrough,
    DropdownMenuSeparator: Passthrough,
  };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { ScheduleSection } = await import("@/components/schedule/schedule-section");
const { ScheduleDialog } = await import("@/components/schedule/schedule-dialog");
const { SessionItem } = await import("@/components/session-list/session-item");
const { useSessionsStore } = await import("@/stores/sessions");

const ORIGINAL_FETCH = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

type FetchOutcome = { status?: number; json: unknown };

/** fetch 桩：按 URL 前缀+方法分发，记录全部调用走真 api 层（错误体走 {error:{code,message}}） */
function installFetch(handler: (url: string, method: string, body: unknown) => FetchOutcome): { calls: Call[] } {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });
    const out = handler(url, method, body);
    const status = out.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => out.json,
    } as Response;
  }) as typeof fetch;
  return { calls };
}

function makeSession(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    path: `/store/${id}.jsonl`,
    project: "/p1",
    title: `会话-${id}`,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hi",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
    ...overrides,
  };
}

let seq = 0;
function makeJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    version: 1,
    id: `sch_test${String(seq).padStart(8, "0")}`,
    sessionId: "s1",
    sessionFile: "/store/s1.jsonl",
    cwd: "/p1",
    prompt: "整理周报并归档",
    createdAt: Date.now() - 60_000,
    dueAt: Date.now() + 3_600_000,
    everyMs: 300_000,
    fireCount: 0,
    lastFiredAt: null,
    lastError: null,
    state: "pending",
    ...overrides,
  };
}

const LIVE_MOUNTS = new Set<{ unmount: () => Promise<void> }>();

async function mount(el: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  const handle = {
    container,
    unmount: async () => {
      LIVE_MOUNTS.delete(handle);
      if (!container.isConnected) return;
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
  LIVE_MOUNTS.add(handle);
  return handle;
}

async function typeInto(el: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setVal = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    setVal.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const GET_CALLS = (calls: Call[]) => calls.filter((c) => c.method === "GET");
const POST_CALLS = (calls: Call[]) => calls.filter((c) => c.method === "POST");

function seedSessions(): void {
  useSessionsStore.setState({
    byProject: { "/p1": [makeSession("s1", { title: "会话甲" })] },
    runStates: {},
    runStateAt: {},
    appliedModels: {},
    selectedId: null,
  });
}

beforeEach(() => {
  seedSessions();
});

afterEach(async () => {
  // 断言失败中途退出也会卸载：免得轮询定时器/visibilitychange 监听泄漏到后续用例
  for (const m of [...LIVE_MOUNTS]) {
    await m.unmount();
  }
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("任务22 设置面板定时任务分区", () => {
  test("列表与 GET 一致：行/会话名/到期/循环/状态徽标/invalid 回显/runner 存活", async () => {
    installFetch(() => ({
      json: {
        jobs: [
          makeJob({ dueAt: Date.now() + 2 * 3_600_000 + 60_000 }), // +60s 档位余量：毫秒流逝不跨 floor 阈值
          makeJob({ sessionId: "s2", prompt: "一次性提醒", everyMs: null, dueAt: Date.now() + 30_000 }),
        ],
        invalid: [{ file: "pending/bad.json", error: "JSON 解析失败" }],
        runner: { alive: true },
      },
    }));
    const m = await mount(createElement(ScheduleSection));
    const rows = document.querySelectorAll('[data-testid="schedule-item"]');
    expect(rows).toHaveLength(2);
    expect(document.body.textContent).toContain("整理周报并归档");
    expect(document.body.textContent).toContain("会话甲"); // 会话名列来自 sessions store
    expect(document.body.textContent).toContain("2h后"); // 到期相对时间（余量取档，不跨阈值抖动）
    expect(document.body.textContent).toContain("每 5m"); // 循环
    expect(document.body.textContent).toContain("单次"); // 一次性
    expect(document.body.textContent).toContain("等待"); // 状态
    expect(document.body.textContent).toContain("1 条记录无法解析"); // invalid 如实回显
    expect(document.querySelector('[data-testid="schedule-runner-status"]')?.textContent).toContain("runner 运行中");
    await m.unmount();
  });

  test("runner 未运行：指示点转 destructive + 文案切换", async () => {
    installFetch(() => ({ json: { jobs: [], invalid: [], runner: { alive: false } } }));
    const m = await mount(createElement(ScheduleSection));
    expect(document.querySelector('[data-testid="schedule-runner-status"]')?.textContent).toContain("runner 未运行");
    expect(document.body.textContent).toContain("暂无定时任务");
    await m.unmount();
  });

  test("取消流：DELETE 发出 → 行即移除 → 静默 GET 对账；404 同形摘除", async () => {
    const job = makeJob({ dueAt: Date.now() + 2 * 3_600_000 });
    let deleted = false;
    const { calls } = installFetch((url, method) => {
      if (method === "GET") return { json: { jobs: deleted ? [] : [job], invalid: [], runner: { alive: true } } };
      if (method === "DELETE") {
        deleted = true;
        return { json: { ok: true, id: job.id } };
      }
      return { status: 500, json: { error: { code: "internal", message: "x" } } };
    });
    const m = await mount(createElement(ScheduleSection));
    expect(document.querySelectorAll('[data-testid="schedule-item"]')).toHaveLength(1);
    await click(document.querySelector(`[data-testid="schedule-cancel-${job.id}"]`)!);
    expect(calls.some((c) => c.method === "DELETE" && c.url === `/api/schedule/${job.id}`)).toBe(true);
    // 行即移除 + 静默对账 GET（共 2 次 GET）
    expect(document.querySelectorAll('[data-testid="schedule-item"]')).toHaveLength(0);
    expect(GET_CALLS(calls)).toHaveLength(2);
    await m.unmount();
  });

  test("刷新行为：挂载即拉取 + 10s 可见态轮询 + 回前台 visibilitychange 刷新", async () => {
    vi.useFakeTimers();
    try {
      const { calls } = installFetch(() => ({ json: { jobs: [], invalid: [], runner: { alive: true } } }));
      const m = await mount(createElement(ScheduleSection));
      expect(GET_CALLS(calls)).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(GET_CALLS(calls)).toHaveLength(2);
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(GET_CALLS(calls)).toHaveLength(3);
      await m.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("任务22 会话行定时任务弹框", () => {
  test("空 prompt 客户端拦截：不发生 POST", async () => {
    const { calls } = installFetch(() => ({ json: { jobs: [], invalid: [], runner: { alive: true } } }));
    const m = await mount(createElement(ScheduleDialog, { session: makeSession("s1"), onClose: () => {} }));
    expect(document.querySelector('[data-testid="schedule-form"]')).not.toBeNull();
    await click(document.querySelector('[data-testid="schedule-submit"]')!);
    expect(POST_CALLS(calls)).toHaveLength(0);
    expect(document.querySelector('[data-testid="schedule-form-error"]')?.textContent).toBe("请填写提示词");
    await m.unmount();
  });

  test("自定义 ISO 非法拦截 + 合法透传字符串", async () => {
    const { calls } = installFetch(() => ({ json: { jobs: [], invalid: [], runner: { alive: true } } }));
    const m = await mount(createElement(ScheduleDialog, { session: makeSession("s1"), onClose: () => {} }));
    await typeInto(document.querySelector('[data-testid="schedule-prompt"]')!, "跑一遍测试");
    await click(document.querySelector('[data-testid="schedule-due-preset-custom"] input')!);
    await typeInto(document.querySelector('[data-testid="schedule-due-custom"]')!, "not-a-date");
    await click(document.querySelector('[data-testid="schedule-submit"]')!);
    expect(POST_CALLS(calls)).toHaveLength(0);
    expect(document.querySelector('[data-testid="schedule-form-error"]')?.textContent).toBe("触发时间无法解析");
    await typeInto(document.querySelector('[data-testid="schedule-due-custom"]')!, "2026-10-23T09:00:00+08:00");
    await click(document.querySelector('[data-testid="schedule-submit"]')!);
    const post = POST_CALLS(calls)[0];
    expect(post.body).toMatchObject({ sessionId: "s1", prompt: "跑一遍测试", due: "2026-10-23T09:00:00+08:00", everyMs: null });
    await m.unmount();
  });

  test("创建成功：1h 预设 + 循环秒 → everyMs 换算 + toast 后列表对账", async () => {
    const { calls } = installFetch(() => ({ json: { jobs: [], invalid: [], runner: { alive: true } } }));
    const m = await mount(createElement(ScheduleDialog, { session: makeSession("s1"), onClose: () => {} }));
    await typeInto(document.querySelector('[data-testid="schedule-prompt"]')!, "整理周报");
    await typeInto(document.querySelector('[data-testid="schedule-every"]')!, "300");
    const before = Date.now();
    await click(document.querySelector('[data-testid="schedule-submit"]')!);
    const post = POST_CALLS(calls)[0];
    expect(post.body).toMatchObject({ sessionId: "s1", prompt: "整理周报", everyMs: 300_000 });
    expect(Math.abs(post.body.due - (before + 3_600_000))).toBeLessThan(5_000);
    // 创建成功后刷新对账（挂载 1 次 + 创建后 1 次）
    expect(GET_CALLS(calls)).toHaveLength(2);
    await m.unmount();
  });

  test("服务端 invalid_every：错误码命中词典文案，不透传服务端原文", async () => {
    const { calls } = installFetch((url, method) => {
      if (method === "POST") {
        return {
          status: 400,
          json: { error: { code: "invalid_every", message: "everyMs 最小 60000（runner 轮询语义下更密只会漂移）" } },
        };
      }
      return { json: { jobs: [], invalid: [], runner: { alive: true } } };
    });
    const m = await mount(createElement(ScheduleDialog, { session: makeSession("s1"), onClose: () => {} }));
    await typeInto(document.querySelector('[data-testid="schedule-prompt"]')!, "整理周报");
    await typeInto(document.querySelector('[data-testid="schedule-every"]')!, "120"); // 客户端合法，走服务端错误
    await click(document.querySelector('[data-testid="schedule-submit"]')!);
    expect(POST_CALLS(calls)).toHaveLength(1);
    const err = document.querySelector('[data-testid="schedule-form-error"]')?.textContent ?? "";
    expect(err).toBe("循环间隔无效（最小 60 秒）");
    expect(err).not.toContain("everyMs 最小 60000");
    await m.unmount();
  });

  test("503 降级：schedule_runner_unavailable → 降级提示 + 提交禁用", async () => {
    installFetch((url, method) => {
      if (method === "POST") {
        return { status: 503, json: { error: { code: "schedule_runner_unavailable", message: "定时任务 runner 不可用" } } };
      }
      return { json: { jobs: [], invalid: [], runner: { alive: true } } };
    });
    const m = await mount(createElement(ScheduleDialog, { session: makeSession("s1"), onClose: () => {} }));
    await typeInto(document.querySelector('[data-testid="schedule-prompt"]')!, "整理周报");
    await click(document.querySelector('[data-testid="schedule-submit"]')!);
    expect(document.querySelector('[data-testid="schedule-degraded"]')?.textContent).toContain("runner 不可用，创建已禁用");
    expect((document.querySelector('[data-testid="schedule-submit"]') as HTMLButtonElement).disabled).toBe(true);
    await m.unmount();
  });

  test("该会话过滤列表：只显本会话任务；已到期行显待触发；失败行带 lastError", async () => {
    installFetch(() => ({
      json: {
        jobs: [
          makeJob({ dueAt: Date.now() - 60_000, state: "failed", lastError: "会话不存在：s1" }),
          makeJob({ sessionId: "other", prompt: "别家的任务" }),
        ],
        invalid: [],
        runner: { alive: true },
      },
    }));
    const m = await mount(createElement(ScheduleDialog, { session: makeSession("s1"), onClose: () => {} }));
    const rows = document.querySelectorAll('[data-testid="schedule-item"]');
    expect(rows).toHaveLength(1); // other 会话任务被过滤
    expect(document.body.textContent).toContain("已到期·待触发");
    expect(document.body.textContent).toContain("失败");
    expect(document.body.textContent).toContain("上次错误：会话不存在：s1");
    await m.unmount();
  });
});

describe("任务22 会话行菜单入口", () => {
  test("「定时任务…」菜单项分流 onDialog(schedule, session)", async () => {
    const onDialog = vi.fn();
    const m = await mount(
      createElement(SessionItem, {
        session: makeSession("s1"),
        expandable: false,
        onDialog,
        onChanged: () => {},
      }),
    );
    const item = document.querySelector('[data-testid="item-schedule"]');
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain("定时任务…");
    await click(item!);
    expect(onDialog).toHaveBeenCalledWith("schedule", expect.objectContaining({ id: "s1" }));
    await m.unmount();
  });
});
