// @ts-nocheck
// todo 右栏单测（W5-15）。环境说明同 todo-list.test.tsx：
//   @ts-nocheck（bun:test 类型包仅在 server 工作区）+ preload 对齐 zustand 服务端快照，
//   被测模块一律动态 import（保证单独运行时晚于 preload mock 生效）。
// fixture 全部按真实 wire 形态构造（W5-15 验收红线）：assistant 消息的 toolCall part
//（{type:"toolCall", id, name:"todo"}——工具名只在 part 上）+ role=toolResult 结果消息
//（本体无 name，按 toolCallId 关联），复用 todo-evolution 实录样本。
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// bun 无 localStorage：折叠记忆助手走 window.localStorage，测试注入最小 shim
const prefStore = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (prefStore.has(k) ? prefStore.get(k) : null),
    setItem: (k, v) => prefStore.set(k, String(v)),
  },
};

const {
  TodoPanel,
  extractLatestTodoPhases,
  readPanelOpenPreference,
  writePanelOpenPreference,
} = await import("../todo-panel");
const { useMessagesStore } = await import("@/stores/messages");
const {
  EVO_CALL_1_ID,
  EVO_CALL_2_ID,
  EVO_CALL_3_ID,
  EVO_RESULT_1,
  EVO_RESULT_2,
  EVO_RESULT_3_ABANDONED,
  messageEntry,
  storedEntry,
} = await import("./fixtures/todo-evolution");

const SID = "qa-todo-panel";

/** assistant 定格条目（真实 wire 形态）：toolCall part 挂 content[]，工具名在 part 上 */
function assistantTodoEntry(id, toolCallId) {
  return storedEntry(id, {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: "todo", arguments: { op: "list" } }],
  });
}

afterEach(() => {
  useMessagesStore.getState().clearSession(SID);
  prefStore.clear();
});

afterAll(() => {
  delete globalThis.window;
});

describe("extractLatestTodoPhases 最新快照提取", () => {
  test("多轮演进取最后一轮（3 轮 init→done→list 终态 abandoned）", () => {
    const entries = [
      assistantTodoEntry("a1", EVO_CALL_1_ID),
      storedEntry("r1", EVO_RESULT_1),
      assistantTodoEntry("a2", EVO_CALL_2_ID),
      storedEntry("r2", EVO_RESULT_2),
      assistantTodoEntry("a3", EVO_CALL_3_ID),
      storedEntry("r3", EVO_RESULT_3_ABANDONED),
    ];
    const phases = extractLatestTodoPhases(entries);
    expect(phases).not.toBeNull();
    expect(phases[0].tasks.map((t) => t.status)).toEqual(["completed", "abandoned"]);
  });

  test("最新 todo 调用尚未落定（无 toolResult）→ 回退上一轮快照", () => {
    const entries = [
      assistantTodoEntry("a1", EVO_CALL_1_ID),
      storedEntry("r1", EVO_RESULT_1),
      assistantTodoEntry("a2", EVO_CALL_2_ID), // 第 2 轮已定格但结果未到
    ];
    const phases = extractLatestTodoPhases(entries);
    expect(phases).not.toBeNull();
    expect(phases[0].tasks.map((t) => t.status)).toEqual(["in_progress", "pending"]);
  });

  test("无 assistant / 无 todo toolCall / 有调用无结果 → null", () => {
    expect(extractLatestTodoPhases([])).toBeNull();
    expect(
      extractLatestTodoPhases([storedEntry("u1", { role: "user", content: [{ type: "text", text: "你好" }] })]),
    ).toBeNull();
    expect(extractLatestTodoPhases([assistantTodoEntry("a1", "call_never_resulted")])).toBeNull();
  });

  test("非 todo 工具不参与（toolResult 本体无 name，名字只在 part 上——防裸 toolResult 误取）", () => {
    const entries = [
      storedEntry("b1", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_bash", name: "bash", arguments: {} }],
      }),
      storedEntry("b2", {
        role: "toolResult",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    ];
    expect(extractLatestTodoPhases(entries)).toBeNull();
  });
});

describe("TodoPanel 渲染", () => {
  test("最新快照渲染 + 新快照到达自动跟随（message_start→message_end 定格入列）", () => {
    useMessagesStore.getState().setEntries(
      SID,
      [assistantTodoEntry("a1", EVO_CALL_1_ID), storedEntry("r1", EVO_RESULT_1)],
      null,
      null,
    );
    const first = renderToStaticMarkup(<TodoPanel sessionId={SID} />);
    expect(first).toContain("任务清单");
    expect(first).toContain("0/2 已完成");
    expect(first).toContain('data-status="in_progress"');
    expect(first).not.toContain("line-through");

    // 新一轮快照到达（真实 wire 顺序：assistant 流式 start → 定格 end → toolResult 入列）
    const store = useMessagesStore.getState();
    store.applyWireEvent(SID, messageEntry("a2", {
      role: "assistant",
      content: [{ type: "toolCall", id: EVO_CALL_2_ID, name: "todo", arguments: { op: "done" } }],
    }));
    store.applyWireEvent(SID, { type: "message_end", id: "a2", message: {
      role: "assistant",
      content: [{ type: "toolCall", id: EVO_CALL_2_ID, name: "todo", arguments: { op: "done" } }],
    } });
    store.applyWireEvent(SID, messageEntry("r2", EVO_RESULT_2));

    const second = renderToStaticMarkup(<TodoPanel sessionId={SID} />);
    expect(second).toContain("1/2 已完成");
    expect(second).toContain("line-through");
    expect(second).toContain('data-status="in_progress"');
  });

  test("两个空态：无会话 / 会话无 todo（含 store 槽未加载）", () => {
    const noSession = renderToStaticMarkup(<TodoPanel sessionId={null} />);
    expect(noSession).toContain("未选择会话");

    useMessagesStore
      .getState()
      .setEntries(SID, [storedEntry("u1", { role: "user", content: [{ type: "text", text: "你好" }] })], null, null);
    const noTodo = renderToStaticMarkup(<TodoPanel sessionId={SID} />);
    expect(noTodo).toContain("本会话还没有 todo 清单");

    const unloaded = renderToStaticMarkup(<TodoPanel sessionId="sid-not-loaded" />);
    expect(unloaded).toContain("本会话还没有 todo 清单");
  });
});

describe("折叠记忆持久化", () => {
  test("写入后读取往返（true/false 双向）", () => {
    expect(readPanelOpenPreference()).toBeNull(); // 无记录 = 未交互
    writePanelOpenPreference(true);
    expect(readPanelOpenPreference()).toBe(true);
    writePanelOpenPreference(false);
    expect(readPanelOpenPreference()).toBe(false);
  });

  test("storage 不可用时读写静默降级（读 null、写不抛）", () => {
    const saved = globalThis.window;
    delete globalThis.window;
    try {
      expect(readPanelOpenPreference()).toBeNull();
      expect(() => writePanelOpenPreference(true)).not.toThrow();
    } finally {
      globalThis.window = saved;
    }
  });
});
