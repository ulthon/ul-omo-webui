// step-duration 纯函数单测（docs08 2026-10-22 批次任务 7）：折叠步骤行耗时标签。
// 时间戳实录形态：entry.timestamp 为 ISO 字符串（jsonl 实测），message.timestamp 为
// ms 数字（toolResult 帧形态）；两种都要支持。缺失一律 null——不显示不占位。
import { describe, expect, test } from "vitest";
import {
  entryTimestampMs,
  formatStepDuration,
  stepDurationLabel,
  thinkingDurationLabel,
  toolDurationLabel,
} from "../step-duration";
import type { WireEntry } from "@/lib/api";

function msgEntry(id: string, timestamp: unknown, message?: unknown): WireEntry {
  return { type: "message", id, timestamp, message } as WireEntry;
}

describe("formatStepDuration", () => {
  test("同秒差 → \"0.0s\"（非空非 NaN）", () => {
    expect(formatStepDuration(0)).toBe("0.0s");
    expect(formatStepDuration(400)).toBe("0.4s");
  });

  test("秒级一位小数；负值（乱序/时钟偏移）按 0 收敛", () => {
    expect(formatStepDuration(3800)).toBe("3.8s");
    expect(formatStepDuration(-50)).toBe("0.0s");
  });

  test("分钟级 → \"9m 46s\" 形态（沿 subagent-panel formatDuration 先例，无小时档）", () => {
    expect(formatStepDuration(9 * 60_000 + 46_000)).toBe("9m 46s");
    expect(formatStepDuration(75 * 60_000 + 3_000)).toBe("75m 3s");
  });

  test("59/60/61s 边界：59s 显秒、60s 进位 \"1m 0s\"，永不出现 60.0s/1m 60s（t7 微修）", () => {
    expect(formatStepDuration(59_000)).toBe("59.0s");
    expect(formatStepDuration(59_950)).toBe("1m 0s"); // 整秒四舍五入进位，不显 "60.0s"
    expect(formatStepDuration(60_000)).toBe("1m 0s");
    expect(formatStepDuration(61_000)).toBe("1m 1s");
  });
});

describe("entryTimestampMs", () => {
  test("ISO 字符串与 ms 数字均收敛；缺失/非法 → null", () => {
    expect(entryTimestampMs("2026-10-12T03:05:28.540Z")).toBe(1791774328540);
    expect(entryTimestampMs(1791774328540)).toBe(1791774328540);
    expect(entryTimestampMs(undefined)).toBeNull();
    expect(entryTimestampMs("")).toBeNull();
    expect(entryTimestampMs("not-a-date")).toBeNull();
  });
});

describe("stepDurationLabel", () => {
  test("任一端缺失 → null（老会话不显示标签）", () => {
    expect(stepDurationLabel(null, 1000)).toBeNull();
    expect(stepDurationLabel(1000, null)).toBeNull();
    expect(stepDurationLabel(1000, 4800)).toBe("3.8s");
  });
});

describe("thinkingDurationLabel", () => {
  const entries = [
    msgEntry("a", "2026-10-12T03:05:28.540Z", { role: "assistant" }),
    msgEntry("b", 1791774332340, { role: "assistant" }), // +3.8s
    msgEntry("c", undefined, { role: "assistant" }), // 末条无下一条目 → 无标签
  ];

  test("本条目 → 下一条目时间戳差", () => {
    expect(thinkingDurationLabel(entries, "a")).toBe("3.8s");
  });

  test("缺时间戳 / 末条目 / 条目不存在 → null", () => {
    expect(thinkingDurationLabel(entries, "c")).toBeNull();
    expect(thinkingDurationLabel(entries, "missing")).toBeNull();
    expect(
      thinkingDurationLabel([msgEntry("x", undefined, { role: "assistant" }), msgEntry("y", 1, {})], "x"),
    ).toBeNull();
  });
});

describe("toolDurationLabel", () => {
  const toolCallEntry = msgEntry("call-entry", "2026-10-12T03:05:28.540Z", {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "bash" }],
  });
  const resultEntry = msgEntry("result-entry", 1791774332340, {
    role: "toolResult",
    toolCallId: "tc1",
    content: [{ type: "text", text: "ok" }],
  });

  test("toolCall 条目 → 配对 toolResult 条目时间戳差", () => {
    expect(toolDurationLabel([toolCallEntry, resultEntry], "tc1", "call-entry")).toBe("3.8s");
  });

  test("无配对结果（运行中/缺帧）→ null；toolCall 条目缺失 → null", () => {
    expect(toolDurationLabel([toolCallEntry], "tc1", "call-entry")).toBeNull();
    expect(toolDurationLabel([resultEntry], "tc1", "call-entry")).toBeNull();
  });

  test("结果时间戳缺失（老会话）→ null", () => {
    const noTs = msgEntry("result-entry", undefined, { role: "toolResult", toolCallId: "tc1" });
    expect(toolDurationLabel([toolCallEntry, noTs], "tc1", "call-entry")).toBeNull();
  });
});
