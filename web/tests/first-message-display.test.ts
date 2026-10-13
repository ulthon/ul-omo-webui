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
