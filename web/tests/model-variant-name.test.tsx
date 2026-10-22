// @ts-nocheck
// 模型变体名时间线对齐单测（docs08 2026-10-22 批次任务 18）：
// - resolveVariantName / resolveTimelineModels：双变体 fixture（glm-5.3-4k/-2k 同上游
//   glm-5.3，实证 models.json 形态）逐级断言（5 级回退 + 歧义注记 + 绝不猜）
// - buildMessageItems 集成：registry 传入时 assistant 条目携 model，user 恒 null
// - EntryBubble 渲染：变体名消费、歧义 title 注记、缺 prop 回落裸 message.model
// 环境说明同 message-bubble-origin.test.tsx：@ts-nocheck + 动态 import（zustand SSR
// shim 由 vitest setupFiles 预载）；渲染用 renderToStaticMarkup（node 环境零 DOM）。
import { afterEach, describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { buildMessageItems, resolveTimelineModels, resolveVariantName } = await import("@/components/chat/message-items");
const { EntryBubble } = await import("@/components/chat/message-bubble");
const { useMessagesStore } = await import("@/stores/messages");

const SID = "qa-model-variant";

/** 双变体 fixture 注册表（models.json 实证同构：glm-5.3-4k/-2k 同上游 glm-5.3） */
const DUAL_REGISTRY = [
  { provider: "zai-coding-cn", id: "glm-5.3", reasoning: true },
  { provider: "zai-coding-cn", id: "glm-5.3-4k", reasoning: true, upstreamId: "glm-5.3" },
  { provider: "zai-coding-cn", id: "glm-5.3-2k", reasoning: true, upstreamId: "glm-5.3" },
];

function modelChange(id, modelId, provider = "zai-coding-cn") {
  return { type: "model_change", id, timestamp: "2026-10-22T10:00:00.000Z", provider, modelId };
}

function userEntry(id) {
  return { type: "message", id, timestamp: "2026-10-22T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "帮我查一下" }] } };
}

function assistantEntry(id, model) {
  return {
    type: "message",
    id,
    timestamp: "2026-10-22T10:01:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "回答正文" }], model },
  };
}

/** 标准双变体时间线：切 4k → 回答 → 切 2k → 回答（assistant 恒记裸上游名 glm-5.3） */
function dualVariantTimeline() {
  return [
    userEntry("u1"),
    modelChange("mc1", "glm-5.3-4k"),
    assistantEntry("a1", "glm-5.3"),
    modelChange("mc2", "glm-5.3-2k"),
    assistantEntry("a2", "glm-5.3"),
  ];
}

afterEach(() => {
  useMessagesStore.getState().clearSession(SID);
});

describe("resolveVariantName 5 级回退", () => {
  test("梯级 1：时间线+注册表确证（upstreamId===raw）→ 变体名", () => {
    const asOf = { provider: "zai-coding-cn", modelId: "glm-5.3-4k" };
    expect(resolveVariantName("glm-5.3", asOf, DUAL_REGISTRY, null)).toEqual({
      name: "glm-5.3-4k",
      ambiguous: false,
    });
  });

  test("梯级 2a：变体已从注册表删除且裸 id 在册 → 时间线 modelId（历史段不丢变体名）", () => {
    const deleted = DUAL_REGISTRY.filter((r) => r.id !== "glm-5.3-4k");
    const asOf = { provider: "zai-coding-cn", modelId: "glm-5.3-4k" };
    expect(resolveVariantName("glm-5.3", asOf, deleted, null)).toEqual({
      name: "glm-5.3-4k",
      ambiguous: false,
    });
  });

  test("梯级 2b：时间线命中基础模型（modelId===raw，注册表无上游映射）→ 裸 id 无注记", () => {
    const asOf = { provider: "zai-coding-cn", modelId: "glm-5.3" };
    expect(resolveVariantName("glm-5.3", asOf, DUAL_REGISTRY, null)).toEqual({
      name: "glm-5.3",
      ambiguous: false,
    });
  });

  test("梯级 2 守卫：时间线命中他族模型（他族基础行在册）→ 不误标，落梯级 5 裸名+注记", () => {
    const asOf = { provider: "zai-coding-cn", modelId: "glm-4.6v" };
    const withFamily = [...DUAL_REGISTRY, { provider: "zai-coding-cn", id: "glm-4.6v", reasoning: false }];
    expect(resolveVariantName("glm-5.3", asOf, withFamily, null)).toEqual({
      name: "glm-5.3",
      ambiguous: true,
    });
  });

  test("梯级 3：无时间线命中 + appliedModels 在 → 生效模型（provider/model 形态透传，渲染层归一）", () => {
    expect(resolveVariantName("glm-5.3", null, DUAL_REGISTRY, "zai-coding-cn/glm-5.3-4k")).toEqual({
      name: "zai-coding-cn/glm-5.3-4k",
      ambiguous: false,
    });
  });

  test("梯级 4：无时间线无会话态 + 注册表唯一反查命中 → 该变体 id", () => {
    const single = [DUAL_REGISTRY[0], DUAL_REGISTRY[1]];
    expect(resolveVariantName("glm-5.3", null, single, null)).toEqual({
      name: "glm-5.3-4k",
      ambiguous: false,
    });
  });

  test("梯级 5：无任何会话态 + 多变体共用上游 → 裸名 + 歧义注记（绝不猜）", () => {
    expect(resolveVariantName("glm-5.3", null, DUAL_REGISTRY, null)).toEqual({
      name: "glm-5.3",
      ambiguous: true,
    });
  });

  test("梯级 5 零命中：裸名不是任何变体上游 → 裸名无注记（基础模型直显）", () => {
    expect(resolveVariantName("glm-4.7", null, DUAL_REGISTRY, null)).toEqual({
      name: "glm-4.7",
      ambiguous: false,
    });
  });
});

describe("resolveTimelineModels 单遍时间线", () => {
  test("双变体切换历史各时段正确：4k 段显 4k、切 2k 后显 2k", () => {
    const out = resolveTimelineModels(dualVariantTimeline(), DUAL_REGISTRY, null);
    expect(out.get("a1")).toEqual({ name: "glm-5.3-4k", ambiguous: false });
    expect(out.get("a2")).toEqual({ name: "glm-5.3-2k", ambiguous: false });
  });

  test("首条 assistant 无 model_change 先行：梯级 3 appliedModels 兜底；user 条目不入映射", () => {
    const entries = [userEntry("u1"), assistantEntry("a0", "glm-5.3"), ...dualVariantTimeline()];
    const out = resolveTimelineModels(entries, DUAL_REGISTRY, "zai-coding-cn/glm-5.3-2k");
    expect(out.get("a0")).toEqual({ name: "zai-coding-cn/glm-5.3-2k", ambiguous: false });
    expect(out.has("u1")).toBe(false);
  });

  test("无副作用：入参不被改写，重复调用结果一致（resolve 纯函数契约）", () => {
    const entries = Object.freeze(dualVariantTimeline().map((e) => Object.freeze({ ...e })));
    const registry = Object.freeze(DUAL_REGISTRY.map((r) => Object.freeze({ ...r })));
    const before = JSON.stringify(entries);
    const first = resolveTimelineModels(entries, registry, null);
    const second = resolveTimelineModels(entries, registry, null);
    expect(JSON.stringify(entries)).toBe(before);
    expect([...first.entries()]).toEqual([...second.entries()]);
    expect(first).not.toBe(second);
  });

  test("畸形 model_change（缺 provider/modelId）不更新时间线；非 assistant 消息跳过", () => {
    const entries = [
      { type: "model_change", id: "bad1", timestamp: "2026-10-22T10:00:00.000Z", modelId: "glm-5.3-4k" },
      modelChange("mc1", "glm-5.3-4k"),
      { type: "message", id: "t1", timestamp: "2026-10-22T10:00:30.000Z", message: { role: "toolResult", content: [] } },
      assistantEntry("a1", "glm-5.3"),
    ];
    const out = resolveTimelineModels(entries, DUAL_REGISTRY, null);
    // 畸形条目未污染：a1 仍由 mc1 正常解析
    expect(out.get("a1")).toEqual({ name: "glm-5.3-4k", ambiguous: false });
    expect(out.has("t1")).toBe(false);
  });
});

describe("buildMessageItems 集成", () => {
  test("registry 传入：assistant 条目携解析名，user 条目 model 恒 null，model_change 不入列", () => {
    const items = buildMessageItems(dualVariantTimeline(), {
      hasStreamingMessage: false,
      interrupted: false,
      modelRegistry: DUAL_REGISTRY,
      appliedModel: null,
    });
    const a1 = items.find((i) => i.kind === "entry" && i.entryId === "a1");
    const a2 = items.find((i) => i.kind === "entry" && i.entryId === "a2");
    expect(a1?.model).toEqual({ name: "glm-5.3-4k", ambiguous: false });
    expect(a2?.model).toEqual({ name: "glm-5.3-2k", ambiguous: false });
    expect(items.find((i) => i.kind === "entry" && i.entryId === "u1")?.model).toBeNull();
    expect(items.some((i) => i.entryId === "mc1" || i.entryId === "mc2")).toBe(false);
  });

  test("registry 未传（旧调用方）：model 恒 null，渲染层回落裸 message.model 不丢显示", () => {
    const items = buildMessageItems(dualVariantTimeline(), { hasStreamingMessage: false, interrupted: false });
    expect(items.every((i) => i.kind !== "entry" || i.model === null)).toBe(true);
  });
});

describe("EntryBubble 渲染消费", () => {
  function renderEntry(entryId, model) {
    return renderToStaticMarkup(
      <EntryBubble sessionId={SID} entryId={entryId} interrupted={false} model={model} />,
    );
  }

  test("变体名消费：props 携解析变体名时头部短名显变体（非裸上游名）", () => {
    useMessagesStore.getState().appendEntries(SID, [
      userEntry("u1"),
      assistantEntry("a1", "glm-5.3"),
    ]);
    const html = renderEntry("a1", { name: "glm-5.3-4k", ambiguous: false });
    expect(html).toContain("glm-5.3-4k");
  });

  test("歧义注记：ambiguous=true 时模型短名挂 title 提示（i18n zh）", () => {
    useMessagesStore.getState().appendEntries(SID, [
      assistantEntry("a1", "glm-5.3"),
    ]);
    const html = renderEntry("a1", { name: "glm-5.3", ambiguous: true });
    expect(html).toContain("title=\"多个模型变体共用此上游名，显示记录的原始名\"");
  });

  test("缺 prop 回落：model 未传时头部照显裸 message.model（历史数据不丢显示）", () => {
    useMessagesStore.getState().appendEntries(SID, [
      assistantEntry("a1", "zai-coding-cn/glm-5.3-flash"),
    ]);
    const html = renderEntry("a1", undefined);
    expect(html).toContain("glm-5.3-flash");
  });

  test("StreamingBubble：appliedModels 在场时优先于 message_start 裸名（任务 18 契约）", async () => {
    const { StreamingBubble } = await import("@/components/chat/message-bubble");
    const { useSessionsStore } = await import("@/stores/sessions");
    // 种流式消息（message_start 裸名形态）+ appliedModels（SSE model_changed 写入形态）
    useMessagesStore.setState({
      bySession: {
        [SID]: {
          entries: [],
          cursor: null,
          leafId: null,
          loaded: true,
          streaming: true,
          streamingMessage: { role: "assistant", content: [], model: "glm-5.3" },
          streamingEntryId: null,
          toolRuns: {},
        },
      },
    });
    useSessionsStore.getState().setAppliedModel(SID, "zai-coding-cn/glm-5.3-2k");
    const html = renderToStaticMarkup(<StreamingBubble sessionId={SID} />);
    expect(html).toContain("glm-5.3-2k");
    // 清理：清会话流式态与 appliedModels（防跨测试污染）
    useMessagesStore.getState().clearSession(SID);
    useSessionsStore.setState((s) => {
      const appliedModels = { ...s.appliedModels };
      delete appliedModels[SID];
      return { appliedModels };
    });
  });
});
