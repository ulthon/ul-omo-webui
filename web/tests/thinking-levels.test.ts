// 思考档纯助手单测（W2 todo 8）：thinkingLevelOptions 的缺席隐藏 / 过滤 / 去重 / 保序，
// effectiveThinkingLevel 的 prompt 注入门控（模型未下发字段时注入 undefined）。
import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/lib/api";
import { effectiveThinkingLevel, thinkingLevelOptions } from "@/lib/thinking-level";

function model(extra?: Partial<ModelInfo>): ModelInfo {
  return { provider: "zai", id: "glm", contextWindow: 1000, reasoning: true, ...extra };
}

describe("thinkingLevelOptions", () => {
  test("模型未下发 supportedThinkingLevels → 空数组（chip 整体隐藏）", () => {
    expect(thinkingLevelOptions(model())).toEqual([]);
    expect(thinkingLevelOptions(model({ supportedThinkingLevels: undefined }))).toEqual([]);
    expect(thinkingLevelOptions(null)).toEqual([]);
    expect(thinkingLevelOptions(undefined)).toEqual([]);
  });

  test("下发的档位过滤到服务端可持久化集合（off/medium 等被剔除）", () => {
    expect(thinkingLevelOptions(model({ supportedThinkingLevels: ["off", "low", "medium", "high", "max"] }))).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  test("保模型声明顺序、去重、丢弃非字符串项", () => {
    expect(thinkingLevelOptions(model({ supportedThinkingLevels: ["max", "low", "max", 3 as unknown as string] }))).toEqual([
      "max",
      "low",
    ]);
  });

  test("glm 实测形态（low/high/max）原样通过", () => {
    expect(thinkingLevelOptions(model({ supportedThinkingLevels: ["low", "high", "max"] }))).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  test("全被过滤掉（如仅 off）→ 空数组", () => {
    expect(thinkingLevelOptions(model({ supportedThinkingLevels: ["off"] }))).toEqual([]);
  });
});

describe("effectiveThinkingLevel", () => {
  test("模型无 supportedThinkingLevels → 即便有当前选择也不注入（undefined）", () => {
    expect(effectiveThinkingLevel(model(), "max")).toBeUndefined();
  });

  test("模型支持且有当前选择 → 注入当前档", () => {
    const m = model({ supportedThinkingLevels: ["low", "high", "max"] });
    expect(effectiveThinkingLevel(m, "max")).toBe("max");
  });

  test("模型支持但未选（null）→ undefined（JSON 序列化即缺字段）", () => {
    const m = model({ supportedThinkingLevels: ["low", "high", "max"] });
    expect(effectiveThinkingLevel(m, null)).toBeUndefined();
  });

  test("模型未知（列表未含）→ undefined", () => {
    expect(effectiveThinkingLevel(undefined, "low")).toBeUndefined();
  });
});
