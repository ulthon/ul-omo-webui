// 消息 store 分支路径接线单测（session-branching todo 4）：合成孪生/本地乐观占位
// 创建时 parentId 注入与 leafId 推进（F5 关键坑：合成条目掉出路径=消息消失）；
// absorb/adopt/stripSyntheticTwins 收敛链行为不变，仅叶随真值推进。纯 store 操作，
// 无时序无 DOM。环境说明同 messages-paging.test.ts：@ts-nocheck + 动态 import。
// @ts-nocheck
import { describe, expect, test, beforeEach } from "vitest";

const { useMessagesStore } = await import("@/stores/messages");
const { derivePathEntryIds, filterEntriesToPath } = await import("@/components/chat/branch-path-data");

const SID = "t4-branch-path";

function msgEntry(id, parentId, role = "user", text = id) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }] },
  };
}

beforeEach(() => {
  useMessagesStore.setState({ bySession: {} });
});

const st = () => useMessagesStore.getState().bySession[SID];

/** 渲染窗等价物（chat-view messageEntries 同构消费）：路径过滤后的 id 序列 */
const pathRendered = () => {
  const s = st();
  return filterEntriesToPath(s.entries, s.viewLeafId, s.leafId, () => true).windowEntries.map((e) => e.id);
};

describe("乐观占位与直发首条（F5：不消失）", () => {
  test("空会话直发首条：占位挂根（无尾=parentId null）并即时成为当前叶，路径含占位", () => {
    useMessagesStore.getState().appendLocalUserEntry(SID, "你好");
    const s = st();
    const local = s.entries[0];
    expect(local.id.startsWith("local-")).toBe(true);
    expect(local.parentId).toBe(null);
    expect(s.leafId).toBe(local.id);
    const path = derivePathEntryIds(s.entries, s.leafId);
    expect(path.leafFound).toBe(true);
    expect(path.ids.has(local.id)).toBe(true); // 渲染在场=不消失
  });

  test("有历史会话乐观占位：挂当前尾条并推叶，路径含占位与全部历史", () => {
    useMessagesStore
      .getState()
      .setEntries(SID, [msgEntry("u1", null), msgEntry("a1", "u1", "assistant")], "a1", "a1");
    useMessagesStore.getState().appendLocalUserEntry(SID, "第二条");
    const s = st();
    const local = s.entries[s.entries.length - 1];
    expect(local.parentId).toBe("a1");
    expect(s.leafId).toBe(local.id);
    expect(pathRendered()).toEqual(["u1", "a1", local.id]);
  });
});

describe("吸收与孪生收敛（stale_state：乐观占位 vs 真值竞态）", () => {
  test("服务端 user 回显吸收占位：叶随真值推进不悬空，end 帧真 id 再收敛，无双列", () => {
    useMessagesStore
      .getState()
      .setEntries(SID, [msgEntry("u1", null), msgEntry("a1", "u1", "assistant")], "a1", "a1");
    useMessagesStore.getState().appendLocalUserEntry(SID, "第二条");
    const localId = st().entries[st().entries.length - 1].id;
    // 无 id start 帧（真实通路：SSE message 通道）
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "第二条" }], timestamp: 1 },
    });
    let s = st();
    expect(s.entries.some((e) => e.id === localId)).toBe(false); // 占位被吸收（既有链）
    const twin = s.entries.find((e) => e.id.startsWith("h"));
    expect(twin).toBeTruthy();
    expect(twin.parentId).toBe("a1"); // 合成孪生挂尾条
    expect(s.leafId).toBe(twin.id); // 叶随真值推进（不再悬空）
    // end 帧携真 id：孪生收敛为真实 id，叶再推进
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "message_end",
      id: "srv-u2",
      message: { role: "user", content: [{ type: "text", text: "第二条" }], timestamp: 1 },
    });
    s = st();
    expect(s.entries.some((e) => e.id === twin.id)).toBe(false);
    expect(s.entries.some((e) => e.id === "srv-u2")).toBe(true);
    expect(s.leafId).toBe("srv-u2");
    expect(pathRendered()).toEqual(["u1", "a1", "srv-u2"]); // 无双列、路径完整
  });

  test("流式 assistant 定格孪生挂尾条，entry_appended 真值收敛推叶", () => {
    useMessagesStore.getState().setEntries(SID, [msgEntry("u1", null)], "u1", "u1");
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "回答" }] },
    });
    let s = st();
    const twin = s.entries.find((e) => e.id.startsWith("h"));
    expect(twin).toBeTruthy();
    expect(twin.parentId).toBe("u1");
    expect(s.leafId).toBe(twin.id);
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "entry_appended",
      entry: msgEntry("a-1", "u1", "assistant", "回答"),
    });
    s = st();
    expect(s.entries.filter((e) => (e.message || {}).role === "assistant").length).toBe(1); // 无双列
    expect(s.leafId).toBe("a-1");
    expect(pathRendered()).toEqual(["u1", "a-1"]);
  });
});

