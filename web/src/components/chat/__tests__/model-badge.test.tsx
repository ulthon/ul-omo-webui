// @ts-nocheck
// 模型「待生效」徽标（docs08 2026-10-22 批次任务 27）。环境说明同 todo-panel.test.tsx：
// @ts-nocheck（bun:test 类型包仅在 server 工作区）+ 被测模块动态 import（保证单独运行时
// 晚于 preload mock 生效）。覆盖计划验收：水合落库（27a）、unknown 不挂标（27b）、
// 会话级基线对齐（27c）、变体同键空间直接比对（27d 核实：引擎 model_changed 帧与 jsonl
// model_change 条目同源同一 model 对象，变体名形态，无需归一）、真待生效挂标与回执收敛。
import { afterEach, describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { lastModelChangeOf } = await import("../message-items");
const { pendingModelBadgeVisible, alignSelectionToApplied } = await import("../../composer/model-pending");
const { CapsuleModelTag } = await import("../../composer/chips");
const { useMessagesStore } = await import("@/stores/messages");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");

/** 真实 wire 形态：model_change 条目（docs/08 02:46 实录：provider/modelId 记变体名） */
function modelChangeEntry(id, provider, modelId) {
  return { type: "model_change", id, provider, modelId };
}

/** 定格用户条目（同 todo fixtures storedEntry 形态） */
function userEntry(id) {
  return { type: "message", id, message: { role: "user", content: [{ type: "text", text: "你好" }] } };
}

afterEach(() => {
  useUiStore.getState().setSelectedModel(null);
});

describe("lastModelChangeOf 水合源扫描（27a）", () => {
  test("多条切换最后一条胜出，变体名保留", () => {
    const entries = [
      modelChangeEntry("e1", "zai-coding-cn", "glm-5.3-4k"),
      userEntry("e2"),
      modelChangeEntry("e3", "zai-coding-cn", "glm-5.3"),
    ];
    expect(lastModelChangeOf(entries)).toEqual({ provider: "zai-coding-cn", modelId: "glm-5.3" });
  });

  test("无切换/窄化不严（缺 provider/modelId）→ null，不误写", () => {
    expect(lastModelChangeOf([])).toBeNull();
    expect(lastModelChangeOf([userEntry("e1")])).toBeNull();
    expect(lastModelChangeOf([{ type: "model_change", id: "e1" }])).toBeNull();
  });
});

describe("生效模型水合落库（27a）", () => {
  test("setEntries 载入窗含 model_change → appliedModels 落变体名；变体会话（4k）流式期同键空间不挂标（27d）", () => {
    const sid = "qa-badge-hydrate";
    try {
      useMessagesStore.getState().setEntries(sid, [userEntry("e1"), modelChangeEntry("e2", "zai-coding-cn", "glm-5.3-4k")], "e2", "e2", {
        hasMore: false,
        oldestId: null,
      });
      expect(useSessionsStore.getState().appliedModels[sid]).toBe("zai-coding-cn/glm-5.3-4k");
      // 刷新后选中即变体 id（localStorage 初值）：键空间同源，流式期（queueAvailable=true）不挂
      expect(
        pendingModelBadgeVisible(true, "zai-coding-cn/glm-5.3-4k", useSessionsStore.getState().appliedModels[sid]),
      ).toBe(false);
    } finally {
      useMessagesStore.getState().clearSession(sid);
    }
  });

  test("appendEntries 游标增量窗含切换同样落库；无切换窗不写（留 unknown）", () => {
    const sid = "qa-badge-append";
    try {
      useMessagesStore.getState().setEntries(sid, [userEntry("e1")], "e1", "e1", { hasMore: false, oldestId: null });
      expect(useSessionsStore.getState().appliedModels[sid]).toBeUndefined();
      useMessagesStore.getState().appendEntries(sid, [modelChangeEntry("e2", "openai", "gpt-5.2")]);
      expect(useSessionsStore.getState().appliedModels[sid]).toBe("openai/gpt-5.2");
    } finally {
      useMessagesStore.getState().clearSession(sid);
    }
  });

  test("水合基线对齐（27c）：查看中会话落库即对齐全局选中（残留跨会话选中不误挂）；非查看会话只落库不对齐", () => {
    const sid = "qa-badge-align";
    const other = "qa-badge-align-other";
    try {
      useSessionsStore.setState({ selectedId: sid });
      useUiStore.getState().setSelectedModel("anthropic/claude-x"); // 残留选中（他处显式选择/初值）
      useMessagesStore
        .getState()
        .setEntries(sid, [modelChangeEntry("e1", "zai-coding-cn", "glm-5.3-4k")], "e1", "e1", {
          hasMore: false,
          oldestId: null,
        });
      expect(useUiStore.getState().selectedModel).toBe("zai-coding-cn/glm-5.3-4k");
      // 非查看会话的水合只落 appliedModels，不动选中
      useMessagesStore
        .getState()
        .setEntries(other, [modelChangeEntry("e1", "openai", "gpt-5.2")], "e1", "e1", {
          hasMore: false,
          oldestId: null,
        });
      expect(useUiStore.getState().selectedModel).toBe("zai-coding-cn/glm-5.3-4k");
      expect(useSessionsStore.getState().appliedModels[other]).toBe("openai/gpt-5.2");
    } finally {
      useSessionsStore.setState({ selectedId: null });
      useMessagesStore.getState().clearSession(sid);
      useMessagesStore.getState().clearSession(other);
      useUiStore.getState().setSelectedModel(null);
    }
  });
});

describe("待生效徽标判定（27b/27c）", () => {
  test("unknown（applied=null，无水合无回执）不挂标——保守显示即误报的机制 a 消除", () => {
    expect(pendingModelBadgeVisible(true, "zai-coding-cn/glm-5.3-4k", null)).toBe(false);
    // 空闲期（queueAvailable=false）一律不挂（既有语义不变）
    expect(pendingModelBadgeVisible(false, "zai-coding-cn/glm-5.3-4k", "zai-coding-cn/glm-5.3")).toBe(false);
  });

  test("真待生效→回执收敛：applied 追平选中即翻 false（徽标随生效消失）", () => {
    const sid = "qa-badge-pending";
    useSessionsStore.getState().setAppliedModel(sid, "zai-coding-cn/glm-5.3");
    expect(pendingModelBadgeVisible(true, "zai-coding-cn/glm-5.3-4k", "zai-coding-cn/glm-5.3")).toBe(true);
    useSessionsStore.getState().setAppliedModel(sid, "zai-coding-cn/glm-5.3-4k");
    expect(
      pendingModelBadgeVisible(true, "zai-coding-cn/glm-5.3-4k", useSessionsStore.getState().appliedModels[sid]),
    ).toBe(false);
  });

  test("会话级基线对齐：残留全局选中对齐该会话生效模型（机制 b 切会话不误挂）；unknown/已对齐 no-op", () => {
    // 残留选中（他会的显式选择）≠ 本会话 applied → 对齐到 applied
    expect(alignSelectionToApplied("zai-coding-cn/glm-5.3", "anthropic/claude-x")).toBe("zai-coding-cn/glm-5.3");
    expect(pendingModelBadgeVisible(true, "zai-coding-cn/glm-5.3", "zai-coding-cn/glm-5.3")).toBe(false);
    // applied 未知 → 不动选中（全局选中仅作输入初值）
    expect(alignSelectionToApplied(null, "anthropic/claude-x")).toBeNull();
    // 已对齐 → no-op
    expect(alignSelectionToApplied("p/m", "p/m")).toBeNull();
  });
});

describe("CapsuleModelTag 渲染（SSR 烟测）", () => {
  test("pendingEffect=true 渲染待生效黄标", () => {
    const html = renderToStaticMarkup(createElement(CapsuleModelTag, { pendingEffect: true }));
    expect(html).toContain("capsule-model-pending");
  });

  test("pendingEffect=false 不渲染黄标（水合后无待生效选择 → 无徽标）", () => {
    const html = renderToStaticMarkup(createElement(CapsuleModelTag, { pendingEffect: false }));
    expect(html).not.toContain("capsule-model-pending");
  });
});
