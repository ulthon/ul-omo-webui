// @ts-nocheck
// 消息级模型归因补全单测（2026-11-01）：
// - A2 水合回读：首载尾窗缺 model_change 且 hasMore → 全量页挑窗口外变更点入归因表
//   （modelBackfill + appliedModels 兑底 + 前插时间线解析 → 气泡模型显示）
// - A2 守卫：尾窗已含变更点 / 已全量 → 只落闸不拉取；拉取失败落闸静默降级
// - A1 回执归因：markReceiptModel 落消息域归因表 → items 归因 + 流式气泡显示
// 环境说明同 model-variant-name.test.tsx：@ts-nocheck + 动态 import（zustand SSR shim
// 由 vitest setupFiles 预载）；渲染用 renderToStaticMarkup（node 环境零 DOM）。
import { afterEach, describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { buildMessageItems, modelChangeBackfillOf } = await import("@/components/chat/message-items");
const { EntryBubble, StreamingBubble } = await import("@/components/chat/message-bubble");
const { useMessagesStore } = await import("@/stores/messages");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");

const SID = "qa-attrib-backfill";

/** 双变体 fixture 注册表（同 model-variant-name.test.tsx：glm-5.3-4k/-2k 同上游 glm-5.3） */
const DUAL_REGISTRY = [
  { provider: "zai-coding-cn", id: "glm-5.3", reasoning: true },
  { provider: "zai-coding-cn", id: "glm-5.3-4k", reasoning: true, upstreamId: "glm-5.3" },
  { provider: "zai-coding-cn", id: "glm-5.3-2k", reasoning: true, upstreamId: "glm-5.3" },
];

/** 真实 wire 形态：model_change 条目（provider/modelId 记变体名） */
function modelChange(id, modelId, provider = "zai-coding-cn") {
  return { type: "model_change", id, timestamp: "2026-11-01T10:00:00.000Z", provider, modelId };
}

function userEntry(id) {
  return {
    type: "message",
    id,
    timestamp: "2026-11-01T10:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "帮我查一下" }] },
  };
}

/** assistant 条目：引擎侧只记裸上游名（实测 3282 条 glm-5.3 vs 2 条变体 id） */
function assistantEntry(id, model) {
  return {
    type: "message",
    id,
    timestamp: "2026-11-01T10:01:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "回答正文" }], model },
  };
}

function page(entries) {
  return { sessionId: SID, entries, leafId: null, cursor: null };
}

function slot() {
  return useMessagesStore.getState().bySession[SID];
}

function entryItemOf(items, entryId) {
  return items.find((i) => i.kind === "entry" && i.entryId === entryId);
}

afterEach(() => {
  useMessagesStore.getState().clearSession(SID);
  useSessionsStore.setState({ appliedModels: {} });
  useUiStore.getState().setSelectedModel(null);
});

describe("modelChangeBackfillOf 纯函数（窗口外变更点挑取）", () => {
  test("窄化 model_change + 携 id，剔除窗口已有 id，保序", () => {
    const full = [
      modelChange("mc-old", "glm-5.3-4k"),
      userEntry("u-old"),
      assistantEntry("a1", "glm-5.3"),
      { type: "model_change", id: "bad" }, // 缺 provider/modelId：不入
      { type: "model_change", provider: "p", modelId: "m" }, // 缺 id：不入
    ];
    const window = [assistantEntry("a1", "glm-5.3")];
    expect(modelChangeBackfillOf(full, window).map((e) => e.id)).toEqual(["mc-old"]);
  });
});

describe("水合回读（A2）：尾窗缺 model_change → 全量拉窗口外变更点", () => {
  test("回读落归因表 + appliedModels 兑底 + 前插时间线解析 → 气泡模型显示", async () => {
    const tail = [userEntry("u1"), assistantEntry("a1", "glm-5.3")];
    useMessagesStore.getState().setEntries(SID, tail, null, null, { hasMore: true, oldestId: "u1" });
    const calls = [];
    await useMessagesStore.getState().backfillModelTimeline(SID, async (opts) => {
      calls.push(opts);
      return page([modelChange("mc-old", "glm-5.3-4k"), userEntry("u-old"), ...tail]);
    });
    // 全量取一次；变更点入归因表（尾窗重叠 id 剔除）
    expect(calls).toEqual([{ full: true }]);
    const st = slot();
    expect(st.modelBackfill.map((e) => e.id)).toEqual(["mc-old"]);
    expect(st.modelBackfillDone).toBe(true);
    // 窗口外最末变更点 = 当前生效模型（复用水合口径）
    expect(useSessionsStore.getState().appliedModels[SID]).toBe("zai-coding-cn/glm-5.3-4k");
    // items 组装（chat-view 同构：归因表前插 + appliedModel 空缺）→ a1 归因变体名
    const merged = [...modelChangeBackfillOf(st.modelBackfill, tail), ...tail];
    const items = buildMessageItems(merged, {
      hasStreamingMessage: false,
      interrupted: false,
      modelRegistry: DUAL_REGISTRY,
      appliedModel: null,
    });
    const resolved = entryItemOf(items, "a1").model;
    expect(resolved).toEqual({ name: "glm-5.3-4k", ambiguous: false });
    // 气泡渲染：合并后条目入槽，EntryBubble 头部显示变体短名
    useMessagesStore.setState({ bySession: { [SID]: { ...st, entries: merged } } });
    const markup = renderToStaticMarkup(
      createElement(EntryBubble, { sessionId: SID, entryId: "a1", interrupted: false, model: resolved }),
    );
    expect(markup).toContain("glm-5.3-4k");
  });

  test("守卫：尾窗已含变更点 → 只落闸不拉全量", async () => {
    const tail = [userEntry("u1"), modelChange("mc-win", "glm-5.3-2k"), assistantEntry("a1", "glm-5.3")];
    useMessagesStore.getState().setEntries(SID, tail, null, null, { hasMore: true, oldestId: "u1" });
    const calls = [];
    await useMessagesStore.getState().backfillModelTimeline(SID, async (opts) => {
      calls.push(opts);
      return page([]);
    });
    expect(calls).toEqual([]);
    const st = slot();
    expect(st.modelBackfill).toEqual([]);
    expect(st.modelBackfillDone).toBe(true);
  });

  test("守卫：已全量（hasMore=false）→ 不拉取", async () => {
    useMessagesStore
      .getState()
      .setEntries(SID, [assistantEntry("a1", "glm-5.3")], null, null, { hasMore: false, oldestId: null });
    const calls = [];
    await useMessagesStore.getState().backfillModelTimeline(SID, async (opts) => {
      calls.push(opts);
      return page([]);
    });
    expect(calls).toEqual([]);
    expect(slot().modelBackfillDone).toBe(true);
  });

  test("拉取失败：落闸静默降级，归因表保持空", async () => {
    useMessagesStore
      .getState()
      .setEntries(SID, [assistantEntry("a1", "glm-5.3")], null, null, { hasMore: true, oldestId: "a1" });
    await useMessagesStore.getState().backfillModelTimeline(SID, async () => {
      throw new Error("ECONNREFUSED");
    });
    const st = slot();
    expect(st.modelBackfill).toEqual([]);
    expect(st.modelBackfillDone).toBe(true);
  });
});

describe("回执归因（A1）：appliedModel 落消息域归因表", () => {
  test("markReceiptModel 落表 → items 归因 + 流式气泡显示模型短名", async () => {
    const tail = [userEntry("u1"), assistantEntry("a1", "glm-5.3")];
    useMessagesStore.getState().setEntries(SID, tail, null, null, { hasMore: false, oldestId: null });
    useMessagesStore.getState().markReceiptModel(SID, "zai-coding-cn/glm-5.3-2k");
    const st = slot();
    expect(st.receiptModel).toBe("zai-coding-cn/glm-5.3-2k");
    // items 组装（chat-view 同构：会话级 appliedModels 空缺 → 回落归因表）→ a1 归因回执模型
    const items = buildMessageItems(tail, {
      hasStreamingMessage: false,
      interrupted: false,
      modelRegistry: DUAL_REGISTRY,
      appliedModel: st.receiptModel,
    });
    const resolved = entryItemOf(items, "a1").model;
    expect(resolved).toEqual({ name: "zai-coding-cn/glm-5.3-2k", ambiguous: false });
    // 流式态：streamingMessage 无 model 字段（裸流）→ 回执归因兜底显示
    useMessagesStore.setState({
      bySession: {
        [SID]: { ...st, streamingMessage: { role: "assistant", content: [{ type: "text", text: "正在回答" }] } },
      },
    });
    const markup = renderToStaticMarkup(createElement(StreamingBubble, { sessionId: SID }));
    expect(markup).toContain("glm-5.3-2k");
  });
});
