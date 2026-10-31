// 安装器单测（2026-10-31 update 批）：Windows 501、npm 失败不重启、互斥锁、成功调度重启。
// npm 执行/重启调度全量注入，env 指向 stub 值，不触网、不真跑 systemd-run。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  installUpdate,
  InstallSpawnError,
  type InstallDeps,
  type InstallFailure,
  type InstallResult,
} from "../src/update/installer";

const REGISTRY = "http://registry.test";
const RESTART_CMD = "systemctl restart qa-unit";

const tempDirs: string[] = [];

function makeDeps(overrides: Partial<InstallDeps> = {}): InstallDeps & { restartCmds: string[] } {
  const dataDir = mkdtempSync(join(tmpdir(), "ul-update-test-"));
  tempDirs.push(dataDir);
  const restartCmds: string[] = [];
  return {
    dataDir,
    restartCmds,
    now: () => new Date("2026-10-31T10:00:00.000Z"),
    scheduleRestart: (cmd) => restartCmds.push(cmd),
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.UL_OMO_WEBUI_UPDATE_REGISTRY;
  delete process.env.UL_OMO_WEBUI_UPDATE_PKG;
  delete process.env.UL_OMO_WEBUI_UPDATE_RESTART_CMD;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function expectFailure(result: InstallResult): InstallFailure {
  if ("restarting" in result) throw new Error("预期失败，实际成功");
  return result;
}

describe("installUpdate", () => {
  test("非 Linux 平台：501，不执行 npm、不调度重启", async () => {
    process.env.UL_OMO_WEBUI_UPDATE_REGISTRY = REGISTRY;
    process.env.UL_OMO_WEBUI_UPDATE_PKG = "qa-webui-stub";
    let npmCalled = false;
    const deps = makeDeps({
      platform: "win32",
      runInstall: async () => {
        npmCalled = true;
        return { stdout: "", stderr: "" };
      },
    });
    const result = await installUpdate(deps, "webui", "1.0.1");
    expect(result).toMatchObject({
      status: 501,
      code: "update_unsupported",
      message: "Windows 更新暂不支持，请在终端手动更新",
    });
    expect(npmCalled).toBe(false);
    expect(deps.restartCmds).toHaveLength(0);
  });

  test("npm 失败：500 + logTail，不调度重启，锁释放可重试", async () => {
    process.env.UL_OMO_WEBUI_UPDATE_REGISTRY = REGISTRY;
    process.env.UL_OMO_WEBUI_UPDATE_PKG = "qa-webui-stub";
    process.env.UL_OMO_WEBUI_UPDATE_RESTART_CMD = RESTART_CMD;
    let calls = 0;
    const deps = makeDeps({
      runInstall: async () => {
        calls++;
        throw new InstallSpawnError("Command failed: npm install", "added nothing", "npm ERR! network unreachable");
      },
    });
    const failure = expectFailure(await installUpdate(deps, "webui", "1.0.1"));
    expect(failure.status).toBe(500);
    expect(failure.code).toBe("npm_install_failed");
    expect(failure.message).toBe("npm install 失败");
    expect(failure.logTail).toContain("npm ERR! network unreachable");
    expect(deps.restartCmds).toHaveLength(0);
    // 锁已释放：重试再次进入 npm 执行（而非 409）
    expectFailure(await installUpdate(deps, "webui", "1.0.1"));
    expect(calls).toBe(2);
    const log = readFileSync(join(deps.dataDir, "update-install.log"), "utf8");
    expect(log).toContain("start target=webui version=1.0.1 pkg=qa-webui-stub");
    expect(log).toContain("npm ERR! network unreachable");
    expect(log).toContain("result failed");
  });

  test("互斥：进行中二次调用 409，首次失败后解锁", async () => {
    process.env.UL_OMO_WEBUI_UPDATE_REGISTRY = REGISTRY;
    process.env.UL_OMO_WEBUI_UPDATE_PKG = "qa-webui-stub";
    process.env.UL_OMO_WEBUI_UPDATE_RESTART_CMD = RESTART_CMD;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps({
      runInstall: () =>
        gate.then(() => {
          throw new InstallSpawnError("boom", "", "err");
        }),
    });
    // 首调用已同步取得锁并挂起；此刻的二次调用必须 409
    const first = installUpdate(deps, "webui", "1.0.1");
    const second = await installUpdate(deps, "webui", "1.0.1");
    expect(second).toMatchObject({ status: 409, code: "update_in_progress", message: "更新已在进行中" });
    expect(deps.restartCmds).toHaveLength(0);
    release();
    expectFailure(await first);
  });

  test("成功：npm 参数正确、调度重启命令、日志 result ok、返回 restarting", async () => {
    process.env.UL_OMO_WEBUI_UPDATE_REGISTRY = REGISTRY;
    process.env.UL_OMO_WEBUI_UPDATE_PKG = "qa-webui-stub";
    process.env.UL_OMO_WEBUI_UPDATE_RESTART_CMD = RESTART_CMD;
    const calls: Array<{ file: string; args: string[] }> = [];
    const deps = makeDeps({
      runInstall: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "added 1 package", stderr: "" };
      },
    });
    const result = await installUpdate(deps, "webui", "1.0.1");
    if (!("restarting" in result)) throw new Error("预期成功，实际失败");
    expect(result.version).toBe("1.0.1");
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("npm");
    expect(calls[0].args).toEqual(["install", "-g", "qa-webui-stub@1.0.1", "--registry", REGISTRY]);
    expect(deps.restartCmds).toEqual([RESTART_CMD]);
    const log = readFileSync(join(deps.dataDir, "update-install.log"), "utf8");
    expect(log).toContain("scheduled restart: systemd-run --on-active=3s systemctl restart qa-unit");
    expect(log).toContain("result ok version=1.0.1");
  });
});
