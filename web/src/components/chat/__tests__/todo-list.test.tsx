// @ts-nocheck
// todo 渲染与图片 part 单测（todo 23）。环境说明同 tool-card.test.tsx：
//   @ts-nocheck（bun:test 类型包仅在 server 工作区）+ preload 对齐 zustand 服务端快照，
//   被测模块一律动态 import（保证单独运行时晚于 preload mock 生效）。
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { TodoList } = await import("../todo-list");
const { PartView } = await import("../parts");
const { parseTodoSnapshot, findToolResultMessage } = await import("../todo-list-data");
const { useMessagesStore } = await import("@/stores/messages");
const {
  EVO_CALL_1_ID,
  EVO_CALL_2_ID,
  EVO_CALL_3_ID,
  EVO_START_1,
  EVO_START_2,
  EVO_START_3,
  EVO_RESULT_1,
  EVO_RESULT_2,
  EVO_RESULT_3_ABANDONED,
  MULTIPHASE_RESULT,
  IMAGE_PART,
  messageEntry,
  storedEntry,
} = await import("./fixtures/todo-evolution");

const SID = "qa-todo-list";

function renderTodo(toolCallId, name = "todo", args = undefined, live = false) {
  return renderToStaticMarkup(<TodoList sessionId={SID} toolCallId={toolCallId} name={name} args={args} live={live} />);
}

afterEach(() => {
  useMessagesStore.getState().clearSession(SID);
});

describe("todo-list-data 纯助手", () => {
  test("parseTodoSnapshot：details.phases 提取 + 四态识别（含 abandoned）", () => {
    const phases = parseTodoSnapshot(EVO_RESULT_3_ABANDONED, undefined);
    expect(phases).not.toBeNull();
    expect(phases.length).toBe(1);
    expect(phases[0].name).toBe("清单");
    expect(phases[0].tasks.map((t) => t.status)).toEqual(["completed", "abandoned"]);
  });

  test("parseTodoSnapshot：未知状态归 pending；缺失/空 phases 返回 null", () => {
    const weird = { role: "toolResult", toolCallId: "x", details: { phases: [{ name: "P", tasks: [{ content: "a", status: "flying" }] }] } };
    expect(parseTodoSnapshot(weird, undefined)[0].tasks[0].status).toBe("pending");
    expect(parseTodoSnapshot({ details: {} }, undefined)).toBeNull();
    expect(parseTodoSnapshot({ details: { phases: [] } }, undefined)).toBeNull();
    expect(parseTodoSnapshot(null, undefined)).toBeNull();
    expect(parseTodoSnapshot(null, "plain-string-result")).toBeNull();
  });

  test("parseTodoSnapshot：run.result 同构 {details:{phases}} 兜底", () => {
    const phases = parseTodoSnapshot(null, { details: { phases: [{ name: "P", tasks: [{ content: "a", status: "completed" }] }] } });
    expect(phases).not.toBeNull();
    expect(phases[0].tasks[0].status).toBe("completed");
  });

  test("findToolResultMessage：双形态 entry（message 定格 / message_start 实时）+ 反向最近命中", () => {
    const entries = [
      storedEntry("e1", { role: "toolResult", toolCallId: "a" }),
      messageEntry("e2", { role: "assistant", content: [] }),
      messageEntry("e3", { role: "toolResult", toolCallId: "b" }),
    ];
    expect(findToolResultMessage(entries, "a").toolCallId).toBe("a");
    expect(findToolResultMessage(entries, "b").toolCallId).toBe("b");
    expect(findToolResultMessage(entries, "c")).toBeNull();
  });
});

