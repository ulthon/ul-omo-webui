// @ts-nocheck
// 工具调用卡片 fixture 单测（todo 17）。两点环境说明：
//   1) @ts-nocheck：bun:test 类型包（bun-types）仅装在 server 工作区，web 的 tsc -b 无法解析
//      "bun:test" 模块类型；bun test 运行时不受影响。
//   2) zustand 服务端渲染快照问题由 tests/helpers/zustand-server-snapshot.ts（bunfig.toml preload）
//      全局解决：zustand v5 在 react-dom/server 下走 getServerSnapshot = getInitialState()（建库空态），
//      preload 把其对齐为实时状态。因此本文件的被测模块必须在动态 import 中加载——若直接静态 import，
//      它们会被提升到 preload 之外的模块图里按普通顺序解析（preload 先于一切测试模块执行，此处
//      动态加载是防御性写法，保证单独运行本文件时被测模块晚于 mock 生效）。
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { ToolCard } = await import("../tool-card");
const { summarizeArgs, prettyJson, resultTextOf, diffTextOf, RESULT_PREVIEW_CHARS, ARGS_SUMMARY_CHARS } = await import(
  "../tool-card-data"
);
const { useMessagesStore } = await import("@/stores/messages");
const {
  TODO_START,
  TODO_START_DONE,
  TODO_END,
  TODO_RESULT_MESSAGE,
  BASH_START,
  BASH_RESULT_DENIED,
  UNKNOWN_START,
  messageEntry,
  storedEntry,
} = await import("./fixtures/tool-events");

const SID = "qa-tool-card";

function renderCard(props) {
  return renderToStaticMarkup(
    <ToolCard sessionId={SID} toolCallId={props.toolCallId} name={props.name} args={props.args} live={props.live ?? false} />,
  );
}

afterEach(() => {
  useMessagesStore.getState().clearSession(SID);
});

describe("tool-card 纯助手函数", () => {
  test("summarizeArgs：对象摘要 / 空值 / 超长截断 / 字符串原样", () => {
    expect(summarizeArgs(null)).toBe("");
    expect(summarizeArgs(undefined)).toBe("");
    expect(summarizeArgs({})).toBe("");
    expect(summarizeArgs([])).toBe("");
    expect(summarizeArgs({ command: "ls -la" })).toBe('{"command":"ls -la"}');
    expect(summarizeArgs("raw-string")).toBe("raw-string");
    const long = JSON.stringify({ text: "x".repeat(500) });
    const out = summarizeArgs(long);
    expect(out.length).toBe(ARGS_SUMMARY_CHARS + 1); // 截断 + 尾部省略号
    expect(out.endsWith("…")).toBe(true);
  });

  test("diffTextOf：details.patch 优先（引擎 edit 实证形态），文本启发式兜底，无 diff 返回 null", () => {
    // 引擎 edit 工具真实形态：content 是纯文本结果，details.patch 是 unified diff
    const editLike = {
      role: "toolResult",
      toolCallId: "call_edit",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in README.md." }],
      details: {
        patch: "--- README.md\n+++ README.md\n@@ -1,3 +1,3 @@\n-# W4-19 测试项目\n+# W4-19 已由 agent 修改\n \n 已修改的说明文本。\n",
      },
      isError: false,
    } as never;
    expect(diffTextOf(editLike, "Successfully replaced 1 block(s) in README.md.")).toStartWith("--- README.md");
    // ```diff 围栏文本兜底（无 details.patch）
    expect(diffTextOf(null, "改动如下\n```diff\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b\n```")).toContain(
      "--- a/f.ts",
    );
    // 无 diff 形态：普通结果文本与 todo 结构化 details 都返回 null
    expect(diffTextOf(null, "Successfully replaced 1 block(s).")).toBeNull();
    expect(diffTextOf(TODO_RESULT_MESSAGE, resultTextOf(TODO_RESULT_MESSAGE, undefined))).toBeNull();
  });

  test(
    "prettyJson：对象 pretty / 字符串原样 / 循环引用不崩",
    () => {
      expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
      expect(prettyJson("already")).toBe("already");
      const circular = {};
      circular.self = circular;
      expect(prettyJson(circular)).toContain("[object Object]");
      // 有界性：深嵌套不炸栈不失控（超 MAX_DEPTH 占位 "…"）
      let deep = 1;
      for (let i = 0; i < 100; i++) deep = { child: deep };
      const bounded = prettyJson(deep);
      expect(bounded).toContain('"…"');
      expect(bounded.length).toBeLessThan(1000);
      // 共享非循环引用：不得被 Seen 误报为循环
      const shared = { x: 1 };
      const twice = { a: shared, b: shared };
      const out = prettyJson(twice);
      expect((out.match(/"x": 1/g) ?? []).length).toBe(2);
      expect(out).not.toContain("[object Object]");
    },
    200, // 首跑曾因 stringify 循环路径病态耗时超默认 5s 偶发失败；显式收紧为 200ms 防回归
  );

  test("resultTextOf：toolResult content 文本优先，run.result 兜底，长 todo 文本完整提取", () => {
    expect(resultTextOf(TODO_RESULT_MESSAGE, undefined)).toContain("Overall: 0/2 done");
    expect(resultTextOf(TODO_RESULT_MESSAGE, undefined).length).toBeGreaterThan(RESULT_PREVIEW_CHARS);
    expect(resultTextOf(null, "plain string")).toBe("plain string");
    expect(resultTextOf(null, { content: [{ type: "text", text: "structured" }] })).toBe("structured");
    expect(resultTextOf(null, { ok: true })).toBe('{\n  "ok": true\n}');
    expect(resultTextOf(null, null)).toBe("");
    expect(resultTextOf(null, undefined)).toBe("");
  });
});

