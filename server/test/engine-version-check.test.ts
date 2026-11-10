// 引擎版本分叉断言单测（engine-upgrade-5169 批 4b）：
// - engineVersionMismatch 纯比对：一致 null / 不一致告警文案 / 任一侧不可解析告警；
// - enginePkgVersionFromCliPath：tmp fixture 上溯 package.json 命中官配名与版本；
// - runEngineVersionCheck：注入双版本与 warn 收集，一致不告警、不一致告警一次。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  enginePkgVersionFromCliPath,
  engineVersionMismatch,
  runEngineVersionCheck,
} from "../src/engine/version-check";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeEngineFixture(version: string): string {
  const root = mkdtempSync(join(tmpdir(), "ul-version-check-"));
  tempDirs.push(root);
  const pkgDir = join(root, "node_modules", "@code-yeongyu", "senpi");
  mkdirSync(join(pkgDir, "dist", "bundle"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@code-yeongyu/senpi", version }));
  const cliPath = join(pkgDir, "dist", "bundle", "cli.js");
  writeFileSync(cliPath, "// stub\n");
  return cliPath;
}

describe("engineVersionMismatch", () => {
  test("一致：null 不告警", () => {
    expect(engineVersionMismatch("2026.11.10-2", "2026.11.10-2")).toBeNull();
  });

  test("不一致：告警文案含两侧版本", () => {
    const msg = engineVersionMismatch("2026.11.5-1", "2026.11.10-2");
    expect(msg).toContain("engine-version-mismatch");
    expect(msg).toContain("2026.11.5-1");
    expect(msg).toContain("2026.11.10-2");
  });

  test("任一侧不可解析：告警文案（unknown）", () => {
    expect(engineVersionMismatch(null, "2026.11.10-2")).toContain("engine-version-mismatch");
    expect(engineVersionMismatch("2026.11.10-2", null)).toContain("unknown");
  });
});

describe("enginePkgVersionFromCliPath", () => {
  test("cli.js 上溯命中官配 package.json 版本", () => {
    const cliPath = makeEngineFixture("2026.11.10-2");
    expect(enginePkgVersionFromCliPath(cliPath)).toBe("2026.11.10-2");
  });

  test("无 package.json 可命中：null", () => {
    const root = mkdtempSync(join(tmpdir(), "ul-version-check-none-"));
    tempDirs.push(root);
    expect(enginePkgVersionFromCliPath(join(root, "cli.js"))).toBeNull();
  });
});

describe("runEngineVersionCheck", () => {
  test("不一致：告警一次；一致：不告警", () => {
    const warns: string[] = [];
    runEngineVersionCheck({
      hostVersion: () => "2026.11.5-1",
      engineVersion: () => "2026.11.10-2",
      warn: (m) => warns.push(m),
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("engine-version-mismatch");

    runEngineVersionCheck({
      hostVersion: () => "2026.11.10-2",
      engineVersion: () => "2026.11.10-2",
      warn: (m) => warns.push(m),
    });
    expect(warns).toHaveLength(1);
  });
});
