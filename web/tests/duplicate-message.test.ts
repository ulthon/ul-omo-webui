// docs08-r5 任务 4：用户消息双列修复验收（store 级，与任务 3 诊断同口径）。
//
// 根因（.omo/evidence/docs08-r5/task-3-diagnosis.md 定案，confirmed）：引擎 wire 消息帧
// 全程不携带条目 id，前端对携真实 id 的 entry_appended 帧不入列——刷新/切回后 SSE 整缓冲
// 重放把已落库的 user 回显重播一遍，REST 真实 id 条目已在槽内，无 id 帧按 syntheticId 落
// 合成 id 孪生，两个 id 空间永不交叉，且每次刷新确定性重演（"刷新不消失"）。
//
// 修复：无 id 帧落合成 id 前，若槽内已有同载荷身份的 user 条目（message 全载荷指纹，
// 含引擎端 timestamp——引擎源码实证 user 消息恒带 timestamp: Date.now()，帧 message 与
// 落库条目 message 为同一对象）则跳过入列。这是身份收敛而非内容指纹跨回合去重：
// 同文异回合 timestamp 必异，合法各留一条（任务 5 铁律同源约束）。
//
// 浏览器级复现不可行（诊断同款约束：隔离实例无前端构建）；store 的 entries 即渲染层
// 双列的直接输入，store 级断言为充分证据。
import { beforeEach, describe, expect, test } from "vitest";
import type { WireEntry } from "@/lib/api";
import { useMessagesStore, type WireEvent } from "@/stores/messages";

function resetStores() {
  useMessagesStore.setState({ bySession: {} });
}

const SID = "01a14f75-5cbb-7d44-8cef-b69e11975271";

/** 实录引擎端 timestamp（任务 3 证据 task-3-jsonl-rest-identity.txt L37/L41） */
const TS_A = Date.parse("2026-10-18T15:01:44.070Z"); // ee9c0089
const TS_B = Date.parse("2026-10-18T15:02:00.982Z"); // a3c80155

const TEXT_X = "请从1数到40，每行一个数字，不要输出任何其他内容。";

function userRestEntry(id: string, text: string, timestamp: number): WireEntry {
  return { type: "message", id, message: { role: "user", content: [{ type: "text", text }], timestamp } } as WireEntry;
}

function echoFrames(text: string, timestamp: number): WireEvent[] {
  const msg = { role: "user", content: [{ type: "text", text }], timestamp };
  return [
    { type: "message_start", message: msg },
    { type: "message_end", message: msg },
  ];
}

function userEntriesOf(sessionId: string): WireEntry[] {
  const slot = useMessagesStore.getState().bySession[sessionId];
  if (!slot) return [];
  return slot.entries.filter((e) => {
    const m = e.message as { role?: string } | undefined;
    return m?.role === "user";
  });
}

function isSyntheticId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith("h") && id.includes("-");
}

