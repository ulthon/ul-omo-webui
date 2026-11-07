// @ts-nocheck
// 引擎条件状态条（engine-ux-visibility 任务 4）：确定性渲染单测，计划验收「组件测试
// 三态 + 就绪消失；tsc」。
// 环境（composer-waiting-hint-dual-signal 惯例）：@happy-dom 全局注册 + renderToStaticMarkup
// 静态断言（misleading_success_output 防护：逐态断言文案原文与 data-state，就绪/未知
// 断言全无 engine-status-bar 节点——非「不抛错」）。
// 状态写入全部经 dispatchSseEvent 真实帧路径（stale_state 防护：engine_state 帧 / 引擎
// 直发帧存活推导 / 墓碑对账重取，不走改状态捷径）；快照引导经 api.listEngines mock。
// 断言语言锁 zh-CN（setup-locale preload）。
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

// api 整模块代理 mock（同 composer-waiting-hint-dual-signal 先例；listEngines 按用例覆写）
const apiFns = new Map();
vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (!apiFns.has(key)) apiFns.set(key, vi.fn(() => Promise.resolve({})));
        return apiFns.get(key);
      },
    },
  ),
  ApiError: class ApiError extends Error {},
  shortModelName: (m: string) => m,
}));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { EngineStatusBar } = await import("../engine-status-bar");
const { dispatchSseEvent, resetDispatchState } = await import("@/lib/event-dispatch");
const { useEnginesStore } = await import("@/stores/engines");
const { useSessionsStore } = await import("@/stores/sessions");
const { useMessagesStore } = await import("@/stores/messages");
const { api } = await import("@/lib/api");

const S1 = "/data/sess/s1.jsonl";
const S2 = "/data/sess/s2.jsonl";
const S3 = "/data/sess/s3.jsonl";

/** 会话行最小面（组件只读 id/path） */
function row(id: string, path: string) {
  return { id, path, project: "/p" };
}

let cursor = 0;
function nextCursor(): number {
  cursor += 1;
  return cursor;
}

/** engine_state 帧（信封 sessionPath = 引擎键；无 wire sessionId，走分发层引擎状态分流） */
function engineStateFrame(sessionPath: string, from: string, to: string): string {
  return JSON.stringify({ projectPath: "/p", sessionPath, event: { type: "engine_state", from, to } });
}

/** 引擎直发帧（wire sessionId = routing handle + 信封 sessionPath/durableSessionId） */
function engineFrame(sessionPath: string, durable: string): string {
  return JSON.stringify({
    projectPath: "/p",
    sessionPath,
    event: { type: "message_start", sessionId: "rpc-1" },
    durableSessionId: durable,
  });
}

/** 墓碑帧（项目级，无会话身份） */
function tombstoneFrame(): string {
  return JSON.stringify({ projectPath: "/p", event: { type: "engine_permissions_invalidated", projectPath: "/p" } });
}

function renderBar(sessionId: string): string {
  return renderToStaticMarkup(createElement(EngineStatusBar, { sessionId }));
}

/** 刷新异步链冲刷（mock 即时 resolve，一个宏任务拍即够） */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  cursor = 0;
  useSessionsStore.setState({
    byProject: { "/p": [row("d-1", S1), row("d-2", S2), row("d-3", S3)] },
    runStates: {},
    runStateAt: {},
    runStateSeq: {},
    lastFrameAt: {},
    waitingHintHidden: {},
    selectedId: "d-1",
    allMode: false,
  });
  useMessagesStore.setState({ bySession: {} });
  useEnginesStore.getState().resetEngines();
  api.listEngines.mockReset().mockResolvedValue({ engines: [] });
  resetDispatchState();
});

afterEach(() => {
  resetDispatchState();
  useEnginesStore.getState().resetEngines();
  useSessionsStore.setState({
    byProject: {},
    runStates: {},
    runStateAt: {},
    runStateSeq: {},
    lastFrameAt: {},
    waitingHintHidden: {},
  });
  useMessagesStore.setState({ bySession: {} });
});