describe("todo-list 事件驱动渲染（fixture 三步演进）", () => {
  test("start（无结果）→ 降级 ToolCard 运行态；结果到达 → 结构化清单（in_progress 高亮 + pending 空框）", () => {
    useMessagesStore.getState().applyWireEvent(SID, EVO_START_1);
    const runningHtml = renderTodo(EVO_CALL_1_ID, "todo", EVO_START_1.args, true);
    expect(runningHtml).toContain("运行中");
    expect(runningHtml).not.toContain("data-status="); // 无快照 → 通用卡片通路

    useMessagesStore.getState().applyWireEvent(SID, messageEntry("entry-evo-1", EVO_RESULT_1));
    const html = renderTodo(EVO_CALL_1_ID, "todo", EVO_START_1.args);
    expect(html).toContain("todo");
    expect(html).toContain("清单");
    expect(html).toContain("买牛奶");
    expect(html).toContain("寄包裹");
    expect(html).toContain('data-status="in_progress"');
    expect(html).toContain("进行中");
    expect(html).toContain('data-status="pending"');
    expect(html).toContain("0/2 已完成");
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("运行中");
  });

  test("details 幂等刷新：同 entry id 覆盖新快照 → 勾选状态随事件更新", () => {
    useMessagesStore.getState().applyWireEvent(SID, EVO_START_1);
    useMessagesStore.getState().applyWireEvent(SID, messageEntry("entry-evo-1", EVO_RESULT_1));
    expect(renderTodo(EVO_CALL_1_ID)).toContain('data-status="in_progress"');
    // 同 id upsert（引擎幂等刷新 / SSE 重放）：快照推进到第 2 步（同一 toolCallId 的新 details）
    const refreshed = { ...EVO_RESULT_2, toolCallId: EVO_CALL_1_ID };
    useMessagesStore.getState().applyWireEvent(SID, messageEntry("entry-evo-1", refreshed));
    const html = renderTodo(EVO_CALL_1_ID);
    expect(html).toContain('data-status="completed"');
    expect(html).toContain("1/2 已完成");
    // 第 2 步快照无 pending 项（第 1 步有）——证明快照已被覆盖而非叠加
    expect(html).not.toContain('data-status="pending"');
  });

  test("abandoned 终态渲染：删除线 + 已放弃徽标（多轮演进第 3 步）", () => {
    useMessagesStore.getState().applyWireEvent(SID, EVO_START_3);
    useMessagesStore.getState().applyWireEvent(SID, messageEntry("entry-evo-3", EVO_RESULT_3_ABANDONED));
    const html = renderTodo(EVO_CALL_3_ID);
    expect(html).toContain('data-status="abandoned"');
    expect(html).toContain("已放弃");
    expect(html).toContain("line-through");
    expect(html).toContain("1/2 已完成");
  });

  test("多轮 todo 演进：历史卡片保留各轮快照，最新卡片显示最新态", () => {
    useMessagesStore.getState().applyWireEvent(SID, EVO_START_1);
    useMessagesStore.getState().applyWireEvent(SID, messageEntry("entry-evo-1", EVO_RESULT_1));
    useMessagesStore.getState().applyWireEvent(SID, EVO_START_2);
    useMessagesStore.getState().applyWireEvent(SID, messageEntry("entry-evo-2", EVO_RESULT_2));
    useMessagesStore.getState().applyWireEvent(SID, EVO_START_3);
    useMessagesStore.getState().applyWireEvent(SID, messageEntry("entry-evo-3", EVO_RESULT_3_ABANDONED));
    const first = renderTodo(EVO_CALL_1_ID);
    const second = renderTodo(EVO_CALL_2_ID);
    const third = renderTodo(EVO_CALL_3_ID);
    // 第 1/2 轮卡片定格各自调用时刻快照
    expect(first).toContain('data-status="in_progress"');
    expect(second).toContain('data-status="completed"');
    expect(second).toContain('data-status="in_progress"');
    // 最新轮 = 回合终态（abandoned）
    expect(third).toContain('data-status="abandoned"');
  });

  test("多 phase 分组：两组各渲染，组内状态互不串", () => {
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "tool_execution_start",
      toolCallId: MULTIPHASE_RESULT.toolCallId,
      toolName: "todo",
      args: { op: "init" },
    });
    useMessagesStore.getState().applyWireEvent(SID, messageEntry("entry-mp", MULTIPHASE_RESULT));
    const html = renderTodo(MULTIPHASE_RESULT.toolCallId);
    expect(html).toContain("调研");
    expect(html).toContain("实现");
    expect(html).toContain("读现有实现");
    expect(html).toContain("改渲染分支");
    expect(html).toContain('data-status="completed"');
    expect(html).toContain('data-status="pending"');
    expect(html).toContain('data-status="in_progress"');
    expect(html).toContain("1/3 已完成");
  });

  test("历史会话（entries 预载、无 toolRuns）→ 直接结构化清单，无运行态", () => {
    useMessagesStore.getState().setEntries(
      SID,
      [
        storedEntry("h1", {
          role: "assistant",
          content: [{ type: "toolCall", id: EVO_CALL_1_ID, name: "todo", arguments: EVO_START_1.args }],
        }),
        storedEntry("h2", EVO_RESULT_1),
      ],
      null,
      null,
    );
    const html = renderTodo(EVO_CALL_1_ID, "todo", EVO_START_1.args);
    expect(html).toContain('data-status="in_progress"');
    expect(html).not.toContain("运行中");
  });

  test("details 异形（无 phases）→ 降级通用 ToolCard 通路，不崩", () => {
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "tool_execution_start",
      toolCallId: "call_todo_nodetails",
      toolName: "todo",
      args: { op: "list" },
    });
    useMessagesStore.getState().applyWireEvent(SID, messageEntry("entry-nd", {
      role: "toolResult",
      toolCallId: "call_todo_nodetails",
      toolName: "todo",
      content: [{ type: "text", text: "没有结构化数据的结果" }],
      isError: false,
    }));
    const html = renderTodo("call_todo_nodetails");
    expect(html).toContain('data-tool-call="call_todo_nodetails"');
    expect(html).toContain("todo");
    expect(html).not.toContain("data-status=");
    expect(html).not.toContain("已完成");
  });
});

describe("图片 part 渲染（todo 23）", () => {
  test("image part → 内联 img（data URI），灯箱默认关闭", () => {
    const html = renderToStaticMarkup(<PartView part={IMAGE_PART} sessionId={SID} live={false} />);
    expect(html).toContain("<img");
    expect(html).toContain(`data:${IMAGE_PART.mimeType};base64,${IMAGE_PART.data.slice(0, 16)}`);
    expect(html).toContain("查看大图");
    expect(html).not.toContain('role="dialog"');
  });

  test("无 data 的异形 image part → 静默不渲染", () => {
    const html = renderToStaticMarkup(<PartView part={{ type: "image" }} sessionId={SID} live={false} />);
    expect(html).toBe("");
  });

  test("image_ref part → 占位降级提示，不阻塞渲染", () => {
    const html = renderToStaticMarkup(<PartView part={{ type: "image_ref" }} sessionId={SID} live={false} />);
    expect(html).toContain("工具产出图片暂不可查看");
  });
  // 灯箱交互（遮罩/Esc 关闭、大图适配）为运行时行为：bun test 无 DOM（SSR 下 portal 亦不产出
  // 标记），按验证约定走真实浏览器 QA（.omo/qa/W4/todo-image.md 实测点击/Esc/390x844）。
});
