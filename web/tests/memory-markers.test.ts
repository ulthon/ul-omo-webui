// 记忆标记（docs08-r4 任务 13）单测：白名单甄别（entry_appended 放行与渲染共用）、
// docs08-r6 任务 9：白名单改命名空间前缀匹配（共享匹配函数 isMemoryCustomType，匹配宽渲染窄）、
// 召回条目（custom_message recall）派生与 SSE/REST 两路渲染断言、
// 两通道条目形态（历史 type:"custom"/"custom_message" 与实时 entry_appended 载荷 /
// message_end role=custom）派生同构标记、mergeMemoryItems 流内归并、store 入列白名单、
// EventsClient 具名帧真实路径（HANDLED_EVENT_TYPES 漏列则 EventSource 不派发，任务 11 教训）。
// 条目样例取自 spike 隔离实例 GET messages 实拍（r4-mem-proj 会话）。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  isMemoryAppendedEntry,
  isMemoryCustomEntry,
  isMemoryCustomMessageEntry,
  isMemoryCustomType,
  memoryMarkerOf,
} from "@/lib/memory-entries";
import { dispatchSseEvent, resetDispatchState } from "@/lib/event-dispatch";
import { EventsClient, disconnectEvents } from "@/lib/events";
import { mergeMemoryItems, type ChatListItem } from "@/components/chat/message-items";
import { useMessagesStore } from "@/stores/messages";
import { MockEventSource, MockScheduler } from "./helpers/mock-sse";

/** spike 实拍：GET messages 返回的 custom 条目（type:"custom"，8 位 hex id） */
function customEntry(customType: string, data: Record<string, unknown>, id = "22216a3a") {
  return { type: "custom", id, customType, data };
}

/** spike 实拍：GET messages 返回的 custom_message 条目（role=custom 消息的历史形态） */
function customMessageEntry(customType: string, content: string, display = true) {
  return { type: "custom_message", id: "dd1edd14", customType, content, display, details: {} };
}

/** 实时形态：message_end（message.role="custom"）wire 事件 */
function customMessageEnd(customType: string, content: string) {
  return { type: "message_end", id: "dd1edd14", message: { role: "custom", customType, content } };
}

describe("记忆条目白名单（entry 通道）", () => {
  test("spike 实证三类 memory custom 条目放行", () => {
    expect(
      isMemoryCustomEntry(
        customEntry("senpi-memory.session-binding", {
          identity: "r4-mem-proj-02b644df",
          repoPathHash: "15ab…",
          boundAt: 1791992082828,
        }),
      ),
    ).toBe(true);
    expect(
      isMemoryCustomEntry(customEntry("omo-memory:accepted-turns", { version: 1, priorUserTurns: 1 }, "a0131b65")),
    ).toBe(true);
    expect(
      isMemoryCustomEntry(
        customEntry("omo-memory:projection-pin", { version: 1, revision: null }, "e0b3b089"),
      ),
    ).toBe(true);
  });

  test("白名单外 custom 条目拒绝（spike 同轮实拍的引擎内部状态条目）", () => {
    expect(isMemoryCustomEntry(customEntry("pi-rules.scan", { cwd: "/p", reason: "startup" }, "43ed27eb"))).toBe(false);
    expect(isMemoryCustomEntry(customEntry("senpi.hooks.stop-state", { count: 0 }, "cf5cd724"))).toBe(false);
  });

  test("缺 id / 非 custom 类型拒绝（入列按 id 幂等，无 id 不放行）", () => {
    const e = customEntry("senpi-memory.session-binding", {});
    expect(isMemoryCustomEntry({ ...e, id: undefined })).toBe(false);
    expect(isMemoryCustomEntry({ ...e, type: "custom_message" })).toBe(false);
  });
});

