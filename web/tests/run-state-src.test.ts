// runState 写入来源留痕单测（观测面补点 2026-11-18）：setRunState 迁移日志携带 src
// （frame:<type>[/method]、reconcile/resync/sweep/markAlias-clear 等）——waiting 毒化
// 排查只凭 from/to 无法归因「哪条路径写的」；同值写入不记（既有口径）；周期清扫超时
// 回落记 src=sweep（不增序号语义不变）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { diag } from "@/lib/diag";
import { useSessionsStore, WAITING_STALE_MS } from "@/stores/sessions";

let spy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  spy = vi.spyOn(diag, "info");
});

afterEach(() => {
  spy?.mockRestore();
  useSessionsStore.setState({ runStates: {}, runStateAt: {}, runStateSeq: {} });
});

describe("runState 写入来源留痕", () => {
  test("setRunState 迁移日志带 src；同值写入不记", () => {
    useSessionsStore.getState().setRunState("d-1", "waiting", "frame:extension_ui_request/xyz");
    expect(spy).toHaveBeenCalledWith("run", "state", {
      session: "d-1",
      from: "-",
      to: "waiting",
      src: "frame:extension_ui_request/xyz",
    });
    spy?.mockClear();
    useSessionsStore.getState().setRunState("d-1", "waiting", "frame:extension_ui_request/xyz");
    expect(spy).not.toHaveBeenCalled();
  });

  test("周期清扫超时回落记 src=sweep", () => {
    const now = Date.now();
    useSessionsStore.setState({
      runStates: { "d-2": "waiting" },
      runStateAt: { "d-2": now - WAITING_STALE_MS - 1000 },
    });
    useSessionsStore.getState().sweepStaleRunStates(now);
    expect(useSessionsStore.getState().runStates["d-2"]).toBe("idle");
    expect(spy).toHaveBeenCalledWith("run", "state", { session: "d-2", from: "waiting", to: "idle", src: "sweep" });
  });

  test("markAliasId 入口归零清残留记 from→\"-\"（src=markAlias-clear）", () => {
    useSessionsStore.setState({ runStates: { "d-3": "waiting" }, runStateAt: { "d-3": Date.now() } });
    useSessionsStore.getState().markAliasId("d-3");
    expect(useSessionsStore.getState().runStates["d-3"]).toBeUndefined();
    expect(spy).toHaveBeenCalledWith("run", "state", { session: "d-3", from: "waiting", to: "-", src: "markAlias-clear" });
  });
});
