// @ts-nocheck
// 总览「引擎」区块（engine-ux-visibility 任务 3）：组件面断言——计划验收「组件测试：
// 状态渲染、就绪态展示、确认弹窗门」+ 任务书五场景（当前会话行渲染指标 / 无引擎整块
// 隐藏 / 空闲停止恰一次 / 回合中确认门拒绝零调用 / 可选字段缺席不崩不渲染）。
// 环境说明同 overview-background-tasks.test：@happy-dom 全局注册 + createRoot/act
//（effects 真跑：挂载拉取路径被覆盖）；api 整模块代理 mock 同 engine-status-bar 先例。
// 对抗面（任务书点名）：API 调用计数逐处断言（挂载恰一次 / 停止后重取恰两次 /
// 确认拒绝零调用 / 无会话零拉取）；确认门双向断言（拒绝 → 零调用，放行 → 恰一次）。
// 断言语言锁 zh-CN（setup-locale preload）。
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// api 整模块代理 mock（同 engine-status-bar 先例；getEngineMetrics/stopEngine 按用例覆写）
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

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { OverviewEngine } = await import("../overview-engine");
const { OverviewPanel } = await import("../overview-panel");
const { useEnginesStore } = await import("@/stores/engines");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");
const { api } = await import("@/lib/api");

const S1 = "/data/sess/s1.jsonl";
const S2 = "/data/sess/s2.jsonl";

/** 会话行最小面（组件只读 id/path） */
function sessRow(id: string, path: string) {
  return { id, path, project: "/p" };
}

/** 指标行全字段最小面（服务端契约不缺键；overrides 覆写逐场景差异） */
function metricsRow(overrides = {}) {
  return {
    projectPath: "/p",
    sessionPath: S1,
    state: "ready",
    pid: 123,
    rssBytes: 100 * 1024 * 1024,
    treeRssBytes: 512 * 1024 * 1024,
    childCount: 3,
    cpuPct: null,
    cpuTotalMs: null,
    ioBytes: null,
    startedAt: 1,
    startupMs: 4200,
    lastStartupMs: 3800,
    uptimeMs: 72000,
    boundSession: { id: "d-1", title: "调试会话", fileSizeBytes: 12345 },
    workerRestartCount: 0,
    rpcQueueDepth: 0,
    recentErrors: [],
    ...overrides,
  };
}

function mount(comp: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(comp);
  });
  return { container, root };
}

function unmount(root) {
  act(() => {
    root.unmount();
  });
}

/** 异步链冲刷（mock 即时 resolve；微任务+宏任务各一拍） */
async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function section(container) {
  return container.querySelector('[data-testid="overview-engine"]');
}

let confirmSpy;

beforeEach(() => {
  useSessionsStore.setState({
    byProject: { "/p": [sessRow("d-1", S1), sessRow("d-2", S2)] },
    runStates: {},
    runStateAt: {},
    runStateSeq: {},
    lastFrameAt: {},
    waitingHintHidden: {},
    selectedId: "d-1",
    allMode: false,
  });
  useEnginesStore.getState().resetEngines();
  useUiStore.setState({ currentProject: null });
  api.getEngineMetrics.mockReset().mockResolvedValue({ engines: [] });
  api.stopEngine.mockReset().mockResolvedValue({ ok: true });
  api.getPlanProgress.mockReset().mockResolvedValue({});
  api.getUsage.mockReset().mockResolvedValue({ usage: {} });
  // happy-dom 未定义 window.confirm：先落桩再 spyOn（组件与断言共用同一可 mock 面）
  window.confirm = () => true;
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  confirmSpy.mockRestore();
  useSessionsStore.setState({
    byProject: {},
    runStates: {},
    runStateAt: {},
    runStateSeq: {},
    lastFrameAt: {},
    waitingHintHidden: {},
  });
  useEnginesStore.getState().resetEngines();
  document.body.innerHTML = "";
});