describe("entry_appended 载荷放行门", () => {
  test("custom_message 白名单条目放行（隔离实例实测：携 id 经 entry_appended 到达）", () => {
    const e = { type: "custom_message", id: "22b65471", customType: "omo-kibitzer:nudged", content: "n" };
    expect(isMemoryAppendedEntry(e)).toBe(true);
  });

  test("非白名单 custom_message（omo-model-profile:applied 等）与消息条目拒绝", () => {
    expect(isMemoryAppendedEntry(customMessageEntry("omo-model-profile:applied", "profile…"))).toBe(false);
    expect(isMemoryAppendedEntry(customMessageEntry("environment-context", "<environment_context>…", false))).toBe(false);
    expect(isMemoryAppendedEntry({ type: "message", id: "c77e9b91", message: { role: "user", content: [] } })).toBe(
      false,
    );
  });
});

describe("记忆条目白名单（message 通道）", () => {
  test("历史 custom_message 与实时 message_end 两形态同判（spike 源码枚举三类）", () => {
    for (const ct of ["omo-kibitzer:nudged", "omo-memorian:nudged", "omo-memory:notice"]) {
      expect(isMemoryCustomMessageEntry(customMessageEntry(ct, "提示正文"))).toBe(true);
      expect(isMemoryCustomMessageEntry(customMessageEnd(ct, "提示正文"))).toBe(true);
    }
  });

  test("message_start 不认（start/end 双帧防重，终态以 end 为准）", () => {
    const e = customMessageEnd("omo-memory:notice", "x");
    expect(isMemoryCustomMessageEntry({ ...e, type: "message_start" })).toBe(false);
  });

  test("非 role=custom 的 message_end / 白名单外 customType 拒绝", () => {
    expect(
      isMemoryCustomMessageEntry({
        type: "message_end",
        id: "x1",
        message: { role: "assistant", customType: "omo-memory:notice" },
      }),
    ).toBe(false);
    expect(isMemoryCustomMessageEntry(customMessageEntry("senpi-task.usage", "<omo-senpi-task>…", false))).toBe(false);
    expect(isMemoryCustomMessageEntry(customMessageEntry("environment-context", "<environment_context>…", false))).toBe(
      false,
    );
  });
});

describe("memoryMarkerOf 派生", () => {
  test("session-binding：摘要含 identity，原文为 data JSON（与磁盘 binding 一致）", () => {
    const m = memoryMarkerOf(
      customEntry("senpi-memory.session-binding", { identity: "r4-mem-proj-02b644df", boundAt: 1791992082828 }),
    );
    expect(m).not.toBeNull();
    expect(m?.kind).toBe("sessionBinding");
    expect(m?.weight).toBe("weak");
    expect(m?.summary).toEqual({ key: "chat.memoryMarkers.boundWith", vars: { identity: "r4-mem-proj-02b644df" } });
    expect(m?.detail).toContain("r4-mem-proj-02b644df");
  });

  test("accepted-turns / projection-pin 摘要与权重", () => {
    expect(memoryMarkerOf(customEntry("omo-memory:accepted-turns", {}))?.summary).toEqual({
      key: "chat.memoryMarkers.acceptedTurns",
    });
    expect(memoryMarkerOf(customEntry("omo-memory:projection-pin", {}))?.weight).toBe("weakest");
  });

  test("提示卡三态（message 通道两形态同构，原文取 content）", () => {
    for (const [ct, kind] of [
      ["omo-kibitzer:nudged", "kibitzerNudged"],
      ["omo-memorian:nudged", "memorianNudged"],
      ["omo-memory:notice", "memoryNotice"],
    ] as const) {
      const hist = memoryMarkerOf(customMessageEntry(ct, "nudge 正文"));
      const live = memoryMarkerOf(customMessageEnd(ct, "nudge 正文"));
      expect(hist?.kind).toBe(kind);
      expect(live?.kind).toBe(kind);
      expect(hist?.weight).toBe("notice");
      expect(live?.detail).toBe("nudge 正文");
    }
  });

  test("白名单外条目一律 null（零误报核心）", () => {
    expect(memoryMarkerOf(customEntry("pi-rules.scan", {}))).toBeNull();
    expect(memoryMarkerOf(customMessageEntry("senpi-task.usage", "x", false))).toBeNull();
    expect(memoryMarkerOf({ type: "message", id: "m1", message: { role: "user", content: [] } })).toBeNull();
  });
});

