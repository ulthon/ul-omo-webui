// commands_changed 事件接线单测（批次三 2026-11-07）：引擎命令面变更帧 bump
// ui store 的 slashCommandsVersion，composer 下拉据此重拉 getCommands（服务端
// 缓存已被同事件失效）；EventsClient 具名事件模型下列表遗漏则 EventSource 不派发
// （queue_update 先例实测教训），列表包含性一并锁定。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { dispatchSseEvent, resetDispatchState } from "@/lib/event-dispatch";
import { EventsClient, disconnectEvents } from "@/lib/events";
import { useUiStore } from "@/stores/ui";
import { MockEventSource, MockScheduler } from "./helpers/mock-sse";

function frame(wire: Record<string, unknown>, cursor: number): void {
  dispatchSseEvent(String(wire.type), JSON.stringify({ projectPath: "/p", event: wire }), cursor);
}

describe("commands_changed 接线（斜杠命令集版本号）", () => {
  beforeEach(() => {
    resetDispatchState();
    useUiStore.setState({ slashCommandsVersion: 0 });
  });
  afterEach(() => {
    resetDispatchState();
  });

  test("帧到达即 bump 版本号（幂等累加，载荷无需字段）", () => {
    frame({ type: "commands_changed", commands: [] }, 1);
    expect(useUiStore.getState().slashCommandsVersion).toBe(1);
    frame({ type: "commands_changed" }, 2);
    expect(useUiStore.getState().slashCommandsVersion).toBe(2);
  });

  test("其他帧类型不动版本号", () => {
    frame({ type: "agent_settled", reason: "idle" }, 3);
    expect(useUiStore.getState().slashCommandsVersion).toBe(0);
  });

  test("EventsClient 真实路径：commands_changed 具名帧派发 bump（HANDLED_EVENT_TYPES 接线，漏列则 MockEventSource 不派发）", () => {
    MockEventSource.reset();
    const scheduler = new MockScheduler();
    const client = new EventsClient({
      createEventSource: ((url: string) => new MockEventSource(url)) as unknown as (url: string) => EventSource,
      schedule: scheduler.schedule,
    });
    client.start();
    const es = MockEventSource.live[0];
    es.emitOpen();
    es.emit("commands_changed", { projectPath: "/p", event: { type: "commands_changed" } }, 5);
    expect(useUiStore.getState().slashCommandsVersion).toBe(1);
    client.stop();
    disconnectEvents();
  });
});
