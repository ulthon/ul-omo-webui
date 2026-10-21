// 子代理页签测试（docs08-r6 任务 17）：右栏页签接入 / 空态 / 历史终态聚合卡（entries 路径）/
// 运行中实时态（tool_execution_update LIVE 帧）/ 运行中→终态转换（state_machine_stuck 对抗）/
// 零中间帧降级（live_only_degradation 对抗）/ store partialResult 接线 / EventsClient 具名帧
// 真实路径（HANDLED_EVENT_TYPES 白名单证明，任务 16 守卫的运行时侧证）/ [task_id] 尾注剥离。
// 载荷全部取任务 4 spike 实测形态（.omo/evidence/docs08-r6/task-4-spike.md §三原帧样本）。
// 渲染走真实组件（happy-dom + createRoot，memory-panel-telemetry 同款）；store 直驱
// （applyWireEvent / setState），无网络无时间依赖。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// 单进程跑多文件：其他测试文件可能已注册，双注册会抛错
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
type ReactNode = import("react").ReactNode;
const { RightRail } = await import("@/components/layout/right-rail");
const { SubagentPanel } = await import("@/components/chat/subagent-panel");
const { collectSubagentCalls, stripTaskIdTail } = await import("@/components/chat/subagent-data");
const { useMessagesStore } = await import("@/stores/messages");
const { EventsClient, disconnectEvents } = await import("@/lib/events");
const { resetDispatchState } = await import("@/lib/event-dispatch");
const { MockEventSource, MockScheduler } = await import("./helpers/mock-sse");

const S = "s-sub";

/** 会话槽空白形态（emptySessionMessages 同构，queue-dispatch 同款直驱） */
function emptySlot() {
  return {
    entries: [] as never[],
    cursor: null as string | null,
    leafId: null as string | null,
    loaded: true,
    streaming: false,
    streamingMessage: null,
    streamingEntryId: null as string | null,
    toolRuns: {},
  };
}

function seedStore(overrides: { entries?: unknown[]; toolRuns?: Record<string, unknown> } = {}): void {
  useMessagesStore.setState({
    bySession: {
      [S]: { ...emptySlot(), entries: (overrides.entries ?? []) as never, toolRuns: (overrides.toolRuns ?? {}) as never },
    },
  });
}

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return container;
}

// ---- spike 实测载荷（runB 首调用，§三原帧节选） ----

const RESOLVED_MODEL = {
  source: "category",
  provider: "zai-coding-cn",
  model_id: "glm-5.3-flash",
  display: "GLM-5.3 Flash",
  variant: "low",
};

const RUN_STATS = {
  runtime_ms: 8508,
  turns: 1,
  tool_calls: 0,
  output_tokens: 37,
  input_tokens: 19497,
  total_tokens: 19534,
  generation_ms: 691,
  tokens_per_second: 54,
  cost_usd: 0.002943,
  cache_hit_rate_last: 0,
  cache_hit_rate_run: 0,
  token_status: "complete",
  cost_status: "reported",
  duration_status: "monotonic",
};

const TAIL = '[task_id: st_01a15e71 - continue with task_send(to="st_01a15e71", message="...")]';
const RESPONSE_BODY = "> 我把这理解为单次响应测试——原样输出指定文本。\n\nECHO-OK-1021";

const TASK_ARGS = {
  prompt: "只输出一行文字：ECHO-OK-1021，不要调用任何工具",
  task_summary: "前台子代理回显测试 ECHO-OK-1021",
  category: "quick",
  run_in_background: false,
};

const FINAL_DETAILS = {
  task_id: "st_01a15e71",
  status: "completed",
  task_summary: "前台子代理回显测试 ECHO-OK-1021",
  name: "st_01a15e71",
  category: "quick",
  execution_mode: "process",
  model: "zai-coding-cn/glm-5.3-flash",
  run_stats: RUN_STATS,
  run_epoch: 0,
  mode: "spawn",
  resolved_model: RESOLVED_MODEL,
  run_in_background: false,
};

const LIVE_DETAILS = {
  task_id: "st_01a15e9c",
  run_epoch: 0,
  status: "running",
  mode: "spawn",
  task_summary: "前台子代理回显测试 ECHO-OK-1021",
  name: "st_01a15e9c",
  category: "quick",
  execution_mode: "process",
  resolved_model: RESOLVED_MODEL,
  run_in_background: false,
  progress: {
    activity: "前台子代理回显测试 ECHO-OK-1021 · category:quick(zai-coding-cn/glm-5.3-flash:low) · turn 1 · running · $0.0029 · 53 tok/s",
    startedAt: "2026-10-21T13:18:00.000Z",
  },
  childId: "rpc-2",
  turns: 1,
  toolCalls: 0,
  tokens: 19534,
  outputTokens: 37,
  tokensPerSecond: 53,
  lastAssistantLine: "ECHO-OK-1021",
};