describe("mergeMemoryItems 流内归并", () => {
  const user = { type: "message", id: "u1", message: { role: "user", content: [] } };
  const assistant = { type: "message", id: "a1", message: { role: "assistant", content: [] } };

  test("标记插入其锚定条目位置（条目之后），消息项顺序不变", () => {
    const entries = [
      { type: "custom", id: "c1", customType: "senpi-memory.session-binding", data: {} },
      user,
      { type: "custom", id: "c2", customType: "omo-memory:accepted-turns", data: {} },
      assistant,
    ];
    const items: ChatListItem[] = [
      { key: "u1", kind: "entry", entryId: "u1", interrupted: false },
      { key: "a1", kind: "entry", entryId: "a1", interrupted: false },
    ];
    const merged = mergeMemoryItems(items, entries);
    expect(merged.map((i) => i.key)).toEqual(["memory-c1", "u1", "memory-c2", "a1"]);
  });

  test("streaming 项恒最后；无标记时原样返回（引用不变）", () => {
    const items: ChatListItem[] = [
      { key: "u1", kind: "entry", entryId: "u1", interrupted: false },
      { key: "__streaming", kind: "streaming" },
    ];
    expect(mergeMemoryItems(items, [user])).toBe(items);
    const withMarker = mergeMemoryItems(items, [
      { type: "custom", id: "c1", customType: "omo-memory:accepted-turns", data: {} },
      user,
    ]);
    expect(withMarker.map((i) => i.key)).toEqual(["memory-c1", "u1", "__streaming"]);
  });

  test("sessionBinding 按 identity 渲染去重（引擎每回合重写 binding 条目）", () => {
    const entries = [
      customEntry("senpi-memory.session-binding", { identity: "lib-1" }, "b1"),
      customEntry("senpi-memory.session-binding", { identity: "lib-1" }, "b2"),
      customEntry("senpi-memory.session-binding", { identity: "lib-2" }, "b3"),
    ];
    const merged = mergeMemoryItems([], entries);
    expect(merged.map((i) => (i.kind === "memoryMarker" ? i.marker.entryId : "?"))).toEqual(["b1", "b3"]);
  });

  test("streaming 项无锚点排最后（divider 锚点逻辑已随 B11 退役）", () => {
    const assistantB = { type: "message", id: "a2", message: { role: "assistant", content: [] } };
    const items: ChatListItem[] = [
      { key: "u1", kind: "entry", entryId: "u1", interrupted: false },
      { key: "__streaming", kind: "streaming" },
    ];
    const merged = mergeMemoryItems(items, [
      user,
      assistant,
      { type: "custom", id: "c1", customType: "omo-memory:accepted-turns", data: {} },
      assistantB,
    ]);
    expect(merged.map((i) => i.key)).toEqual(["u1", "memory-c1", "__streaming"]);
  });
});