describe("docs08-r5 任务 4：用户消息双列修复（载荷身份收敛）", () => {
  beforeEach(resetStores);

  test("刷新/切回孪生不复现：REST 真相 + 重放同文回显恒单条（实录帧含 timestamp）", () => {
    useMessagesStore.getState().setEntries(SID, [userRestEntry("ee9c0089", TEXT_X, TS_A)], "ee9c0089", "ee9c0089");
    for (const ev of echoFrames(TEXT_X, TS_A)) useMessagesStore.getState().applyWireEvent(SID, ev);
    const users = userEntriesOf(SID);
    expect(users.length).toBe(1);
    expect(users[0].id).toBe("ee9c0089"); // 真实 id 真相保留
  });

  test("刷新重演确定序列不累积（刷新不消失回归）：两次载入+重放循环均单条", () => {
    for (let round = 0; round < 2; round++) {
      // 每轮模拟一次页面重载：store 重置 → REST 全量载入 → SSE 重放窗口回显
      resetStores();
      useMessagesStore.getState().setEntries(SID, [userRestEntry("ee9c0089", TEXT_X, TS_A)], "ee9c0089", "ee9c0089");
      for (const ev of echoFrames(TEXT_X, TS_A)) useMessagesStore.getState().applyWireEvent(SID, ev);
      expect(userEntriesOf(SID).length).toBe(1);
    }
  });

  test("同文异回合合法保留：两条同文本用户消息（timestamp 异）重放后互不坍缩", () => {
    // 用户先后两次发送同一文本：引擎各落一条（不同 timestamp），重放各自回显
    useMessagesStore
      .getState()
      .setEntries(
        SID,
        [userRestEntry("ee9c0089", TEXT_X, TS_A), userRestEntry("a3c80155", TEXT_X, TS_B)],
        "a3c80155",
        "a3c80155",
      );
    for (const ev of [...echoFrames(TEXT_X, TS_A), ...echoFrames(TEXT_X, TS_B)])
      useMessagesStore.getState().applyWireEvent(SID, ev);
    const users = userEntriesOf(SID);
    expect(users.length).toBe(2); // 两条历史回合都保留，不因同文被内容去重
    expect(new Set(users.map((e) => e.id))).toEqual(new Set(["ee9c0089", "a3c80155"]));
  });

  test("无 id 回显 start/end 双帧幂等：载荷（含 timestamp）原样保留为单条", () => {
    // live 首见路径：无 REST 真相可收敛，start/end 双帧同载荷按合成 id 幂等，单条入列
    for (const ev of echoFrames(TEXT_X, TS_A)) useMessagesStore.getState().applyWireEvent(SID, ev);
    const users = userEntriesOf(SID);
    expect(users.length).toBe(1);
    expect(isSyntheticId(users[0].id)).toBe(true);
    const m = users[0].message as { timestamp?: unknown };
    expect(m.timestamp).toBe(TS_A); // 载荷原样保留——后续刷新时 REST 真相可按同载荷收敛
  });

  test("身份信号缺失（无 timestamp 帧）不启用载荷收敛：保持既有入列路径不冒进去重", () => {
    // 老数据/异常载荷（无 timestamp）身份不完整：宁可短暂双显交 setEntries 全量重取
    // 兜底，也不启用退化成内容指纹的去重（任务 5 铁律同源）
    useMessagesStore
      .getState()
      .setEntries(
        SID,
        [{ type: "message", id: "old00001", message: { role: "user", content: [{ type: "text", text: "旧格式" }] } } as WireEntry],
        "old00001",
        "old00001",
      );
    const msg = { role: "user", content: [{ type: "text", text: "旧格式" }] };
    useMessagesStore.getState().applyWireEvent(SID, { type: "message_start", message: msg });
    useMessagesStore.getState().applyWireEvent(SID, { type: "message_end", message: msg });
    expect(userEntriesOf(SID).length).toBe(2); // 旧行为保持：合成孪生由下次全量重取整替
  });

  test("live 排队占位与守卫共存：同文占位被回显吸收后不落孪生，REST 真相保持唯一", () => {
    // 场景：排队占位仍在槽时发生全量重取（REST 真相同文在槽）后回显帧到达。
    // 公共 API 造不出该共存态（r4 语义：槽内已有同文本服务端消息时抑制占位创建），
    // 直接构造槽态钉住顺序语义：占位吸收先于守卫——守卫跳过入列时占位吸收仍生效，
    // 不残留排队徽标（spike (b)-7 语义不回退）。
    const placeholder = {
      type: "message",
      id: "local-abc123",
      message: { role: "user", content: [{ type: "text", text: TEXT_X }] },
      queued: { mode: "followUp" },
    } as WireEntry;
    useMessagesStore.setState({
      bySession: {
        [SID]: {
          entries: [userRestEntry("ee9c0089", TEXT_X, TS_A), placeholder],
          cursor: "ee9c0089",
          leafId: "ee9c0089",
          loaded: true,
          streaming: false,
          streamingMessage: null,
          streamingEntryId: null,
          toolRuns: {},
        },
      },
    });
    expect(userEntriesOf(SID).length).toBe(2); // 真相 + 排队占位共存（构造态自检）
    for (const ev of echoFrames(TEXT_X, TS_A)) useMessagesStore.getState().applyWireEvent(SID, ev);
    const users = userEntriesOf(SID);
    expect(users.length).toBe(1);
    expect(users[0].id).toBe("ee9c0089");
    expect(users.some((e) => "queued" in e)).toBe(false); // 占位吸收后排队标记消失
  });
});