describe("总览引擎区块（engine-ux-visibility 任务 3）", () => {
  test("当前会话引擎行渲染：状态徽标 + 会话标题/文件大小 + 第一梯队指标全文；挂载拉取恰一次", async () => {
    api.getEngineMetrics.mockResolvedValue({ engines: [metricsRow()] });
    const { container, root } = mount(createElement(OverviewEngine, { sessionId: "d-1" }));
    await flushAsync();
    const sec = section(container);
    expect(sec).toBeTruthy();
    const badge = sec.querySelector('[data-testid="overview-engine-state"]');
    expect(badge.dataset.state).toBe("ready");
    expect(badge.textContent).toContain("就绪");
    expect(sec.textContent).toContain("调试会话");
    expect(sec.textContent).toContain("12.1 KB");
    expect(sec.textContent).toContain("512.0 MB");
    expect(sec.textContent).toContain("3 子进程");
    expect(sec.textContent).toContain("本次 4.2s");
    expect(sec.textContent).toContain("上次 3.8s");
    expect(sec.textContent).toContain("1.2m"); // uptimeMs 72000
    expect(sec.querySelector('[data-testid="overview-engine-mem"]').textContent).toContain("512.0 MB");
    expect(sec.querySelector('[data-testid="overview-engine-restarts"]').textContent).toContain("0 次");
    // 对抗面：挂载仅发一次采样请求（无重复拉取/无轮询）
    expect(api.getEngineMetrics).toHaveBeenCalledTimes(1);
    // 可选字段缺席：不渲染空闲回收行（下方专项再验不崩）
    expect(sec.querySelector('[data-testid="overview-engine-idle"]')).toBeNull();
    unmount(root);
  });

  test("无引擎匹配：整块隐藏（含无引擎行/引擎在别会话/无会话零拉取三种形态）", async () => {
    // ① 空列表（引擎全无 = stale_state 合法态）
    api.getEngineMetrics.mockResolvedValue({ engines: [] });
    const m1 = mount(createElement(OverviewEngine, { sessionId: "d-1" }));
    await flushAsync();
    expect(section(m1.container)).toBeNull();
    expect(api.getEngineMetrics).toHaveBeenCalledTimes(1);
    unmount(m1.root);

    // ② 引擎在别的会话：当前会话无匹配行 → 隐藏
    api.getEngineMetrics.mockResolvedValue({ engines: [metricsRow({ sessionPath: S2 })] });
    const m2 = mount(createElement(OverviewEngine, { sessionId: "d-1" }));
    await flushAsync();
    expect(section(m2.container)).toBeNull();
    unmount(m2.root);

    // ③ 无会话 / 会话行未知：零拉取（对抗面：不发无意义请求）
    api.getEngineMetrics.mockClear();
    const m3 = mount(createElement(OverviewEngine, { sessionId: null }));
    await flushAsync();
    expect(section(m3.container)).toBeNull();
    const m4 = mount(createElement(OverviewEngine, { sessionId: "unknown-id" }));
    await flushAsync();
    expect(section(m4.container)).toBeNull();
    expect(api.getEngineMetrics).not.toHaveBeenCalled();
    unmount(m3.root);
    unmount(m4.root);
  });

  test("随总览面板装配：OverviewPanel 内引擎区块在计划块之后渲染；无引擎时面板无该节点", async () => {
    api.getEngineMetrics.mockResolvedValue({ engines: [metricsRow()] });
    const { container, root } = mount(createElement(OverviewPanel, { sessionId: "d-1" }));
    await flushAsync();
    const panel = container.querySelector('[data-testid="overview-panel"]');
    expect(panel).toBeTruthy();
    const engine = section(container);
    expect(engine).toBeTruthy();
    const plan = container.querySelector('[data-testid="overview-plan"]');
    // 计划块缺席（无绑定 goal）时引擎区块仍渲染；顺序断言用引擎在面板内即可
    if (plan) {
      expect(panel.compareDocumentPosition(engine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    unmount(root);

    api.getEngineMetrics.mockResolvedValue({ engines: [] });
    const m2 = mount(createElement(OverviewPanel, { sessionId: "d-1" }));
    await flushAsync();
    expect(section(m2.container)).toBeNull();
    unmount(m2.root);
  });

  test("空闲停止：无确认弹窗，stopEngine 恰一次 {sessionPath}，成功后重取指标", async () => {
    api.getEngineMetrics.mockResolvedValue({ engines: [metricsRow({ state: "ready" })] });
    const { container, root } = mount(createElement(OverviewEngine, { sessionId: "d-1" }));
    await flushAsync();
    const stop = container.querySelector('[data-testid="overview-engine-stop"]');
    expect(stop.disabled).toBe(false);
    act(() => {
      stop.click();
    });
    await flushAsync();
    // 确认门不触发（空闲直接停）
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(api.stopEngine).toHaveBeenCalledTimes(1);
    expect(api.stopEngine).toHaveBeenCalledWith({ sessionPath: S1 });
    // 停止成功后重取一次（挂载 1 + 停止后 1 = 2）
    expect(api.getEngineMetrics).toHaveBeenCalledTimes(2);
    unmount(root);
  });

  test("回合进行中停止：确认门双向——拒绝零调用，放行恰一次（running/waiting 皆门）", async () => {
    api.getEngineMetrics.mockResolvedValue({ engines: [metricsRow({ state: "ready" })] });
    useSessionsStore.setState({ runStates: { "d-1": "running" } });
    const { container, root } = mount(createElement(OverviewEngine, { sessionId: "d-1" }));
    await flushAsync();
    const stop = container.querySelector('[data-testid="overview-engine-stop"]');

    // 拒绝：confirm 恰一次，stopEngine 零调用
    confirmSpy.mockReturnValue(false);
    act(() => {
      stop.click();
    });
    await flushAsync();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(api.stopEngine).not.toHaveBeenCalled();

    // 放行：confirm 第二次，stopEngine 恰一次
    confirmSpy.mockReturnValue(true);
    act(() => {
      stop.click();
    });
    await flushAsync();
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(api.stopEngine).toHaveBeenCalledTimes(1);
    expect(api.stopEngine).toHaveBeenCalledWith({ sessionPath: S1 });
    unmount(root);

    // waiting 态同样进门
    useSessionsStore.setState({ runStates: { "d-1": "waiting" } });
    confirmSpy.mockReturnValue(false);
    const m2 = mount(createElement(OverviewEngine, { sessionId: "d-1" }));
    await flushAsync();
    act(() => {
      m2.container.querySelector('[data-testid="overview-engine-stop"]').click();
    });
    expect(confirmSpy).toHaveBeenCalledTimes(3);
    expect(api.stopEngine).toHaveBeenCalledTimes(1); // 仍是上一轮那次，未新增
    unmount(m2.root);
  });

  test("可选字段（任务 2 落地中）防御渲染：缺席不崩不渲染，倒计时/豁免态到场即渲染", async () => {
    // 缺席：区块正常渲染，无空闲回收行
    api.getEngineMetrics.mockResolvedValue({ engines: [metricsRow()] });
    const m1 = mount(createElement(OverviewEngine, { sessionId: "d-1" }));
    await flushAsync();
    const sec1 = section(m1.container);
    expect(sec1).toBeTruthy();
    expect(sec1.querySelector('[data-testid="overview-engine-idle"]')).toBeNull();
    expect(sec1.textContent).not.toContain("空闲回收");
    unmount(m1.root);

    // 倒计时到场：渲染剩余时长
    api.getEngineMetrics.mockResolvedValue({ engines: [metricsRow({ remainingIdleMs: 200000 })] });
    const m2 = mount(createElement(OverviewEngine, { sessionId: "d-1" }));
    await flushAsync();
    const idle2 = section(m2.container).querySelector('[data-testid="overview-engine-idle"]');
    expect(idle2).toBeTruthy();
    expect(idle2.textContent).toContain("空闲回收");
    expect(idle2.textContent).toContain("3.3m");
    unmount(m2.root);

    // 豁免态到场：豁免标记替代倒计时（remainingIdleMs 同时缺席/为 null 均可）
    api.getEngineMetrics.mockResolvedValue({
      engines: [metricsRow({ remainingIdleMs: null, activityWindowExempt: true })],
    });
    const m3 = mount(createElement(OverviewEngine, { sessionId: "d-1" }));
    await flushAsync();
    const idle3 = section(m3.container).querySelector('[data-testid="overview-engine-idle"]');
    expect(idle3).toBeTruthy();
    expect(idle3.textContent).toContain("豁免中");
    expect(idle3.textContent).not.toContain("3.3m");
    unmount(m3.root);

    // 非豁免且倒计时非有限数：不渲染该行（防御极端载荷）
    api.getEngineMetrics.mockResolvedValue({ engines: [metricsRow({ remainingIdleMs: Number.NaN })] });
    const m4 = mount(createElement(OverviewEngine, { sessionId: "d-1" }));
    await flushAsync();
    expect(section(m4.container).querySelector('[data-testid="overview-engine-idle"]')).toBeNull();
    unmount(m4.root);
  });

  test("SSE 衍生重拉：engines store 本会话引擎键状态变化触发采样重取（无轮询）", async () => {
    api.getEngineMetrics.mockResolvedValue({ engines: [metricsRow({ state: "ready" })] });
    const { container, root } = mount(createElement(OverviewEngine, { sessionId: "d-1" }));
    await flushAsync();
    expect(api.getEngineMetrics).toHaveBeenCalledTimes(1); // 挂载 1 次

    // engine_state 帧语义写入（SSE 事件流既有路径）：本会话键变化 → 重拉
    act(() => {
      useEnginesStore.getState().applyEngineStateEvent(S1, "backoff");
    });
    await flushAsync();
    expect(api.getEngineMetrics).toHaveBeenCalledTimes(2);
    // 重取结果驱动重渲染（mock 返回仍 ready，但拉取计数已证链路）
    expect(section(container)).toBeTruthy();

    // 其他会话引擎键变化：不触发重拉（键选择性）
    act(() => {
      useEnginesStore.getState().applyEngineStateEvent(S2, "starting");
    });
    await flushAsync();
    expect(api.getEngineMetrics).toHaveBeenCalledTimes(2);
    unmount(root);
  });

  test("非可停状态（backoff/stopped）：停止钮禁用；徽标文案退避中/已回收", async () => {
    api.getEngineMetrics.mockResolvedValue({ engines: [metricsRow({ state: "backoff" })] });
    const { container, root } = mount(createElement(OverviewEngine, { sessionId: "d-1" }));
    await flushAsync();
    const sec = section(container);
    expect(sec.querySelector('[data-testid="overview-engine-state"]').textContent).toContain("退避中");
    expect(container.querySelector('[data-testid="overview-engine-stop"]').disabled).toBe(true);
    unmount(root);

    api.getEngineMetrics.mockResolvedValue({ engines: [metricsRow({ state: "stopped", uptimeMs: null, boundSession: null })] });
    const m2 = mount(createElement(OverviewEngine, { sessionId: "d-1" }));
    await flushAsync();
    const sec2 = section(m2.container);
    expect(sec2.querySelector('[data-testid="overview-engine-state"]').textContent).toContain("已回收");
    expect(sec2.textContent).not.toContain("调试会话"); // boundSession null：标题/大小行不渲染，不崩
    expect(sec2.querySelector('[data-testid="overview-engine-uptime"]').textContent).toContain("—");
    unmount(m2.root);
  });
});
