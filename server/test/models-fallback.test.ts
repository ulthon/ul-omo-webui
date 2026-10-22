/** 模型降级数据与 settings.json 直读单测（"下拉只显示套餐目录"缺陷修复 + docs08-r5 任务 2 的支撑面）：
 * - readModelsFallback：models-store.json 目录缓存 + models.json 自定义合并（同 provider/id 自定义覆盖）
 * - readFavoriteModels：settings.json favoriteModels 归一（剥思考档后缀、去重保序、跳过非法条目）
 * - readDefaultModel：settings.json 默认模型三态（缺失/字段全/字段缺 thinkingLevel）
 */
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDefaultModel, readFavoriteModels, readModelsFallback, mergeUpstreamIds } from "../src/api/engine-runtime";

describe("readModelsFallback", () => {
  test("目录缓存与自定义合并：同 id 自定义覆盖、独有项各自并入", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-fallback-"));
    try {
      writeFileSync(
        join(dir, "models-store.json"),
        JSON.stringify({
          "zai-coding-cn": {
            models: [
              { id: "glm-5.3", reasoning: true, contextWindow: 200000 },
              { id: "glm-4.7", reasoning: true },
            ],
          },
        }),
      );
      writeFileSync(
        join(dir, "models.json"),
        JSON.stringify({
          providers: {
            "zai-coding-cn": {
              models: [
                {
                  id: "glm-5.3",
                  reasoning: true,
                  contextWindow: 400000,
                  thinkingLevelMap: { off: null, max: "max" },
                },
                { id: "glm-5.3-4k", reasoning: true, contextWindow: 400000 },
              ],
            },
            commandcode: {
              models: [{ id: "deepseek/deepseek-v4.1-flash", reasoning: true, contextWindow: 1000000 }],
            },
          },
        }),
      );
      const out = readModelsFallback(dir);
      const byKey = new Map(out.map((m) => [`${m.provider}/${m.id}`, m]));
      // 覆盖：目录 glm-5.3 被自定义覆盖（contextWindow 与 thinkingLevelMap 生效）
      expect(byKey.get("zai-coding-cn/glm-5.3")?.contextWindow).toBe(400000);
      expect(byKey.get("zai-coding-cn/glm-5.3")?.supportedThinkingLevels).toEqual(["off", "max"]);
      // 并入：自定义独有模型（含新 provider）
      expect(byKey.get("zai-coding-cn/glm-5.3-4k")?.contextWindow).toBe(400000);
      expect(byKey.has("commandcode/deepseek/deepseek-v4.1-flash")).toBe(true);
      // 保留：目录独有模型
      expect(byKey.has("zai-coding-cn/glm-4.7")).toBe(true);
      expect(out).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("仅目录缓存（无 models.json）：原样返回", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-fallback-"));
    try {
      writeFileSync(
        join(dir, "models-store.json"),
        JSON.stringify({ "zai-coding-cn": { models: [{ id: "glm-5.3" }] } }),
      );
      const out = readModelsFallback(dir);
      expect(out).toHaveLength(1);
      expect(out[0]?.id).toBe("glm-5.3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("文件缺失/畸形：空列表不抛", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-fallback-"));
    try {
      expect(readModelsFallback(dir)).toEqual([]);
      writeFileSync(join(dir, "models-store.json"), "{broken");
      writeFileSync(join(dir, "models.json"), "{broken");
      expect(readModelsFallback(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readFavoriteModels", () => {
  test("剥思考档后缀归一 + 去重保序 + 跳过非法条目", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-fav-"));
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          favoriteModels: [
            "zai-coding-cn/glm-5.3:max",
            "zai-coding-cn/glm-5.3-flash",
            "zai-coding-cn/glm-5.3:max",
            "no-slash-entry",
            42,
            "commandcode/deepseek/deepseek-v4.1-flash:low",
          ],
          defaultModel: "zai-coding-cn/glm-5.3",
        }),
      );
      expect(readFavoriteModels(dir)).toEqual([
        "zai-coding-cn/glm-5.3",
        "zai-coding-cn/glm-5.3-flash",
        "commandcode/deepseek/deepseek-v4.1-flash",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("文件缺失/favoriteModels 非数组：空列表不抛", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-fav-"));
    try {
      expect(readFavoriteModels(dir)).toEqual([]);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultModel: "x/y" }));
      expect(readFavoriteModels(dir)).toEqual([]);
      writeFileSync(join(dir, "settings.json"), "{broken");
      expect(readFavoriteModels(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readDefaultModel", () => {
  test("字段全：provider/model/thinkingLevel 原样透传（docs08 实证配置 zai-coding-cn/glm-5.3-4k + max）", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-default-"));
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ defaultProvider: "zai-coding-cn", defaultModel: "glm-5.3-4k", defaultThinkingLevel: "max" }),
      );
      expect(readDefaultModel(dir)).toEqual({
        provider: "zai-coding-cn",
        model: "glm-5.3-4k",
        thinkingLevel: "max",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("字段缺 thinkingLevel：模型生效、思考档 null", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-default-"));
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ defaultProvider: "zai-coding-cn", defaultModel: "glm-5.3-4k" }),
      );
      expect(readDefaultModel(dir)).toEqual({ provider: "zai-coding-cn", model: "glm-5.3-4k", thinkingLevel: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("文件缺失/JSON 异常/字段缺失或非字符串：一律 null 不抛", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-default-"));
    try {
      // 文件缺失
      expect(readDefaultModel(dir)).toBeNull();
      // JSON 异常
      writeFileSync(join(dir, "settings.json"), "{broken");
      expect(readDefaultModel(dir)).toBeNull();
      // 缺 defaultModel
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "p" }));
      expect(readDefaultModel(dir)).toBeNull();
      // 字段非字符串
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: 42, defaultModel: "m" }));
      expect(readDefaultModel(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("变体上游映射 upstreamId（docs08 2026-10-22 批次任务 18）", () => {
  test("readModelsFallback：models.json upstreamModelId 解析为 upstreamId；非字符串/空串视同缺失", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-upstream-"));
    try {
      writeFileSync(
        join(dir, "models.json"),
        JSON.stringify({
          providers: {
            "zai-coding-cn": {
              models: [
                { id: "glm-5.3-4k", upstreamModelId: "glm-5.3", contextWindow: 400000 },
                { id: "glm-5.3-2k", upstreamModelId: "glm-5.3", contextWindow: 200000 },
                { id: "glm-5.3", contextWindow: 1000000 },
                { id: "bad-empty", upstreamModelId: "" },
                { id: "bad-type", upstreamModelId: 42 },
              ],
            },
          },
        }),
      );
      const byKey = new Map(readModelsFallback(dir).map((m) => [`${m.provider}/${m.id}`, m]));
      expect(byKey.get("zai-coding-cn/glm-5.3-4k")?.upstreamId).toBe("glm-5.3");
      expect(byKey.get("zai-coding-cn/glm-5.3-2k")?.upstreamId).toBe("glm-5.3");
      expect(byKey.get("zai-coding-cn/glm-5.3")?.upstreamId).toBeUndefined();
      expect(byKey.get("zai-coding-cn/bad-empty")?.upstreamId).toBeUndefined();
      expect(byKey.get("zai-coding-cn/bad-type")?.upstreamId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mergeUpstreamIds：协议面行按 provider/id 补齐，不覆盖行内已有值；空入参原样返回", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-merge-"));
    try {
      writeFileSync(
        join(dir, "models.json"),
        JSON.stringify({
          providers: {
            "zai-coding-cn": {
              models: [{ id: "glm-5.3-4k", upstreamModelId: "glm-5.3" }],
            },
          },
        }),
      );
      const rows = [
        { provider: "zai-coding-cn", id: "glm-5.3-4k" },
        { provider: "zai-coding-cn", id: "glm-5.3", upstreamId: "keep-me" },
        { provider: "other", id: "glm-5.3-4k" },
      ];
      const merged = mergeUpstreamIds(rows, dir);
      expect(merged[0]).toEqual({ provider: "zai-coding-cn", id: "glm-5.3-4k", upstreamId: "glm-5.3" });
      // 行内已有 upstreamId 不被改写
      expect(merged[1]?.upstreamId).toBe("keep-me");
      // 异 provider 同 id 不受影响
      expect(merged[2]).toEqual({ provider: "other", id: "glm-5.3-4k" });
      // 原数组不被改写
      expect(rows[0]).toEqual({ provider: "zai-coding-cn", id: "glm-5.3-4k" });
      expect(mergeUpstreamIds([], dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