describe("engine-ux-visibility 任务 4：输入框引擎条件状态条", () => {
  test("未同步（快照未到）：不渲染任何节点——冷页不凭空喊「引擎未启动」", () => {
    const html = renderBar("d-1");
    expect(html).not.toContain('data-testid="engine-status-bar"');
    expect(html).not.toContain("引擎未启动");
  });

  test("三态文案：engine_state 帧逐态渲染原文（stopped/starting/backoff）", () => {
    dispatchSseEvent("engine_state", engineStateFrame(S1, "ready", "stopped"), nextCursor());
    let html = renderBar("d-1");
    expect(html).toContain('data-testid="engine-status-bar"');
    expect(html).toContain('data-state="stopped"');
    expect(html).toContain("引擎未启动，发送消息将自动拉起");
    // 纯展示条：不携带任何按钮/禁用控件（永不阻塞输入的结构性保证）
    expect(html).not.toContain("<button");
    expect(html).not.toContain("disabled");

    dispatchSseEvent("engine_state", engineStateFrame(S1, "stopped", "starting"), nextCursor());
    html = renderBar("d-1");
    expect(html).toContain('data-state="starting"');
    expect(html).toContain("引擎启动中…");
    expect(html).not.toContain("引擎未启动");

    dispatchSseEvent("engine_state", engineStateFrame(S1, "starting", "backoff"), nextCursor());
    html = renderBar("d-1");
    expect(html).toContain('data-state="backoff"');
    expect(html).toContain("引擎启动失败，自动重试中…");
    expect(html).not.toContain("引擎启动中…");
  });

  test("就绪即消失：engine_state(to=ready) 帧后渲染为空；转换序列全程经真实帧路径", () => {
    dispatchSseEvent("engine_state", engineStateFrame(S1, "ready", "stopped"), nextCursor());
    expect(renderBar("d-1")).toContain("引擎未启动");
    dispatchSseEvent("engine_state", engineStateFrame(S1, "stopped", "starting"), nextCursor());
    expect(renderBar("d-1")).toContain("引擎启动中…");
    dispatchSseEvent("engine_state", engineStateFrame(S1, "starting", "backoff"), nextCursor());
    expect(renderBar("d-1")).toContain("自动重试中");
    dispatchSseEvent("engine_state", engineStateFrame(S1, "backoff", "ready"), nextCursor());
    const html = renderBar("d-1");
    expect(html).not.toContain('data-testid="engine-status-bar"');
    expect(html).not.toContain("引擎");
  });

  test("stopping/unavailable 不显示（unavailable 不再自动重试，展示重试文案即说谎）；非法 to 忽略", () => {
    dispatchSseEvent("engine_state", engineStateFrame(S1, "ready", "stopped"), nextCursor());
    dispatchSseEvent("engine_state", engineStateFrame(S1, "stopped", "stopping"), nextCursor());
    expect(renderBar("d-1")).not.toContain('data-testid="engine-status-bar"');
    dispatchSseEvent("engine_state", engineStateFrame(S1, "stopping", "unavailable"), nextCursor());
    expect(renderBar("d-1")).not.toContain('data-testid="engine-status-bar"');
    expect(renderBar("d-1")).not.toContain("自动重试中");
    // 非法 to：状态保持 unavailable（未误清、未误写，条仍不显示）
    dispatchSseEvent("engine_state", engineStateFrame(S1, "unavailable", "bogus"), nextCursor());
    expect(useEnginesStore.getState().states[S1]).toBe("unavailable");
    expect(renderBar("d-1")).not.toContain('data-testid="engine-status-bar"');
    // 非法 to 在可见态上同样不改变现状：stopped 保持 stopped 文案
    dispatchSseEvent("engine_state", engineStateFrame(S2, "ready", "stopped"), nextCursor());
    dispatchSseEvent("engine_state", engineStateFrame(S2, "stopped", "bogus"), nextCursor());
    expect(renderBar("d-2")).toContain("引擎未启动");
  });

  test("快照引导：GET /api/engines 一次——ready 隐藏 / backoff 显示 / 缺席（已同步）= 未启动", async () => {
    api.listEngines.mockResolvedValue({
      engines: [
        { projectPath: "/p", sessionPath: S1, state: "ready", restarts: 0, runningSessions: 1, lastActivityAt: 1 },
        { projectPath: "/p", sessionPath: S2, state: "backoff", restarts: 2, runningSessions: 0, lastActivityAt: 1 },
      ],
    });
    await useEnginesStore.getState().refresh();
    expect(useEnginesStore.getState().synced).toBe(true);

    expect(renderBar("d-1")).not.toContain('data-testid="engine-status-bar"'); // ready：缺席于可见集
    const html2 = renderBar("d-2");
    expect(html2).toContain('data-state="backoff"');
    expect(html2).toContain("引擎启动失败，自动重试中…");
    const html3 = renderBar("d-3");
    expect(html3).toContain('data-state="stopped"');
    expect(html3).toContain("引擎未启动，发送消息将自动拉起");
  });

  test("存活推导：引擎直发帧（信封 sessionPath）把 stopped 压回 ready，即刻隐去", () => {
    dispatchSseEvent("engine_state", engineStateFrame(S1, "ready", "stopped"), nextCursor());
    expect(renderBar("d-1")).toContain("引擎未启动");
    dispatchSseEvent("message_start", engineFrame(S1, "d-1"), nextCursor());
    const html = renderBar("d-1");
    expect(html).not.toContain('data-testid="engine-status-bar"');
    expect(useEnginesStore.getState().states[S1]).toBe("ready");
  });

  test("墓碑对账：ready 态收 engine_permissions_invalidated → 事件驱动重取快照 → 未启动条回归", async () => {
    api.listEngines.mockResolvedValueOnce({
      engines: [{ projectPath: "/p", sessionPath: S1, state: "ready", restarts: 0, runningSessions: 0, lastActivityAt: 1 }],
    });
    await useEnginesStore.getState().refresh();
    expect(renderBar("d-1")).not.toContain('data-testid="engine-status-bar"');

    // 墓碑后快照行缺席（引擎已回收/停止）＝ stopped
    api.listEngines.mockResolvedValueOnce({ engines: [] });
    dispatchSseEvent("engine_permissions_invalidated", tombstoneFrame(), nextCursor());
    await flushAsync();
    const html = renderBar("d-1");
    expect(html).toContain('data-state="stopped"');
    expect(html).toContain("引擎未启动，发送消息将自动拉起");
  });
});