describe("store entry_appended 白名单入列", () => {
  function frame(wire: Record<string, unknown>, cursor: number, durable = "d-13"): void {
    dispatchSseEvent(String(wire.type), JSON.stringify({ projectPath: "/p", event: wire, durableSessionId: durable }), cursor);
  }

  beforeEach(() => {
    resetDispatchState();
    useMessagesStore.setState({ bySession: {} });
    useMessagesStore.getState().setEntries("d-13", [], null, null);
  });
  afterEach(() => {
    resetDispatchState();
    useMessagesStore.setState({ bySession: {} });
  });

  test("白名单 custom 条目入列；同 id 重放幂等（upsert 不双列）", () => {
    const entry = customEntry("senpi-memory.session-binding", { identity: "lib-1" });
    frame({ type: "entry_appended", entry, sessionId: "rpc-1" }, 1);
    frame({ type: "entry_appended", entry, sessionId: "rpc-1" }, 2);
    const entries = useMessagesStore.getState().bySession["d-13"].entries;
    expect(entries.length).toBe(1);
    expect(memoryMarkerOf(entries[0])?.summary).toEqual({
      key: "chat.memoryMarkers.boundWith",
      vars: { identity: "lib-1" },
    });
  });

  test("非白名单 custom 条目不入列（senpi-task.usage 形态即 spike 列表外类型）", () => {
    frame({ type: "entry_appended", entry: customEntry("pi-rules.scan", {}, "43ed27eb"), sessionId: "rpc-1" }, 1);
    frame({ type: "entry_appended", entry: customEntry("senpi.hooks.stop-state", {}, "cf5cd724"), sessionId: "rpc-1" }, 2);
    expect(useMessagesStore.getState().bySession["d-13"].entries.length).toBe(0);
  });

  test("entry 载荷缺失容错忽略", () => {
    frame({ type: "entry_appended", sessionId: "rpc-1" }, 1);
    frame({ type: "entry_appended", entry: "garbage", sessionId: "rpc-1" }, 2);
    expect(useMessagesStore.getState().bySession["d-13"].entries.length).toBe(0);
  });
});

describe("EventsClient 真实路径：entry_appended 具名帧派发", () => {
  beforeEach(() => {
    MockEventSource.reset();
    resetDispatchState();
    useMessagesStore.setState({ bySession: {} });
    useMessagesStore.getState().setEntries("d-live", [], null, null);
  });
  afterEach(() => {
    useMessagesStore.setState({ bySession: {} });
    disconnectEvents();
    resetDispatchState();
  });

  test("entry_appended 帧经 EventsClient 进 store（HANDLED_EVENT_TYPES 接线）", () => {
    const scheduler = new MockScheduler();
    const client = new EventsClient({
      createEventSource: ((url: string) => new MockEventSource(url)) as unknown as (url: string) => EventSource,
      schedule: scheduler.schedule,
    });
    client.start();
    const es = MockEventSource.live[0];
    es.emitOpen();
    es.emit(
      "entry_appended",
      {
        projectPath: "/p",
        event: {
          type: "entry_appended",
          entry: customEntry("omo-memory:accepted-turns", { version: 1 }, "abc12345"),
          sessionId: "rpc-9",
        },
        durableSessionId: "d-live",
      },
      7,
    );
    const entries = useMessagesStore.getState().bySession["d-live"].entries;
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe("abc12345");
    client.stop();
  });
});

// ===== docs08-r6 任务 9：命名空间前缀白名单（匹配宽、渲染窄）与召回条目派生 =====

/** task-3 枚举报告第一节“完整示例（原始行）”的 recall content（库内原文，含 &quot;） */
const RECALL_CONTENT =
  '<recalled-memory source="[[people/human/observations.md]]">\nKibitzer, a background memory advisor, surfaced this stored note. It may or may not apply: reference only; your current task stands.\n用户观察记录显示该用户倾向于&quot;先充分讨论、由用户拍板再动手实施&quot;，对方案常要求记录待定而非立即执行。\n</recalled-memory>';

/** task-3 实测 recall 字段集：{type,customType,content,display,id,parentId,timestamp}，无 details */
function recallMessageEntry(customType: string, content: string, id: string) {
  return {
    type: "custom_message",
    customType,
    content,
    display: false,
    id,
    parentId: "25e8885f",
    timestamp: "2026-10-20T15:14:51.829Z",
  };
}

/** 前缀正例全集：四命名空间的既有类 + 未来子类（免改码入列，含非召回的 omo-kibitzer:gate） */
const PREFIX_POSITIVES = [
  "senpi-memory.session-binding",
  "omo-memory:accepted-turns",
  "omo-memory:projection-pin",
  "omo-memory:notice",
  "omo-kibitzer:nudged",
  "omo-memorian:nudged",
  "omo-kibitzer:recall",
  "omo-memorian:recall",
  "senpi-memory.future-thing",
  "omo-memory:brand-new",
  "omo-kibitzer:gate",
];