beforeEach(() => {
  seedStore();
});

afterEach(() => {
  resetDispatchState();
  useMessagesStore.setState({ bySession: {} });
  document.body.innerHTML = "";
});

describe("子代理页签（docs08-r6 任务 17）", () => {
  test("右栏页签接入：tab-agents 存在且点击切换渲染子代理面板", async () => {
    const container = await render(createElement(RightRail, { open: true, onToggle: () => {}, sessionId: S }));
    // 桌面展开 + 手机抽屉两处页签条都渲染该页签
    const tabs = container.querySelectorAll('[data-testid="right-rail-tab-agents"]');
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      (tabs[0] as HTMLElement).click();
    });
    expect(container.querySelector('[data-testid="subagent-empty"]')).not.toBeNull();
  });

  test("空态：无 task 调用显示诚实空态；非 task 工具不算子代理", async () => {
    const container = await render(createElement(SubagentPanel, { sessionId: S }));
    const empty = container.querySelector('[data-testid="subagent-empty"]');
    expect(empty).not.toBeNull();
    expect(container.textContent).toContain("本会话暂无子代理调用");

    await act(async () => {
      useMessagesStore.getState().applyWireEvent(S, {
        type: "tool_execution_start",
        toolCallId: "c-bash",
        toolName: "bash",
        args: { command: "ls" },
      });
    });
    expect(container.querySelector('[data-testid="subagent-empty"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="subagent-card"]').length).toBe(0);
  });

  test("历史终态聚合卡（entries 路径）：状态/模型/用量/摘要齐全，最终回复剥尾注可展开", async () => {
    seedStore({
      entries: [
        { type: "message", id: "m-1", message: { role: "assistant", content: [{ type: "toolCall", id: "c-hist-1", name: "task", arguments: TASK_ARGS }] } },
        {
          type: "message",
          id: "m-2",
          message: { role: "toolResult", toolCallId: "c-hist-1", isError: false, content: [{ type: "text", text: `${RESPONSE_BODY}\n\n${TAIL}` }], details: FINAL_DETAILS },
        },
      ],
    });
    const container = await render(createElement(SubagentPanel, { sessionId: S }));
    const card = container.querySelector('[data-testid="subagent-card"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector('[data-testid="subagent-card-status"]')?.textContent).toContain("完成");
    expect(card?.querySelector('[data-testid="subagent-card-model"]')?.textContent).toBe("GLM-5.3 Flash");
    expect(card?.querySelector('[data-testid="subagent-card-category"]')?.textContent).toBe("quick");
    expect(card?.querySelector('[data-testid="subagent-card-summary"]')?.textContent).toContain("前台子代理回显测试");
    expect(card?.textContent).toContain("st_01a15e71");
    const metrics = card?.querySelector('[data-testid="subagent-card-metrics"]')?.textContent ?? "";
    expect(metrics).toContain("用时 8.5s");
    expect(metrics).toContain("回合 1");
    expect(metrics).toContain("工具 0");
    expect(metrics).toContain("19.5k tok");
    expect(metrics).toContain("输出 37");
    expect(metrics).toContain("54 tok/s");
    expect(metrics).toContain("$0.0029");
    // 折叠态预览：正文首行，无 [task_id 尾注
    const preview = card?.querySelector('[data-testid="subagent-card-response-preview"]')?.textContent ?? "";
    expect(preview).toContain("> 我把这理解为单次响应测试");
    expect(preview).not.toContain("[task_id:");
    // 展开态：全文剥尾注 + 完整提示词
    const expandBtn = card?.querySelector('[data-testid="subagent-card-expand"]');
    expect(expandBtn).not.toBeNull();
    await act(async () => {
      (expandBtn as HTMLElement).click();
    });
    const response = card?.querySelector('[data-testid="subagent-card-response"]')?.textContent ?? "";
    expect(response).toContain("ECHO-OK-1021");
    expect(response).not.toContain("[task_id:");
    expect(response).not.toContain("task_send");
    const prompt = card?.querySelector('[data-testid="subagent-card-prompt"]')?.textContent ?? "";
    expect(prompt).toContain("只输出一行文字：ECHO-OK-1021");
  });

  test("运行中实时态：LIVE 帧渲染 模型+activity+计数+lastAssistantLine（事件路径）", async () => {
    await act(async () => {
      const store = useMessagesStore.getState();
      store.applyWireEvent(S, { type: "tool_execution_start", toolCallId: "c-live-1", toolName: "task", args: TASK_ARGS });
      store.applyWireEvent(S, {
        type: "tool_execution_update",
        toolCallId: "c-live-1",
        toolName: "task",
        args: TASK_ARGS,
        partialResult: { content: [{ type: "text", text: "↳ last: ECHO-OK-1021" }], details: LIVE_DETAILS },
      });
    });
    const container = await render(createElement(SubagentPanel, { sessionId: S }));
    const card = container.querySelector('[data-testid="subagent-card"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector('[data-testid="subagent-card-status"]')?.textContent).toContain("运行中");
    expect(card?.querySelector('[data-testid="subagent-card-model"]')?.textContent).toBe("GLM-5.3 Flash");
    const activity = card?.querySelector('[data-testid="subagent-card-activity"]')?.textContent ?? "";
    expect(activity).toContain("turn 1");
    expect(activity).toContain("53 tok/s");
    const metrics = card?.querySelector('[data-testid="subagent-card-metrics"]')?.textContent ?? "";
    expect(metrics).toContain("19.5k tok");
    expect(metrics).toContain("53 tok/s");
    expect(card?.querySelector('[data-testid="subagent-card-lastline"]')?.textContent).toContain("ECHO-OK-1021");
    // 运行中无最终回复区
    expect(card?.querySelector('[data-testid="subagent-card-response-preview"]')).toBeNull();
  });

  test("运行中→终态转换：end 帧到达即转终态卡，运行中徽标消失（不卡死）", async () => {
    await act(async () => {
      const store = useMessagesStore.getState();
      store.applyWireEvent(S, { type: "tool_execution_start", toolCallId: "c-live-1", toolName: "task", args: TASK_ARGS });
      store.applyWireEvent(S, {
        type: "tool_execution_update",
        toolCallId: "c-live-1",
        toolName: "task",
        partialResult: { content: [{ type: "text", text: "" }], details: LIVE_DETAILS },
      });
    });
    const container = await render(createElement(SubagentPanel, { sessionId: S }));
    expect(container.querySelector('[data-testid="subagent-card-status"]')?.textContent).toContain("运行中");

    await act(async () => {
      useMessagesStore.getState().applyWireEvent(S, {
        type: "tool_execution_end",
        toolCallId: "c-live-1",
        toolName: "task",
        result: { content: [{ type: "text", text: `${RESPONSE_BODY}\n\n${TAIL}` }], details: { ...FINAL_DETAILS, task_id: "st_01a15e9c" } },
        isError: false,
      });
    });
    const card = container.querySelector('[data-testid="subagent-card"]');
    expect(card?.querySelector('[data-testid="subagent-card-status"]')?.textContent).toContain("完成");
    expect(card?.querySelector('[data-testid="subagent-card-status"]')?.textContent).not.toContain("运行中");
    // LIVE 专属槽位让位终态槽位（activity/lastline 消失，run_stats 指标 + 回复预览出现）
    expect(card?.querySelector('[data-testid="subagent-card-activity"]')).toBeNull();
    expect(card?.querySelector('[data-testid="subagent-card-lastline"]')).toBeNull();
    expect(card?.querySelector('[data-testid="subagent-card-metrics"]')?.textContent).toContain("$0.0029");
    expect(card?.querySelector('[data-testid="subagent-card-response-preview"]')?.textContent).toContain("> 我把这理解为单次响应测试");
  });

  test("零中间帧降级：仅 start 无 update 时运行中卡只剩摘要行不崩；end 后补全终态", async () => {
    await act(async () => {
      useMessagesStore.getState().applyWireEvent(S, { type: "tool_execution_start", toolCallId: "c-fast-1", toolName: "task", args: TASK_ARGS });
    });
    const container = await render(createElement(SubagentPanel, { sessionId: S }));
    const card = container.querySelector('[data-testid="subagent-card"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector('[data-testid="subagent-card-status"]')?.textContent).toContain("运行中");
    expect(card?.querySelector('[data-testid="subagent-card-summary"]')?.textContent).toContain("前台子代理回显测试");
    // 无 LIVE 快照：activity/计数/lastline 全部缺席（不崩、不渲染空壳）
    expect(card?.querySelector('[data-testid="subagent-card-activity"]')).toBeNull();
    expect(card?.querySelector('[data-testid="subagent-card-metrics"]')).toBeNull();
    expect(card?.querySelector('[data-testid="subagent-card-lastline"]')).toBeNull();

    await act(async () => {
      useMessagesStore.getState().applyWireEvent(S, {
        type: "tool_execution_end",
        toolCallId: "c-fast-1",
        toolName: "task",
        result: { content: [{ type: "text", text: `${RESPONSE_BODY}\n\n${TAIL}` }], details: FINAL_DETAILS },
        isError: false,
      });
    });
    expect(container.querySelector('[data-testid="subagent-card-status"]')?.textContent).toContain("完成");
    expect(container.querySelector('[data-testid="subagent-card-metrics"]')?.textContent).toContain("19.5k tok");
  });

  test("多卡排序最新在前（首见序反序）", () => {
    const calls = collectSubagentCalls(
      [
        { type: "message", id: "m-1", message: { role: "assistant", content: [{ type: "toolCall", id: "c-1", name: "task", arguments: { task_summary: "第一个" } }] } },
        { type: "message", id: "m-2", message: { role: "assistant", content: [{ type: "toolCall", id: "c-2", name: "task", arguments: { task_summary: "第二个" } }] } },
      ],
      {},
    );
    expect(calls.map((c) => c.toolCallId)).toEqual(["c-1", "c-2"]);
  });

  test("store 接线：tool_execution_update 写入 partialResult 最新快照且不复活终态", async () => {
    const store = useMessagesStore.getState();
    store.applyWireEvent(S, { type: "tool_execution_start", toolCallId: "c-x", toolName: "task", args: TASK_ARGS });
    store.applyWireEvent(S, { type: "tool_execution_update", toolCallId: "c-x", toolName: "task", partialResult: { details: { status: "running", tokens: 100 } } });
    store.applyWireEvent(S, { type: "tool_execution_update", toolCallId: "c-x", toolName: "task", partialResult: { details: { status: "running", tokens: 200 } } });
    const run1 = useMessagesStore.getState().bySession[S].toolRuns["c-x"];
    expect((run1?.partialResult as { details?: { tokens?: number } })?.details?.tokens).toBe(200);
    expect(run1?.status).toBe("running");

    store.applyWireEvent(S, { type: "tool_execution_end", toolCallId: "c-x", toolName: "task", result: { content: [{ type: "text", text: "done" }], details: { status: "completed" } }, isError: false });
    // 终态后迟到的 update 帧：快照并入但 status 不回退（乱序防御）
    store.applyWireEvent(S, { type: "tool_execution_update", toolCallId: "c-x", toolName: "task", partialResult: { details: { status: "running", tokens: 300 } } });
    const run2 = useMessagesStore.getState().bySession[S].toolRuns["c-x"];
    expect(run2?.status).toBe("done");
    expect(run2?.isError).toBe(false);
    expect((run2?.partialResult as { details?: { tokens?: number } })?.details?.tokens).toBe(300);
  });

  test("EventsClient 真实路径：tool_execution_update 具名帧经白名单派发进 store", () => {
    MockEventSource.reset();
    const scheduler = new MockScheduler();
    const client = new EventsClient({
      createEventSource: ((url: string) => new MockEventSource(url)) as unknown as (url: string) => EventSource,
      schedule: scheduler.schedule,
    });
    client.start();
    const es = MockEventSource.live[0];
    es.emitOpen();
    es.emit(
      "tool_execution_update",
      {
        projectPath: "/p",
        event: {
          type: "tool_execution_update",
          toolCallId: "c-wire-1",
          toolName: "task",
          args: TASK_ARGS,
          partialResult: { content: [{ type: "text", text: "" }], details: LIVE_DETAILS },
        },
        durableSessionId: S,
      },
      7,
    );
    const run = useMessagesStore.getState().bySession[S]?.toolRuns["c-wire-1"];
    expect(run).toBeDefined();
    expect(run?.toolName).toBe("task");
    expect(run?.status).toBe("running");
    expect(run?.partialResult).toEqual({ content: [{ type: "text", text: "" }], details: LIVE_DETAILS });
    client.stop();
    disconnectEvents();
  });
});

describe("stripTaskIdTail（尾注剥离纯函数）", () => {
  test("常规：正文 + 尾注 → 仅正文", () => {
    expect(stripTaskIdTail(`${RESPONSE_BODY}\n\n${TAIL}`)).toBe(RESPONSE_BODY);
  });

  test("无尾注原样返回（仅去首尾空白）", () => {
    expect(stripTaskIdTail("  正文内容  ")).toBe("正文内容");
  });

  test("串尾非 ] 或无标记：不误剥", () => {
    expect(stripTaskIdTail("正文 [task_id: 提及但不结尾")).toBe("正文 [task_id: 提及但不结尾");
    expect(stripTaskIdTail("以普通括号结尾]")).toBe("以普通括号结尾]");
  });

  test("整串即尾注 → 空串（空正文）", () => {
    expect(stripTaskIdTail(TAIL)).toBe("");
  });
});
