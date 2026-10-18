// docs08-r5 任务 3 诊断复现测试：用隔离实例实录的 wire 帧语义
// （引擎 5.1.0：message_start/message_end 全程无 id，真实条目 id 仅出现在
// entry_appended，前端对非记忆类 entry_appended 不入列）驱动真实 messages store。
// 失败序列对应 .omo/evidence/docs08-r5/task-3-diagnosis.md 症状 A/B 定案（三档：
// confirmed——帧级实证 + 本测试确定性复现）。
// 症状 B（用户消息双列）已随任务 4 修复反转为验收断言（恒单条）；症状 A（assistant
// 末段重播+双列）保持锁定原失败序列，待任务 5 修复后反转为验收断言。
// 实录载荷修正（任务 4 实施时对齐引擎源码事实）：user 消息对象恒携引擎端 timestamp
// （Date.now()，帧 message 与落库条目 message 同一对象），帧/REST 载荷指纹含之。
import { beforeEach, describe, expect, test } from "vitest";
import type { WireEntry } from "@/lib/api";
import { useMessagesStore, type WireEvent } from "@/stores/messages";

function resetStores() {
  useMessagesStore.setState({ bySession: {} });
}

const SID = "01a14f75-5cbb-7d44-8cef-b69e11975271";

/** 实录 L37 ee9c0089 的引擎端 timestamp（帧 message 与 REST 条目 message 同一对象） */
const USER_ECHO_TS = Date.parse("2026-10-18T15:01:44.070Z");

/** 隔离实例实录形态：REST GET messages 返回的真实 id 条目（引擎 JSONL 同构） */
function restEntries(): WireEntry[] {
  return [
    {
      type: "message",
      id: "ee9c0089",
      message: {
        role: "user",
        content: [{ type: "text", text: "请从1数到40，每行一个数字，不要输出任何其他内容。" }],
        timestamp: USER_ECHO_TS,
      },
    },
    {
      type: "message",
      id: "4a6479d9",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Output numbers" },
          { type: "text", text: "1\n2\n3" },
        ],
      },
    },
  ] as WireEntry[];
}

/** 隔离实例实录形态：重放帧（probe3 帧 9200-9302 的语义还原——无任何 id 字段） */
function replayedEchoFrames(): WireEvent[] {
  const msgUser = {
    role: "user",
    content: [{ type: "text", text: "请从1数到40，每行一个数字，不要输出任何其他内容。" }],
    timestamp: USER_ECHO_TS,
  };
  return [
    { type: "message_start", message: msgUser },
    { type: "message_end", message: msgUser },
  ];
}

function replayedAssistantFrames(): WireEvent[] {
  const start = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "Output numbers" }],
    stopReason: "pending",
  };
  const end = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Output numbers" },
      { type: "text", text: "1\n2\n3" },
    ],
    stopReason: "stop",
  };
  return [
    { type: "message_start", message: start },
    { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "1\n2\n3" } },
    { type: "message_end", message: end },
  ];
}

function textsOf(sessionId: string): string[] {
  const slot = useMessagesStore.getState().bySession[sessionId];
  if (!slot) return [];
  const out: string[] = [];
  for (const e of slot.entries) {
    const m = e.message as { role?: string; content?: Array<{ text?: string }> } | undefined;
    if (m?.role === "user") out.push(`user:${m.content?.[0]?.text ?? ""}`);
    if (m?.role === "assistant") out.push(`assistant:${m.content?.map((p: { text?: string }) => p.text ?? "").join("") ?? ""}`);
  }
  if (slot.streamingMessage) {
    out.push(
      `streaming:${
        slot.streamingMessage.content
          ?.map((p: Record<string, unknown>) =>
            typeof p.text === "string" ? p.text : typeof p.thinking === "string" ? p.thinking : "",
          )
          .join("") ?? ""
      }`,
    );
  }
  return out;
}

describe("docs08-r5 任务 3 诊断：REST+重放双摄入合成孪生（只锁定不修复）", () => {
  beforeEach(resetStores);

  test("症状 B（任务 4 修复验收）：REST 真相载入后重放无 id user 回显帧 → 用户消息恒单条", () => {
    // 刷新后第一步：chat-view 全量载入 REST 真相（真实 id）
    useMessagesStore.getState().setEntries(SID, restEntries(), "4a6479d9", "4a6479d9");
    expect(textsOf(SID).filter((t) => t.startsWith("user:")).length).toBe(1);
    // 第二步：SSE 新连接（无 Last-Event-ID）重放环形缓冲中的 user 回显帧（无 id，实录形态）
    for (const ev of replayedEchoFrames()) useMessagesStore.getState().applyWireEvent(SID, ev);
    // 修复验收：无 id 帧按载荷身份（含引擎端 timestamp）与 REST 真实 id 条目收敛，
    // 不落合成 id 孪生——同文本用户条目恒单条（任务 3 诊断：双列的成因定案）
    const userTexts = textsOf(SID).filter((t) => t.startsWith("user:"));
    expect(userTexts.length).toBe(1);
    const slot = useMessagesStore.getState().bySession[SID];
    const ids = slot.entries.map((e: { id?: unknown }) => e.id);
    expect(ids).toContain("ee9c0089"); // REST 真实 id 真相保留
    expect(ids.some((i: unknown) => typeof i === "string" && i.startsWith("h") && i.includes("-"))).toBe(false); // 无合成 id 孪生
  });

  test("症状 A：REST 真相载入后重放已完成 assistant 段帧 → 回复双列 + 重播", () => {
    useMessagesStore.getState().setEntries(SID, restEntries(), "4a6479d9", "4a6479d9");
    for (const ev of replayedAssistantFrames()) useMessagesStore.getState().applyWireEvent(SID, ev);
    const slot = useMessagesStore.getState().bySession[SID];
    // 重放期间：REST 完整副本 + streamingMessage 重播副本并存（用户看到的"重播一遍"）
    const assistantTexts: string[] = textsOf(SID).filter((t) => t.startsWith("assistant:"));
    expect(assistantTexts.length).toBe(2); // 定格后合成孪生追加（upsertEntry 按 id 不可去重）
    expect(slot.streamingMessage).toBeNull(); // message_end 已 settle
    const ids = slot.entries.map((e: { id?: unknown }) => e.id);
    expect(ids).toContain("4a6479d9");
    expect(ids.length).toBe(3); // user + assistant(真实id) + assistant(合成id)
  });

  test("live 路径不双列（对照组）：占位先入，无 id 回显到达即吸收为单条", () => {
    // 发送成功 → 本地乐观占位
    useMessagesStore.getState().appendLocalUserEntry(SID, "请从1数到40，每行一个数字，不要输出任何其他内容。");
    expect(textsOf(SID).length).toBe(1);
    // 回合启动的服务端回显（无 id，实录形态）→ 吸收占位，合成 id 单条
    for (const ev of replayedEchoFrames()) useMessagesStore.getState().applyWireEvent(SID, ev);
    const userTexts = textsOf(SID).filter((t) => t.startsWith("user:"));
    expect(userTexts.length).toBe(1);
  });
});