/** 前缀反例：引擎内部条目 + 分隔符近似碰撞（前缀集合精确，不扩大） */
const PREFIX_NEGATIVES = [
  "pi-rules.scan",
  "senpi.hooks.stop-state",
  "senpi-task.usage",
  "environment-context",
  "senpi.todo-first-turn",
  "omo-model-profile:applied",
  "senpi-memoryx.binding",
  "omo-memoryx:pin",
  "omo-kibitzerx:recall",
  "omo-memorianx.recall",
];

/** markerMeta 覆盖的窄化集合（渲染门非 null 恰好于此） */
const RENDER_KINDS = new Set([
  "senpi-memory.session-binding",
  "omo-memory:accepted-turns",
  "omo-memory:projection-pin",
  "omo-kibitzer:nudged",
  "omo-memorian:nudged",
  "omo-memory:notice",
  "omo-kibitzer:recall",
  "omo-memorian:recall",
]);

describe("命名空间前缀白名单（docs08-r6 任务 9，共享匹配函数）", () => {
  test("四命名空间前缀正例全部命中共享匹配函数（含未知子类，匹配宽）", () => {
    for (const ct of PREFIX_POSITIVES) expect(isMemoryCustomType(ct)).toBe(true);
  });

  test("引擎内部条目与分隔符近似碰撞全部拒绝（prefix_too_wide 反例真测）", () => {
    for (const ct of PREFIX_NEGATIVES) expect(isMemoryCustomType(ct)).toBe(false);
  });

  test("两通道门与渲染门共用同一匹配函数：通道门判定恒等于 isMemoryCustomType（dual_gate_drift 断言）", () => {
    for (const ct of [...PREFIX_POSITIVES, ...PREFIX_NEGATIVES]) {
      const custom = customEntry(ct, {}, "f1");
      const message = recallMessageEntry(ct, "c", "f2");
      expect(isMemoryAppendedEntry(custom)).toBe(isMemoryCustomType(ct));
      expect(isMemoryAppendedEntry(message)).toBe(isMemoryCustomType(ct));
      expect(isMemoryCustomMessageEntry(message)).toBe(isMemoryCustomType(ct));
    }
  });

  test("匹配宽、渲染窄：omo-kibitzer:gate 入列门放行、渲染门返 null；渲染非 null 恰为 markerMeta 覆盖集", () => {
    expect(isMemoryAppendedEntry(recallMessageEntry("omo-kibitzer:gate", "g", "g1"))).toBe(true);
    expect(memoryMarkerOf(recallMessageEntry("omo-kibitzer:gate", "g", "g1"))).toBeNull();
    expect(memoryMarkerOf(customEntry("omo-kibitzer:gate", {}, "g2"))).toBeNull();
    for (const ct of [...PREFIX_POSITIVES, ...PREFIX_NEGATIVES]) {
      const m = memoryMarkerOf(recallMessageEntry(ct, "c", "g3"));
      expect(m !== null).toBe(RENDER_KINDS.has(ct));
    }
  });
});

