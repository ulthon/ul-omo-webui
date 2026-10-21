/**
 * 水位环分母校准（docs08-r6 任务 8 ⑥ 单测层）：注入 models 数据断言兜底逻辑——
 * 引擎实测值优先；引擎上报分母与所选模型 contextWindow 不一致（setModel 后引擎
 * 未更新 contextUsage.contextWindow）时以模型侧窗口用 tokens 重算，不假装引擎值
 * 存在（对抗类 denominator_lie：兜底分支必须真触发，而非恒走引擎 percent）。
 * 隔离实例实测（引擎 contextWindow 是否随 setModel 更新、SSE 帧对照）见
 * .omo/evidence/docs08-r6/task-8-qa.md。
 */
import { describe, expect, test } from "vitest";
import { calibrateContextPercent } from "@/components/layout/context-ring";

describe("calibrateContextPercent（引擎实测值优先，模型侧窗口兜底）", () => {
  test("引擎分母 1M（未随 setModel 更新）+ 所选模型 4K 窗口 → 以 4K 重算（2048/4096=50%）", () => {
    // 引擎帧：percent 按 1M 分母算出 0.2%（假装低占用）；模型侧 4096 才是真相
    const pct = calibrateContextPercent(
      { tokens: 2048, contextWindow: 1_000_000, percent: 0.2048 },
      4096,
    );
    expect(pct).toBe(50);
  });

  test("引擎分母与模型窗口一致 → 引擎实测 percent 直通（引擎值优先，含安全边际口径）", () => {
    expect(calibrateContextPercent({ tokens: 8192, contextWindow: 1_000_000, percent: 0.82 }, 1_000_000)).toBe(0.82);
  });

  test("模型无 contextWindow 配置（null/0）→ 按引擎 percent（引擎实测值优先）", () => {
    expect(calibrateContextPercent({ tokens: 100, contextWindow: 1000, percent: 10 }, null)).toBe(10);
    expect(calibrateContextPercent({ tokens: 100, contextWindow: 1000, percent: 10 }, 0)).toBe(10);
    expect(calibrateContextPercent({ tokens: 100, contextWindow: 1000, percent: 10 }, undefined)).toBe(10);
  });

  test("兜底重算超 100% 钳制到 100，负值/零钳到 0", () => {
    expect(calibrateContextPercent({ tokens: 8000, contextWindow: 1_000_000, percent: 0.8 }, 4096)).toBe(100);
    expect(calibrateContextPercent({ tokens: 0, contextWindow: 1_000_000, percent: -5 }, 4096)).toBe(0);
  });

  test("选 4K 窗口模型实测分母非 1M（验收 ③ 单测层主断言，注入 models 数据形态）", () => {
    // 模拟真实注入：GET /api/models 所选模型行 contextWindow=4096，引擎上报仍是 1M 旧分母
    const modelsRow = { provider: "zai-coding-cn", id: "glm-tiny", contextWindow: 4096 };
    const engineCtx = { tokens: 3072, contextWindow: 1_000_000, percent: 0.3072 };
    const pct = calibrateContextPercent(engineCtx, modelsRow.contextWindow);
    expect(pct).toBe(75); // 3072/4096——分母是 4K，不是 1M
  });
});