describe("tool-card 运行状态流转（fixture 事件驱动）", () => {
  test("tool_execution_start → 运行中（转圈 + 参数摘要 + 默认折叠）", () => {
    useMessagesStore.getState().applyWireEvent(SID, TODO_START);
    const html = renderCard({ toolCallId: TODO_START.toolCallId, name: TODO_START.toolName, args: TODO_START.args });
    expect(html).toContain(`data-tool-call="${TODO_START.toolCallId}"`);
    expect(html).toContain("运行中");
    expect(html).toContain("animate-spin");
    expect(html).toContain("todo");
    expect(html).toContain("买牛奶"); // args 摘要进入头部
    expect(html).toContain('aria-expanded="false"'); // 默认折叠，无参数/结果面板
    expect(html).not.toContain("参数");
    expect(html).not.toContain("结果");
  });

  test("toolResult 定格 → 完成（结果就绪，运行态消失）", () => {
    useMessagesStore.getState().applyWireEvent(SID, TODO_START);
    useMessagesStore.getState().applyWireEvent(SID, messageEntry("entry-1", TODO_RESULT_MESSAGE));
    const html = renderCard({ toolCallId: TODO_START.toolCallId, name: TODO_START.toolName, args: TODO_START.args });
    expect(html).toContain("完成");
    expect(html).not.toContain("运行中");
    expect(html).not.toContain("animate-spin");
    // details.phases 结构化数据不越界渲染（todo 23 领地）：只走通用文本通路
    expect(html).not.toContain("in_progress");
  });

  test("tool_execution_end 兜底（result=null）→ 完成不崩", () => {
    useMessagesStore.getState().applyWireEvent(SID, TODO_START);
    useMessagesStore.getState().applyWireEvent(SID, TODO_END);
    const html = renderCard({ toolCallId: TODO_START.toolCallId, name: TODO_START.toolName, args: TODO_START.args });
    expect(html).toContain("完成");
    expect(html).not.toContain("运行中");
  });

  test("isError:true（bash 被拒）→ 失败态 + destructive 强调", () => {
    useMessagesStore.getState().applyWireEvent(SID, BASH_START);
    useMessagesStore.getState().applyWireEvent(SID, messageEntry("entry-2", BASH_RESULT_DENIED));
    const html = renderCard({ toolCallId: BASH_START.toolCallId, name: BASH_START.toolName, args: BASH_START.args });
    expect(html).toContain("失败");
    expect(html).toContain("text-destructive");
    expect(html).toContain("bash");
    expect(html).toContain("ls -la");
    expect(html).not.toContain("运行中");
  });

  test("同会话多工具并存：状态各自独立（todo 运行中 / bash 失败）", () => {
    useMessagesStore.getState().applyWireEvent(SID, TODO_START_DONE);
    useMessagesStore.getState().applyWireEvent(SID, BASH_START);
    useMessagesStore.getState().applyWireEvent(SID, messageEntry("entry-3", BASH_RESULT_DENIED));
    const runningHtml = renderCard({ toolCallId: TODO_START_DONE.toolCallId, name: TODO_START_DONE.toolName, args: TODO_START_DONE.args });
    expect(runningHtml).toContain("运行中");
    const doneHtml = renderCard({ toolCallId: BASH_START.toolCallId, name: BASH_START.toolName, args: BASH_START.args });
    expect(doneHtml).toContain("失败");
  });
});

describe("tool-card 历史会话与兜底", () => {
  test("历史定格消息（entries 预载、无 toolRuns）→ 参数取 part.arguments、结果取 toolResult，直接完成态", () => {
    useMessagesStore.getState().setEntries(
      SID,
      [
        storedEntry("hist-1", {
          role: "assistant",
          content: [{ type: "toolCall", id: TODO_START.toolCallId, name: "todo", arguments: TODO_START.args }],
        }),
        storedEntry("hist-2", TODO_RESULT_MESSAGE),
      ],
      null,
      null,
    );
    const html = renderCard({ toolCallId: TODO_START.toolCallId, name: "todo", args: TODO_START.args });
    expect(html).toContain("完成");
    expect(html).toContain("买牛奶");
    expect(html).not.toContain("运行中");
  });

  test("未知工具 + 异形 args（字符串）→ 通用兜底卡片不崩", () => {
    useMessagesStore.getState().applyWireEvent(SID, UNKNOWN_START);
    const html = renderCard({ toolCallId: UNKNOWN_START.toolCallId, name: UNKNOWN_START.toolName, args: UNKNOWN_START.args, live: true });
    expect(html).toContain("mystery_tool");
    expect(html).toContain("raw-string-args-not-object");
    expect(html).toContain("运行中"); // live 在途按运行态渲染
  });

  test("全空输入（无 run / 无结果 / args=null / live=false）→ 中性完成态不崩", () => {
    const html = renderCard({ toolCallId: "call_nothing", name: "unknown", args: null });
    expect(html).toContain("完成");
    expect(html).toContain("unknown");
  });

  test("未知工具完成 + 对象结果（异形结构）→ pretty JSON 兜底渲染不崩", () => {
    useMessagesStore.getState().applyWireEvent(SID, UNKNOWN_START);
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "tool_execution_end",
      toolCallId: UNKNOWN_START.toolCallId,
      result: { weird: ["shapes", 1, true] },
    });
    const html = renderCard({ toolCallId: UNKNOWN_START.toolCallId, name: UNKNOWN_START.toolName, args: UNKNOWN_START.args });
    expect(html).toContain("完成");
    expect(html).not.toContain("运行中");
  });
});
