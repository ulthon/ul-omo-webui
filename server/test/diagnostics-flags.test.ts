// 诊断开关运行时态（2026-10-31 面板化）：env OR 持久态、原子写、重新 init 持久
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDiagnosticsFlags, getDiagnosticsFlags, setDiagnosticsFlags } from "../src/conf/diagnostics-flags";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "diagflag-")); initDiagnosticsFlags(dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("diagnostics-flags", () => {
  test("默认关；写入即生效且持久；可再关", () => {
    expect(getDiagnosticsFlags()).toEqual({ perf: false, sse: false });
    expect(setDiagnosticsFlags({ perf: true })).toEqual({ perf: true, sse: false });
    initDiagnosticsFlags(dir);
    expect(getDiagnosticsFlags().perf).toBe(true);
    setDiagnosticsFlags({ perf: false });
    expect(getDiagnosticsFlags().perf).toBe(false);
  });
});
