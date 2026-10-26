import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSystemdUnit, buildWindowsWrapper, runStartup, snapshotEnv } from "../src/startup";

// 端到端注入：截获 fs 写/chmod 与 systemctl 子进程，测试不落盘、不触真实 systemctl
const io = vi.hoisted(() => ({
  writes: [] as Array<{ path: string; content: string }>,
  chmods: [] as Array<{ path: string; mode: number }>,
  removed: [] as string[],
  spawns: [] as string[][],
  existsPaths: new Set<string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (p: unknown, c: unknown) => {
      io.writes.push({ path: String(p), content: String(c) });
    },
    chmodSync: (p: unknown, m: unknown) => {
      io.chmods.push({ path: String(p), mode: Number(m) });
    },
    mkdirSync: () => undefined,
    existsSync: (p: unknown) => io.existsPaths.has(String(p)),
    rmSync: (p: unknown) => {
      io.removed.push(String(p));
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (cmd: unknown, args: readonly unknown[] = []) => {
      io.spawns.push([String(cmd), ...args.map(String)]);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
});

const USER_UNIT = join(homedir(), ".config", "systemd", "user", "ul-omo-webui.service");
const SYSTEM_UNIT = "/etc/systemd/system/ul-omo-webui.service";

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

describe("systemd 系统级单元生成（--system）", () => {
  it("含 User=root、multi-user.target、网络序与 PATH/密码快照", () => {
    const unit = buildSystemdUnit(
      { UL_OMO_WEBUI_PASSWORD: "secret-pw" },
      "/nvm/bin:/usr/bin",
      { system: true },
    );
    expect(unit).toContain("User=root");
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=3");
    expect(unit).toContain('Environment=PATH="/nvm/bin:/usr/bin"');
    expect(unit).toContain('Environment=UL_OMO_WEBUI_PASSWORD="secret-pw"');
    expect(unit).toMatch(new RegExp(`ExecStart=${process.execPath} \\S+`));
  });

  it("不传 target 保持用户级输出（无 User= 行、default.target）", () => {
    const unit = buildSystemdUnit({}, "/usr/bin");
    expect(unit).not.toContain("User=");
    expect(unit).toContain("WantedBy=default.target");
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

describe("startup CLI --system 部署（Linux，全部 mock）", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    io.writes.length = 0;
    io.chmods.length = 0;
    io.removed.length = 0;
    io.spawns.length = 0;
    io.existsPaths.clear();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("enable 写 /etc/systemd/system 单元、chmod 600、systemctl 无 --user 不碰 linger", async () => {
    await runStartup(["enable", "--system"]);
    expect(io.writes).toHaveLength(1);
    const w = io.writes[0];
    expect(w.path).toBe(SYSTEM_UNIT);
    expect(w.content).toContain("User=root");
    expect(w.content).toContain("After=network-online.target");
    expect(w.content).toContain("WantedBy=multi-user.target");
    expect(w.content).toContain("Restart=on-failure");
    expect(w.content).toContain("RestartSec=3");
    expect(w.content).toMatch(/Environment=PATH=/);
    expect(io.chmods).toEqual([{ path: SYSTEM_UNIT, mode: 0o600 }]);
    const cmds = io.spawns.map((c) => c.join(" "));
    expect(cmds).toContain("systemctl daemon-reload");
    expect(cmds).toContain("systemctl enable --now ul-omo-webui.service");
    expect(cmds.some((c) => c.includes("--user"))).toBe(false);
    expect(cmds.some((c) => c.startsWith("loginctl"))).toBe(false);
  });

  it("enable 把当前 shell 的 UL_OMO_WEBUI_* 密码快照进单元（复用 --user 逻辑）", async () => {
    process.env.UL_OMO_WEBUI_PASSWORD = "secret-pw";
    try {
      await runStartup(["enable", "--system"]);
      expect(io.writes[0].content).toContain('Environment=UL_OMO_WEBUI_PASSWORD="secret-pw"');
    } finally {
      delete process.env.UL_OMO_WEBUI_PASSWORD;
    }
  });

  it("disable 走系统级 disable --now，移除单元并 daemon-reload", async () => {
    io.existsPaths.add(SYSTEM_UNIT);
    await runStartup(["disable", "--system"]);
    const cmds = io.spawns.map((c) => c.join(" "));
    expect(cmds).toContain("systemctl disable --now ul-omo-webui.service");
    expect(cmds).toContain("systemctl daemon-reload");
    expect(io.removed).toEqual([SYSTEM_UNIT]);
    expect(cmds.some((c) => c.includes("--user"))).toBe(false);
  });

  it("status 查询系统级 is-active / is-enabled", async () => {
    await runStartup(["status", "--system"]);
    const cmds = io.spawns.map((c) => c.join(" "));
    expect(cmds).toContain("systemctl is-active ul-omo-webui.service");
    expect(cmds).toContain("systemctl is-enabled ul-omo-webui.service");
    expect(cmds.some((c) => c.includes("--user"))).toBe(false);
  });

  it("--system 可置于子命令前", async () => {
    await runStartup(["--system", "enable"]);
    expect(io.writes[0].path).toBe(SYSTEM_UNIT);
  });
});

describe("startup CLI --user 路径回归（默认目标不变）", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    io.writes.length = 0;
    io.chmods.length = 0;
    io.removed.length = 0;
    io.spawns.length = 0;
    io.existsPaths.clear();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("enable 缺省写用户单元、走 --user systemctl 并尝试 linger，不 chmod", async () => {
    await runStartup(["enable"]);
    expect(io.writes).toHaveLength(1);
    expect(io.writes[0].path).toBe(USER_UNIT);
    expect(io.writes[0].content).toContain("WantedBy=default.target");
    expect(io.writes[0].content).not.toContain("User=");
    const cmds = io.spawns.map((c) => c.join(" "));
    expect(cmds).toContain("systemctl --user daemon-reload");
    expect(cmds).toContain("systemctl --user enable --now ul-omo-webui.service");
    expect(cmds).toContain("loginctl enable-linger");
    expect(io.chmods).toEqual([]);
  });

  it("disable/status 缺省仍走 --user", async () => {
    await runStartup(["disable"]);
    await runStartup(["status"]);
    const cmds = io.spawns.map((c) => c.join(" "));
    expect(cmds).toContain("systemctl --user disable --now ul-omo-webui.service");
    expect(cmds).toContain("systemctl --user is-active ul-omo-webui.service");
    expect(cmds).toContain("systemctl --user is-enabled ul-omo-webui.service");
  });
});
