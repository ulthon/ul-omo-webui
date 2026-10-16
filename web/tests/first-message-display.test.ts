// 缺陷修复单测（新会话首条用户消息不显示）：
// - appendLocalUserEntry：发送成功后本地乐观占位（text + 图片 parts、user 角色、local-* id）
// - applyWireEvent user 分支：服务端 user 消息事件吸收等价本地占位（防双列）
// - adoptDurableId：消息槽换 key（直接搬家 / 空壳合并 / 事件先到真值优先 + 占位防丢）
// - adoptSessionId：会话行 id、selectedId、runStates 一并迁移
import { beforeEach, describe, expect, test } from "bun:test";
import type { SessionListItem, WireEntry } from "@/lib/api";
import { useMessagesStore } from "@/stores/messages";
import { useSessionsStore } from "@/stores/sessions";

function resetStores() {
  useMessagesStore.setState({ bySession: {} });
  useSessionsStore.setState({ byProject: {}, runStates: {}, selectedId: null });
}

function makeSession(id: string): SessionListItem {
  return {
    id,
    path: `/store/sessions/${id}.jsonl`,
    project: "/p",
    title: id,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
  };
}

type LocalMessage = {
  type: string;
  id?: string;
  message?: { role?: string; content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
};

function asLocal(entry: WireEntry): LocalMessage {
  return entry as unknown as LocalMessage;
}

describe("缺陷修复：新会话首条用户消息", () => {
  beforeEach(resetStores);

  test("appendLocalUserEntry：本地乐观用户条目（文本 + 图片 parts）", () => {
    useMessagesStore.getState().appendLocalUserEntry("holder-1", "你好", [
      { data: "aGk=", mimeType: "image/png" },
    ]);
    const slot = useMessagesStore.getState().bySession["holder-1"];
    expect(slot).toBeDefined();
    expect(slot.entries.length).toBe(1);
    const entry = asLocal(slot.entries[0]);
    expect(entry.type).toBe("message");
    expect(entry.id?.startsWith("local-")).toBe(true);
    expect(entry.message?.role).toBe("user");
    expect(entry.message?.content?.[0]).toEqual({ type: "text", text: "你好" });
    expect(entry.message?.content?.[1]).toEqual({ type: "image", data: "aGk=", mimeType: "image/png" });
  });

  test("appendLocalUserEntry：同文本重复占位各自独立（不同 local id）", () => {
    useMessagesStore.getState().appendLocalUserEntry("s", "同文本");
    useMessagesStore.getState().appendLocalUserEntry("s", "同文本");
    expect(useMessagesStore.getState().bySession["s"].entries.length).toBe(2);
  });

  test("服务端 user 事件吸收等价本地占位（防双列），非等价并存", () => {
    useMessagesStore.getState().appendLocalUserEntry("d-1", "第一条");
    useMessagesStore
      .getState()
      .applyWireEvent("d-1", {
        type: "message_start",
        id: "srv-u1",
        message: { role: "user", content: [{ type: "text", text: "第一条" }] },
      });
    let slot = useMessagesStore.getState().bySession["d-1"];
    expect(slot.entries.length).toBe(1);
    expect(asLocal(slot.entries[0]).id).toBe("srv-u1");

    // 文本不同的服务端 user 事件不吸收（并存，由全量重取收敛）
    useMessagesStore.getState().appendLocalUserEntry("d-1", "占位");
    useMessagesStore
      .getState()
      .applyWireEvent("d-1", {
        type: "message_start",
        id: "srv-u2",
        message: { role: "user", content: [{ type: "text", text: "另一条" }] },
      });
    slot = useMessagesStore.getState().bySession["d-1"];
    expect(slot.entries.length).toBe(3); // srv-u1 + local 占位 + srv-u2
  });

  // 缺陷回归（2026-10-15 实测复现：用户消息气泡闪现即消失）：
  // 引擎对 user 消息发 message_start/message_end 对 + entry_appended（真条目被
  // 记忆白名单丢弃）；message_end(user) 事件对象若按原样入列，type="message_end"
  // 会被渲染层 isMessageEntry（只认 type:"message"）过滤——吸收已删本地乐观占位，
  // 净效果 = 用户消息不可见。入列必须归一为 type:"message"（settle 定格同构）。
  test("服务端 user 事件入列条目须归一为可渲染的 type:\"message\"（带事件 id）", () => {
    useMessagesStore.getState().appendLocalUserEntry("d-2", "首条");
    useMessagesStore.getState().applyWireEvent("d-2", {
      type: "message_end",
      id: "srv-x1",
      message: { role: "user", content: [{ type: "text", text: "首条" }] },
    });
    const slot = useMessagesStore.getState().bySession["d-2"];
    expect(slot.entries.length).toBe(1);
    const entry = asLocal(slot.entries[0]);
    expect(entry.type).toBe("message");
    expect(entry.id).toBe("srv-x1");
    expect(entry.message?.role).toBe("user");
    expect(entry.message?.content?.[0]).toEqual({ type: "text", text: "首条" });
  });

  test("服务端 user 事件无 id 时回落确定性合成 id（start/end 双帧幂等去重）", () => {
    const msg = { role: "user", content: [{ type: "text", text: "同一条" }] };
    useMessagesStore.getState().applyWireEvent("d-3", { type: "message_start", message: msg });
    useMessagesStore.getState().applyWireEvent("d-3", { type: "message_end", message: msg });
    const slot = useMessagesStore.getState().bySession["d-3"];
    expect(slot.entries.length).toBe(1);
    expect(asLocal(slot.entries[0]).type).toBe("message");
    expect(asLocal(slot.entries[0]).id).toMatch(/^h[0-9a-z]+-\d+$/);
  });

  // 缺陷回归（2026-10-16 首条消息白屏：e.map is not a function）：
  // 引擎首回合经 message 通道注入引导 custom 消息（senpi-task.usage / environment-context
  // 等，帧级实测 content 为字符串、无帧 id）。归一化分支曾把所有非 assistant 角色入列
  // 成 type:"message"，渲染层 PartsView(message.content) 收到字符串即崩（白屏）。
  // 修复口径：非 assistant 分支只放行 user——custom 不入列（记忆标记走 entry_appended
  // 白名单携真 id，message 通道是同义无 id 帧）；toolResult 同口径不入列（结果由
  // ToolCard 按 toolCallId 关联展示）。
  test("custom 字符串 content / toolResult 消息帧不入列（防 PartsView 崩溃白屏）", () => {
    useMessagesStore.getState().applyWireEvent("d-4", {
      type: "message_start",
      message: { role: "custom", customType: "senpi-task.usage", content: "<omo-senpi-task>背景任务…</omo-senpi-task>" },
    });
    useMessagesStore.getState().applyWireEvent("d-4", {
      type: "message_end",
      message: { role: "custom", customType: "senpi-task.usage", content: "<omo-senpi-task>背景任务…</omo-senpi-task>" },
    });
    useMessagesStore.getState().applyWireEvent("d-4", {
      type: "message_end",
      id: "srv-tr1",
      message: { role: "toolResult", content: [{ type: "text", text: "工具结果" }] },
    });
    const slot = useMessagesStore.getState().bySession["d-4"];
    expect(slot?.entries.length ?? 0).toBe(0);
  });

  // 缺陷回归（2026-10-16 用户消息双列）：直发的 SSE echo 帧可能先于 POST 回执到达
  // （本机实测）——彼时等价用户消息已按合成 id 入列，回执后再补乐观占位已无后续帧
  // 可吸收，成永久双列。修复：appendLocalUserEntry 入列前等价甄别，槽内已存在同首
  // 文本用户消息则跳过占位（与 absorbLocalUserEntries 口径一致）。
  test("echo 帧先于回执到达时，乐观占位等价跳过（防双列）", () => {
    const msg = { role: "user", content: [{ type: "text", text: "竞态消息" }] };
    useMessagesStore.getState().applyWireEvent("d-5", { type: "message_start", message: msg });
    useMessagesStore.getState().applyWireEvent("d-5", { type: "message_end", message: msg });
    useMessagesStore.getState().appendLocalUserEntry("d-5", "竞态消息");
    const slot = useMessagesStore.getState().bySession["d-5"];
    expect(slot.entries.length).toBe(1);
    expect(asLocal(slot.entries[0]).id).toMatch(/^h[0-9a-z]+-\d+$/);
    expect(asLocal(slot.entries[0]).message?.role).toBe("user");
  });

  // 双帧混合 id 形态（2026-10-16 双列加固）：start 无 id（合成 id 入列）、end 携真 id
  // ——入列真 id 条目前先移除合成 id 孪生，防同一条消息双列。
  test("start 无 id / end 携真 id 混合形态：合成孪生被移除（防双列）", () => {
    const msg = { role: "user", content: [{ type: "text", text: "混合形态" }] };
    useMessagesStore.getState().applyWireEvent("d-6", { type: "message_start", message: msg });
    useMessagesStore.getState().applyWireEvent("d-6", { type: "message_end", id: "srv-real", message: msg });
    const slot = useMessagesStore.getState().bySession["d-6"];
    expect(slot.entries.length).toBe(1);
    expect(asLocal(slot.entries[0]).id).toBe("srv-real");
  });

  test("同文本双条排队：服务端事件逐条吸收，一次事件只吞一条占位（spike (b)-7 去重键加固）", () => {
    // 两条同文本排队占位（引擎不去重，磁盘四行——两条独立 user 条目 + 各自回复）
    useMessagesStore.getState().appendLocalUserEntry("d-1", "同文本", undefined, "followUp");
    useMessagesStore.getState().appendLocalUserEntry("d-1", "同文本", undefined, "followUp");
    expect(useMessagesStore.getState().bySession["d-1"].entries.length).toBe(2);

    // 第一条投递（message_end role=user）：只吸收一条（剩余占位在前，服务端真值 append 在尾）
    useMessagesStore.getState().applyWireEvent("d-1", {
      type: "message_end",
      id: "srv-q1",
      message: { role: "user", content: [{ type: "text", text: "同文本" }] },
    });
    let slot = useMessagesStore.getState().bySession["d-1"];
    expect(slot.entries.length).toBe(2);
    expect(asLocal(slot.entries[0]).id?.startsWith("local-")).toBe(true);
    expect(asLocal(slot.entries[1]).id).toBe("srv-q1");

    // 第二条投递：吸收最后一条占位，无残留无重复
    useMessagesStore.getState().applyWireEvent("d-1", {
      type: "message_end",
      id: "srv-q2",
      message: { role: "user", content: [{ type: "text", text: "同文本" }] },
    });
    slot = useMessagesStore.getState().bySession["d-1"];
    expect(slot.entries.length).toBe(2);
    expect(asLocal(slot.entries[0]).id).toBe("srv-q1");
    expect(asLocal(slot.entries[1]).id).toBe("srv-q2");
  });

  test("排队占位带 queued 标记；撤销移除只删排队占位（removeQueuedLocalEntry 首条 / removeAll 全清）", () => {
    useMessagesStore.getState().appendLocalUserEntry("d-1", "排队甲", undefined, "steer");
    useMessagesStore.getState().appendLocalUserEntry("d-1", "排队甲", undefined, "followUp");
    useMessagesStore.getState().appendLocalUserEntry("d-1", "普通占位");
    let entries = useMessagesStore.getState().bySession["d-1"].entries;
    expect(entries.filter((e) => (e as { queued?: unknown }).queued !== undefined).length).toBe(2);

    // 单条撤销：同文本取首条，普通占位不动
    useMessagesStore.getState().removeQueuedLocalEntry("d-1", "排队甲");
    entries = useMessagesStore.getState().bySession["d-1"].entries;
    expect(entries.length).toBe(2);
    expect((entries[0] as { queued?: unknown }).queued).toEqual({ mode: "followUp" });
    expect(asLocal(entries[1]).id?.startsWith("local-")).toBe(true);

    // 整队清空：全部排队占位移除，普通占位保留
    useMessagesStore.getState().removeAllQueuedLocalEntries("d-1");
    entries = useMessagesStore.getState().bySession["d-1"].entries;
    expect(entries.length).toBe(1);
    expect(asLocal(entries[0]).message?.content?.[0]).toEqual({ type: "text", text: "普通占位" });
  });

  test("adoptDurableId：目标槽不存在时直接搬家（含流式态）", () => {
    useMessagesStore.getState().appendLocalUserEntry("holder-1", "第一条");
    useMessagesStore.getState().setStreaming("holder-1", true);
    useMessagesStore.getState().adoptDurableId("holder-1", "d-1");
    const s = useMessagesStore.getState();
    expect(s.bySession["holder-1"]).toBeUndefined();
    expect(s.bySession["d-1"].entries.length).toBe(1);
    expect(s.bySession["d-1"].streaming).toBe(true);
  });

  test("adoptDurableId：事件先到（真值优先），本地占位补头部防丢", () => {
    useMessagesStore.getState().appendLocalUserEntry("holder-1", "第一条");
    const serverAssistant: WireEntry = {
      type: "message",
      id: "srv-1",
      message: { role: "assistant", content: [{ type: "text", text: "回复" }] },
    };
    useMessagesStore.getState().appendEntries("d-1", [serverAssistant]);
    useMessagesStore.getState().adoptDurableId("holder-1", "d-1");
    const slot = useMessagesStore.getState().bySession["d-1"];
    expect(slot.entries.length).toBe(2);
    expect(asLocal(slot.entries[0]).message?.role).toBe("user");
    expect(slot.entries[1]).toBe(serverAssistant);
  });

  test("adoptDurableId：oldId 无槽或新旧相同则无操作", () => {
    useMessagesStore.getState().adoptDurableId("nope", "d-1");
    expect(Object.keys(useMessagesStore.getState().bySession).length).toBe(0);
    useMessagesStore.getState().appendLocalUserEntry("d-1", "x");
    useMessagesStore.getState().adoptDurableId("d-1", "d-1");
    expect(useMessagesStore.getState().bySession["d-1"].entries.length).toBe(1);
  });

  test("adoptSessionId：行 id、selectedId、runStates 一并迁移", () => {
    useSessionsStore.getState().setSessions("/p", [makeSession("holder-1"), makeSession("other")]);
    useSessionsStore.getState().select("holder-1");
    useSessionsStore.getState().setRunState("holder-1", "running");
    useSessionsStore.getState().adoptSessionId("holder-1", "d-real-1");
    const s = useSessionsStore.getState();
    expect(s.selectedId).toBe("d-real-1");
    expect(s.byProject["/p"][0].id).toBe("d-real-1");
    expect(s.byProject["/p"][1].id).toBe("other");
    expect(s.runStates["d-real-1"]).toBe("running");
    expect(s.runStates["holder-1"]).toBeUndefined();
  });
});
