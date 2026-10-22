// 消息 footer 溯源行纯函数单测（docs08 2026-10-22 批次任务 17）：message-origin.ts。
// 时间戳实录形态沿任务 7 口径：entry.timestamp 为 ISO 字符串（jsonl 实测），
// message.timestamp 为 ms 数字（message 帧实测）；缺失一律 null——不显示不占位。
import { describe, expect, test } from "vitest";
import { originAgentName, originDurationLabel } from "../message-origin";
import type { WireEntry } from "@/lib/api";

function entry(partial: Record<string, unknown>): WireEntry {
  return partial as WireEntry;
}

const USER = (id: string, timestamp: string): WireEntry =>
  entry({ type: "message", id, timestamp, message: { role: "user", content: [{ type: "text", text: "q" }] } });

const ASSISTANT = (id: string, timestamp: string, model?: string): WireEntry =>
  entry({
    type: "message",
    id,
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text: "a" }], ...(model ? { model } : {}) },
  });

describe("originAgentName（引擎 deriveAgentName 同通道：custom 条目 data.agentName/agent）", () => {
  test("条目之前的 custom data.agentName 命中；data.agent 回落", () => {
    const entries = [
      USER("u1", "2026-10-22T10:00:00.000Z"),
      entry({ type: "custom", id: "c1", data: { agentName: "Sisyphus" }, timestamp: "2026-10-22T10:00:01.000Z" }),
      ASSISTANT("a1", "2026-10-22T10:09:46.000Z"),
    ];
    expect(originAgentName(entries, "a1")).toBe("Sisyphus");
    const fallback = [
      USER("u1", "2026-10-22T10:00:00.000Z"),
      entry({ type: "custom", id: "c1", data: { agent: "ultraworker" }, timestamp: "2026-10-22T10:00:01.000Z" }),
      ASSISTANT("a1", "2026-10-22T10:01:00.000Z"),
    ];
    expect(originAgentName(fallback, "a1")).toBe("ultraworker");
  });

  test("agentName 优先于 agent；标注晚于条目不回溯适用；空串/无名/无 custom → null", () => {
    const both = [
      entry({ type: "custom", id: "c0", data: { agent: "fallback", agentName: "primary" } }),
      ASSISTANT("a1", "2026-10-22T10:01:00.000Z"),
    ];
    expect(originAgentName(both, "a1")).toBe("primary");
    const later = [
      ASSISTANT("a1", "2026-10-22T10:01:00.000Z"),
      entry({ type: "custom", id: "c1", data: { agentName: "later" } }),
    ];
    expect(originAgentName(later, "a1")).toBeNull();
    const empty = [
      entry({ type: "custom", id: "c0", data: { agentName: "" } }),
      entry({ type: "custom", id: "c1", data: { agentName: null } }),
      ASSISTANT("a1", "2026-10-22T10:01:00.000Z"),
    ];
    expect(originAgentName(empty, "a1")).toBeNull();
    expect(originAgentName([USER("u1", "2026-10-22T10:00:00.000Z"), ASSISTANT("a1", "2026-10-22T10:01:00.000Z")], "a1")).toBeNull();
    expect(originAgentName(undefined, "a1")).toBeNull();
    expect(originAgentName([ASSISTANT("a1", "2026-10-22T10:01:00.000Z")], "missing")).toBeNull();
  });
});

describe("originDurationLabel（最近更早 user 消息锚点的时间戳差）", () => {
  test("user→assistant 回合差：9m46s；锚点取最近一条 user（steer 中途插入重置锚点）", () => {
    const entries = [
      USER("u1", "2026-10-22T10:00:00.000Z"),
      ASSISTANT("a1", "2026-10-22T10:09:46.000Z"),
    ];
    expect(originDurationLabel(entries, "a1")).toBe("9m 46s");
    const steered = [
      USER("u1", "2026-10-22T10:00:00.000Z"),
      ASSISTANT("a1", "2026-10-22T10:01:00.000Z"),
      USER("u2", "2026-10-22T10:02:00.000Z"),
      ASSISTANT("a2", "2026-10-22T10:03:30.000Z"),
    ];
    expect(originDurationLabel(steered, "a2")).toBe("1m 30s");
  });

  test("message.timestamp ms 数字回落（message 帧形态）；同秒差显 0.0s 非空", () => {
    const msForm = [
      USER("u1", "2026-10-22T10:00:00.000Z"),
      entry({ type: "message", id: "a1", message: { role: "assistant", timestamp: 1792663560000 } }),
    ];
    // entry.timestamp 缺失 → message.timestamp（2026-10-22T10:06:00.000Z）− 10:00:00 = 6m
    expect(originDurationLabel(msForm, "a1")).toBe("6m 0s");
    const sameSecond = [
      USER("u1", "2026-10-22T10:00:00.000Z"),
      ASSISTANT("a1", "2026-10-22T10:00:00.000Z"),
    ];
    expect(originDurationLabel(sameSecond, "a1")).toBe("0.0s");
    expect(originDurationLabel([USER("u1", "2026-10-22T10:00:00.000Z"), ASSISTANT("a1", "2026-10-22T10:00:00.400Z")], "a1")).toBe("0.4s");
  });

  test("缺省省略：无 user 锚点 / 本条目或锚点时间戳缺失 / 条目不在列 → null", () => {
    expect(originDurationLabel([ASSISTANT("a1", "2026-10-22T10:01:00.000Z")], "a1")).toBeNull();
    expect(originDurationLabel([USER("u1", "2026-10-22T10:00:00.000Z"), ASSISTANT("a1", undefined as unknown as string)], "a1")).toBeNull();
    expect(originDurationLabel([USER("u1", undefined as unknown as string), ASSISTANT("a1", "2026-10-22T10:01:00.000Z")], "a1")).toBeNull();
    expect(originDurationLabel(undefined, "a1")).toBeNull();
    expect(originDurationLabel([ASSISTANT("a1", "2026-10-22T10:01:00.000Z")], "missing")).toBeNull();
  });
});
