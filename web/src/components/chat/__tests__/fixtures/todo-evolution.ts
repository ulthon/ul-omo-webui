// todo 三步演进 fixture（todo 23）：verification/03 §todo 样本 + P0-3 会话持久化演进实录——
//   [(买牛奶,in_progress),(寄包裹,pending)] → [completed, in_progress] → [completed, abandoned]。
//   abandoned = 回合结束时仍未完成项的终态。多 phase 组与图片 part 为按 docs/01 字段面构造的
//   补充样本（引擎实录均为单 phase；多 phase 分组与图片渲染需独立断言）。

export const EVO_CALL_1_ID = "call_todo_evo_init";
export const EVO_CALL_2_ID = "call_todo_evo_done";
export const EVO_CALL_3_ID = "call_todo_evo_list";

/** 第 1 轮：op init（P0-3 实录 args 形态） */
export const EVO_START_1 = {
  type: "tool_execution_start",
  toolCallId: EVO_CALL_1_ID,
  toolName: "todo",
  args: { op: "init", list: [{ phase: "清单", items: ["买牛奶", "寄包裹"] }] },
  sessionId: "rpc-1",
} as const;

/** 第 1 轮结果快照：in_progress + pending（verification/03 todo 样本 details 原文形态） */
export const EVO_RESULT_1 = {
  role: "toolResult",
  toolCallId: EVO_CALL_1_ID,
  toolName: "todo",
  content: [
    {
      type: "text",
      text: "Now: 买牛奶 (清单)\nNext: 寄包裹 (清单)\nOverall: 0/2 done, 2 open.",
    },
  ],
  details: {
    op: "init",
    phases: [
      { name: "清单", tasks: [{ content: "买牛奶", status: "in_progress" }, { content: "寄包裹", status: "pending" }] },
    ],
    storage: "session",
  },
  isError: false,
} as const;

/** 第 2 轮：op done（完成买牛奶） */
export const EVO_START_2 = {
  type: "tool_execution_start",
  toolCallId: EVO_CALL_2_ID,
  toolName: "todo",
  args: { op: "done", task: "买牛奶" },
  sessionId: "rpc-1",
} as const;

/** 第 2 轮结果快照：completed + in_progress（senpi.todo-state 演进第 2 步形态） */
export const EVO_RESULT_2 = {
  role: "toolResult",
  toolCallId: EVO_CALL_2_ID,
  toolName: "todo",
  content: [{ type: "text", text: "Done: 买牛奶\nOverall: 1/2 done, 1 open." }],
  details: {
    op: "done",
    phases: [
      { name: "清单", tasks: [{ content: "买牛奶", status: "completed" }, { content: "寄包裹", status: "in_progress" }] },
    ],
    storage: "session",
  },
  isError: false,
} as const;

/** 第 3 轮（新回合 list 调用）：回合结束终态——completed + abandoned（P0-3 演进第 3 步） */
export const EVO_START_3 = {
  type: "tool_execution_start",
  toolCallId: EVO_CALL_3_ID,
  toolName: "todo",
  args: { op: "list" },
  sessionId: "rpc-1",
} as const;

export const EVO_RESULT_3_ABANDONED = {
  role: "toolResult",
  toolCallId: EVO_CALL_3_ID,
  toolName: "todo",
  content: [{ type: "text", text: "Overall: 1/2 done, 1 abandoned." }],
  details: {
    op: "list",
    phases: [
      { name: "清单", tasks: [{ content: "买牛奶", status: "completed" }, { content: "寄包裹", status: "abandoned" }] },
    ],
    storage: "session",
  },
  isError: false,
} as const;

/** 多 phase 分组样本（构造：docs/01 字段面，两 phase 各含不同状态） */
export const MULTIPHASE_RESULT = {
  role: "toolResult",
  toolCallId: "call_todo_multiphase",
  toolName: "todo",
  content: [{ type: "text", text: "(文本视图)" }],
  details: {
    op: "init",
    phases: [
      {
        name: "调研",
        tasks: [{ content: "读现有实现", status: "completed" }, { content: "写对比笔记", status: "pending" }],
      },
      { name: "实现", tasks: [{ content: "改渲染分支", status: "in_progress" }] },
    ],
    storage: "session",
  },
  isError: false,
} as const;

/** 用户上传图 image part（P1-3 实证形态：{type:"image",data:base64,mimeType}；data 为最小红点 PNG） */
export const IMAGE_PART = {
  type: "image",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  mimeType: "image/png",
} as const;

/** 定格条目包装（wire 事件形态 message_start）与历史预载形态（message），同 tool-events.ts 约定 */
export function messageEntry(id: string, message: unknown) {
  return { type: "message_start", id, message };
}

export function storedEntry(id: string, message: unknown) {
  return { type: "message", id, message };
}
