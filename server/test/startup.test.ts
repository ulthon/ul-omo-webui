import { describe, expect, it } from "vitest";
import { buildSystemdUnit, buildWindowsWrapper, snapshotEnv } from "../src/startup";

describe("startup 环境快照", () => {
  it("只收集 UL_OMO_WEBUI_* 变量", () => {
    const env = snapshotEnv({
      UL_OMO_WEBUI_PORT: "9000",
      UL_OMO_WEBUI_HOST: "127.0.0.1",
      PATH: "/usr/bin",
      HOME: "/root",
    });
    expect(env).toEqual({ UL_OMO_WEBUI_PORT: "9000", UL_OMO_WEBUI_HOST: "127.0.0.1" });
  });

  it("空环境返回空对象", () => {
    expect(snapshotEnv({ PATH: "/usr/bin" })).toEqual({});
  });
});

describe("systemd 单元生成", () => {
  it("包含 ExecStart、Restart 策略与环境快照行", () => {
    const unit = buildSystemdUnit({ UL_OMO_WEBUI_PORT: "9000" }, "/usr/local/bin:/usr/bin");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=3");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain('Environment=UL_OMO_WEBUI_PORT="9000"');
    expect(unit).toContain('Environment=PATH="/usr/local/bin:/usr/bin"');
    expect(unit).toMatch(new RegExp(`ExecStart=${process.execPath} \\S+`));
  });

  it("包含 PATH 环境（引擎 spawn node 依赖）", () => {
    const unit = buildSystemdUnit({}, "/nvm/bin:/usr/bin");
    expect(unit).toContain('Environment=PATH="/nvm/bin:/usr/bin"');
  });

  it("无环境变量时不产生 Environment 行（PATH 除外）", () => {
    const unit = buildSystemdUnit({});
    expect(unit).not.toMatch(/Environment=UL_OMO_WEBUI/);
  });
});

describe("Windows 包装脚本生成", () => {
  it("包含 set 快照与重启循环", () => {
    const cmd = buildWindowsWrapper({ UL_OMO_WEBUI_PORT: "9000" });
    expect(cmd).toContain('set "UL_OMO_WEBUI_PORT=9000"');
    expect(cmd).toContain(":start\r\n");
    expect(cmd).toContain(`"${process.execPath}"`);
    expect(cmd).toContain("timeout /t 3 /nobreak");
    expect(cmd).toContain("goto start");
  });

  it("CRLF 换行", () => {
    expect(buildWindowsWrapper({})).toContain("\r\n");
  });
});