describe("召回条目派生（docs08-r6 任务 9）", () => {
  test("kibitzer:recall：kind/权重/摘要源=content 内 source 路径/原文=content（task-3 实样原文）", () => {
    const m = memoryMarkerOf(recallMessageEntry("omo-kibitzer:recall", RECALL_CONTENT, "7e16cad2"));
    expect(m).not.toBeNull();
    expect(m?.entryId).toBe("7e16cad2");
    expect(m?.kind).toBe("memoryRecall");
    expect(m?.weight).toBe("notice");
    expect(m?.summary).toEqual({
      key: "chat.memoryMarkers.recall",
      vars: { source: "people/human/observations.md" },
    });
    expect(m?.detail).toBe(RECALL_CONTENT);
    // 逐条渲染：不设 identity 去重键（仅 sessionBinding 设）
    expect(m?.dedupeKey).toBeUndefined();
  });

  test("memorian:recall 同判（库内 0 条不等于永不出，前缀须放行）；message_end 实时形态同构", () => {
    const content = '<recalled-memory source="[[notes/facts/senpi-webui.md]]">\n正文\n</recalled-memory>';
    const hist = memoryMarkerOf(recallMessageEntry("omo-memorian:recall", content, "aa11bb22"));
    const live = memoryMarkerOf(customMessageEnd("omo-memorian:recall", content));
    expect(hist?.kind).toBe("memoryRecall");
    expect(live?.kind).toBe("memoryRecall");
    expect(hist?.summary).toEqual({
      key: "chat.memoryMarkers.recall",
      vars: { source: "notes/facts/senpi-webui.md" },
    });
    expect(live?.summary).toEqual(hist?.summary);
  });

  test("recall 异常形态降级：content 无包裹头时用无路径摘要键，不臆造字段", () => {
    const m = memoryMarkerOf(recallMessageEntry("omo-kibitzer:recall", "纯文本无包裹头", "cc11dd22"));
    expect(m?.summary).toEqual({ key: "chat.memoryMarkers.recallPlain" });
    expect(m?.detail).toBe("纯文本无包裹头");
  });
});

describe("召回渲染路径（SSE / REST 两路 + 逐条渲染）", () => {
  const REST_ENTRY = recallMessageEntry("omo-kibitzer:recall", RECALL_CONTENT, "7e16cad2");

  function frame(wire: Record<string, unknown>, cursor: number, durable = "d-r9"): void {
    dispatchSseEvent(
      String(wire.type),
      JSON.stringify({ projectPath: "/p", event: wire, durableSessionId: durable }),
      cursor,
    );
  }

  beforeEach(() => {
    resetDispatchState();
    useMessagesStore.setState({ bySession: {} });
  });
  afterEach(() => {
    resetDispatchState();
    useMessagesStore.setState({ bySession: {} });
  });

  test("REST 路径：历史 GET messages 同形条目（display:false 无 details）经 setEntries 派生标记", () => {
    useMessagesStore.getState().setEntries("d-r9", [REST_ENTRY], null, null);
    const entries = useMessagesStore.getState().bySession["d-r9"].entries;
    expect(entries.length).toBe(1);
    const m = memoryMarkerOf(entries[0]);
    expect(m?.kind).toBe("memoryRecall");
    expect(m?.summary).toEqual({
      key: "chat.memoryMarkers.recall",
      vars: { source: "people/human/observations.md" },
    });
    expect(mergeMemoryItems([], entries).map((i) => i.kind)).toEqual(["memoryMarker"]);
  });

  test("SSE 路径：entry_appended 携 id recall 条目入列并派生同构标记", () => {
    frame({ type: "entry_appended", entry: REST_ENTRY, sessionId: "rpc-1" }, 1);
    const entries = useMessagesStore.getState().bySession["d-r9"].entries;
    expect(entries.length).toBe(1);
    const m = memoryMarkerOf(entries[0]);
    expect(m?.kind).toBe("memoryRecall");
    expect(m?.summary).toEqual({
      key: "chat.memoryMarkers.recall",
      vars: { source: "people/human/observations.md" },
    });
    expect(mergeMemoryItems([], entries).map((i) => i.kind)).toEqual(["memoryMarker"]);
  });

  test("多条召回并存逐条渲染，marker key 沿 entryId，不走 sessionBinding identity 去重（dedup_regression 断言）", () => {
    const user = { type: "message", id: "u1", message: { role: "user", content: [] } };
    const entries = [
      recallMessageEntry("omo-kibitzer:recall", RECALL_CONTENT, "r1"),
      user,
      recallMessageEntry("omo-kibitzer:recall", RECALL_CONTENT, "r2"),
    ];
    const items: ChatListItem[] = [{ key: "u1", kind: "entry", entryId: "u1", interrupted: false }];
    const merged = mergeMemoryItems(items, entries);
    expect(merged.map((i) => i.key)).toEqual(["memory-r1", "u1", "memory-r2"]);
  });
});
