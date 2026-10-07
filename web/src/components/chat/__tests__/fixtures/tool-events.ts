// 工具调用卡片单测 fixture（todo 17）：来源为 P0 spike 实录——
//   docs/verification/01-rpc-basic.md（事件类型表）、03-omo-extensions-rpc.md（todo 工具 start/结果样本）、
//   02-permission-roundtrip.md（bash 工具与 isError:true 被拒形态）、
//   /tmp/opencode/p0-3-proj/p0-3-samples.json（toolExecutionEvents / todoResultSample 原文）。
// 仅「未知工具」与 tool_execution_end 两条为按 docs/01 事件表字段构造（引擎未实录 end 原文，字段面以文档为准）。

/** tool_execution_start：omo todo 工具 init（P0-3 实录原文） */
export const TODO_START = {
  type: "tool_execution_start",
  toolCallId: "call_6c828ecbb4854ad88769ff75",
  toolName: "todo",
  args: { op: "init", list: [{ phase: "清单", items: ["买牛奶", "寄包裹"] }] },
  sessionId: "rpc-1",
} as const;

/** tool_execution_start：omo todo 工具 done op（P0-3 实录原文） */
export const TODO_START_DONE = {
  type: "tool_execution_start",
  toolCallId: "call_cc12795ab4da4ed598400497",
  toolName: "todo",
  args: { op: "done", task: "买牛奶" },
  sessionId: "rpc-1",
} as const;

/** tool_execution_end：同 id + result（docs/01 事件表字段面；end 原文未实录，result 形态取 toolResult 同构） */
export const TODO_END = {
  type: "tool_execution_end",
  toolCallId: "call_6c828ecbb4854ad88769ff75",
  toolName: "todo",
  args: TODO_START.args,
  result: null,
  sessionId: "rpc-1",
} as const;

/** toolResult 消息：omo todo 结构化结果（verification/03 §todo 样本 + p0-3-samples.json todoResultSample 原文，
 *  含 details.phases —— 本 todo 只按通用卡片展示 content 文本，phases 结构化渲染归 todo 23） */
export const TODO_RESULT_MESSAGE = {
  role: "toolResult",
  toolCallId: "call_6c828ecbb4854ad88769ff75",
  toolName: "todo",
  content: [
    {
      type: "text",
      text: "Ask: 用 todo 工具创建一个清单，包含两项：买牛奶、寄包裹。然后把第一项标记为完成。不要做其他任何事，不要解释。\nNow: 买牛奶 (清单)\nNext: 寄包裹 (清单)\n\nRemaining items (2):\n  - 买牛奶 [in_progress] (清单)\n  - 寄包裹 [pending] (清单)\nOverall: 0/2 done, 2 open.\nActive phase 1/1 \"清单\" (0/2).\n  清单:\n    - [ ] 买牛奶 (in progress)\n    - [ ] 寄包裹\n\nHandoff due: the plan exists. Before your next tool call, write the Ask / For you / Now / Next block.",
    },
    {
      type: "text",
      text: "<system-reminder>\nNew todo tasks were added, but this thread has no goal registered.\nIf this todo list tracks a durable objective (multi-step work that should survive across turns), register it now with create_goal so progress is tracked and audited.\nIf the todos are trivial short-lived bookkeeping for the current turn, continue without a goal.\n</system-reminder>",
    },
  ],
  details: {
    op: "init",
    phases: [{ name: "清单", tasks: [{ content: "买牛奶", status: "in_progress" }, { content: "寄包裹", status: "pending" }] }],
    storage: "session",
    ask: { entryId: "a3c26e91", text: "用 todo 工具创建一个清单，包含两项：买牛奶、寄包裹。然后把第一项标记为完成。不要做其他任何事，不要解释。", capturedAt: 1791286719675 },
  },
  isError: false,
  timestamp: 1791286719768,
} as const;

/** tool_execution_start：bash 工具（verification/02 权限往返实录的命令形态：`Command: $ ls -la`） */
export const BASH_START = {
  type: "tool_execution_start",
  toolCallId: "call_5954247ebashls",
  toolName: "bash",
  args: { command: "ls -la" },
  sessionId: "rpc-1",
} as const;

/** toolResult 消息：bash 被拒（isError:true 形态——verification/02 记录 `tool_execution_end bash isError:true`；
 *  文本按引擎拒绝行为重构，结构面以实录为准） */
export const BASH_RESULT_DENIED = {
  role: "toolResult",
  toolCallId: "call_5954247ebashls",
  toolName: "bash",
  content: [{ type: "text", text: "Error: Tool execution was rejected by the user." }],
  isError: true,
} as const;

/** tool_execution_start：未知工具（构造：QA 失败场景——未登记 toolName + 异形 args） */
export const UNKNOWN_START = {
  type: "tool_execution_start",
  toolCallId: "call_unknown_fixture_1",
  toolName: "mystery_tool",
  args: "raw-string-args-not-object",
  sessionId: "rpc-1",
} as const;

/** 定格条目包装：wire 事件形态 {type:"message_start", id, message}（store entries 存储形态为
 *  {type:"message", id, message}，由 applyWireEvent 转换；历史预载用 entries 原样 {type:"message"}） */
export function messageEntry(id: string, message: unknown) {
  return { type: "message_start", id, message };
}

/** 历史预载用 entries 原样条目 {type:"message", id, message}（GET messages 返回形态） */
export function storedEntry(id: string, message: unknown) {
  return { type: "message", id, message };
}