describe("离径与重放（视图稳定）", () => {
  test("离径追加（他端分支操作）不拽当前叶，兄弟条目被路径过滤隐藏（IS-1）", () => {
    useMessagesStore.getState().setEntries(
      SID,
      [
        msgEntry("u1", null),
        msgEntry("a1", "u1", "assistant"),
        msgEntry("u2", "a1"),
        msgEntry("a2", "u2", "assistant"),
      ],
      "a2",
      "a2",
    );
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "entry_appended",
      entry: msgEntry("u2x", "a1", "user", "兄弟分支消息"),
    });
    const s = st();
    expect(s.leafId).toBe("a2"); // 视图不拽
    expect(pathRendered()).toEqual(["u1", "a1", "u2", "a2"]); // 兄弟条目不在渲染窗
  });

  test("重放窗内无流式态的 end 帧回放（旧消息孪生伪影）不挂路径不推叶", () => {
    useMessagesStore
      .getState()
      .setEntries(SID, [msgEntry("u1", null), msgEntry("a1", "u1", "assistant")], "a1", "a1");
    useMessagesStore.getState().beginReplayRecovery();
    useMessagesStore.getState().applyWireEvent(SID, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "重放的旧回答" }] },
    });
    useMessagesStore.getState().endReplayRecovery();
    const s = st();
    expect(s.leafId).toBe("a1"); // 伪影不推叶
    const artifact = s.entries.find(
      (e) => (e.message || {}).role === "assistant" && e.message.content[0].text === "重放的旧回答",
    );
    expect(artifact).toBeTruthy(); // 既有伪影行为保留（后续 entry_appended 收敛）
    expect(artifact.parentId).toBeUndefined(); // 不挂路径
    expect(pathRendered()).toEqual(["u1", "a1"]); // 伪影不在当前路径渲染窗
  });
});

describe("REST 增量与全量整替", () => {
  test("appendEntries 增量窗延伸路径推叶；重放回填与离径不推", () => {
    useMessagesStore.getState().setEntries(SID, [msgEntry("u1", null)], "u1", "u1");
    useMessagesStore.getState().appendEntries(SID, [msgEntry("a9", "u1", "assistant")]);
    expect(st().leafId).toBe("a9");
    useMessagesStore.getState().appendEntries(SID, [msgEntry("a9", "u1", "assistant")]); // 幂等回填
    expect(st().leafId).toBe("a9");
    useMessagesStore.getState().appendEntries(SID, [msgEntry("x1", "ghost", "user")]); // 离径（父不在场）
    expect(st().leafId).toBe("a9");
  });

  test("setEntries 全量整替：viewLeafId 仍在文件中保留、消失回落 null（todo 6 契约）", () => {
    useMessagesStore
      .getState()
      .setEntries(SID, [msgEntry("u1", null), msgEntry("a1", "u1", "assistant")], "a1", "a1");
    // 模拟 todo 6 叶切换后的显式视图叶
    useMessagesStore.setState({ bySession: { [SID]: { ...st(), viewLeafId: "u1" } } });
    useMessagesStore
      .getState()
      .setEntries(SID, [msgEntry("u1", null), msgEntry("a1", "u1", "assistant")], "a1", "a1");
    expect(st().viewLeafId).toBe("u1"); // 仍在文件中：保留
    useMessagesStore.getState().setEntries(SID, [msgEntry("u2", null)], "u2", "u2");
    expect(st().viewLeafId).toBe(null); // 消失：回落跟随文件叶
  });
});
