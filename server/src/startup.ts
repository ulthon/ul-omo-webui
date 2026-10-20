/**
 * 自启动服务管理（M1，docs/09-自启动与更新立项.md）。
 *
 * 平台实现：
 * - Linux：systemd --user 服务（~/.config/systemd/user/ul-omo-webui.service），
 *   Restart=on-failure 崩溃自拉起；enable 后提示/尝试 loginctl enable-linger
 *   （不登录常驻，失败仅警告——部分环境无权限）。
 * - Windows：数据目录生成 .cmd 包装脚本（快照环境变量 + 崩溃 3 秒后重启循环），
 *   计划任务 ONLOGON 触发执行该脚本。
 *
 * 环境快照（D5）：enable 时把当前 shell 中所有 UL_OMO_WEBUI_* 变量写入服务定义
 * （systemd 用 Environment= 行；Windows 写进包装脚本 set 语句）。改环境后需重新
 * enable 才生效——与 openchamber startup enable 行为一致。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE_NAME = "ul-omo-webui";
const TASK_NAME = "ul-omo-webui";

/** 服务运行的服务器命令：node <实际入口>。优先 process.argv[1]（被调用的入口脚本），
 * 回退 import.meta.url（bundle 形态下两者同为 dist/index.js；vitest 下仅后者可得）。 */
function serverExecStart(): { exec: string; script: string } {
  const argv1 = process.argv[1];
  const script = argv1 && /index\.js$/.test(argv1) ? argv1 : fileURLToPath(import.meta.url);
  return { exec: process.execPath, script };
}

/** 快照当前环境中的 UL_OMO_WEBUI_* 变量（D5 决策）。 */
export function snapshotEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("UL_OMO_WEBUI_") && v !== undefined) out[k] = v;
  }
  return out;
}

export function buildSystemdUnit(env: Record<string, string>): string {
  const { exec, script } = serverExecStart();
  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment=${k}=${JSON.stringify(v)}`)
    .join("\n");
  return `[Unit]
Description=ul-omo-webui (senpi/omo web workbench)
After=network-online.target

[Service]
ExecStart=${exec} ${script}
Restart=on-failure
RestartSec=3
${envLines}

[Install]
WantedBy=default.target
`;
}

export function buildWindowsWrapper(env: Record<string, string>): string {
  const { exec, script } = serverExecStart();
  const setLines = Object.entries(env)
    .map(([k, v]) => `set "${k}=${v}"`)
    .join("\r\n");
  // 崩溃后 3 秒重启循环，对齐 systemd Restart=on-failure/RestartSec=3
  return `@echo off\r\n${setLines}\r\n:start\r\n"${exec}" "${script}"\r\ntimeout /t 3 /nobreak >nul\r\ngoto start\r\n`;
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function usage(): never {
  console.error("用法：ul-omo-webui startup <enable|disable|status>");
  process.exit(1);
}

function run(cmd: string[], opts: { allowFail?: boolean } = {}): { ok: boolean; output: string } {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  const output = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  if (r.status !== 0 && !opts.allowFail) {
    die(`命令失败：${cmd.join(" ")}\n${output}`);
  }
  return { ok: r.status === 0, output };
}

// ---- Linux（systemd --user）----

function unitPath(): string {
  return join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

function linuxEnable(): void {
  const env = snapshotEnv();
  const unit = buildSystemdUnit(env);
  mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
  writeFileSync(unitPath(), unit, "utf8");
  run(["systemctl", "--user", "daemon-reload"]);
  run(["systemctl", "--user", "enable", "--now", `${SERVICE_NAME}.service`]);
  // 不登录常驻；无权限环境（无 polkit/非 login 会话）仅警告不失败
  const linger = run(["loginctl", "enable-linger"], { allowFail: true });
  if (!linger.ok) {
    console.warn(
      `警告：loginctl enable-linger 失败，未登录时服务不会自动运行（${linger.output || "无输出"}）。`,
    );
  }
  console.log(`已启用自启动：${unitPath()}`);
  if (Object.keys(env).length > 0) {
    console.log(`已快照环境变量：${Object.keys(env).join(", ")}（改动后需重新 enable）`);
  }
}

function linuxDisable(): void {
  run(["systemctl", "--user", "disable", "--now", `${SERVICE_NAME}.service`], { allowFail: true });
  if (existsSync(unitPath())) {
    rmSync(unitPath());
    run(["systemctl", "--user", "daemon-reload"]);
  }
  console.log("已停用并移除自启动服务。");
}

function linuxStatus(): void {
  const active = run(["systemctl", "--user", "is-active", `${SERVICE_NAME}.service`], {
    allowFail: true,
  });
  const enabled = run(["systemctl", "--user", "is-enabled", `${SERVICE_NAME}.service`], {
    allowFail: true,
  });
  console.log(`服务状态：${active.output || "unknown"}`);
  console.log(`开机自启：${enabled.output || "unknown"}`);
}

// ---- Windows（计划任务 + 包装脚本）----

function wrapperPath(): string {
  const dataDir =
    process.env.UL_OMO_WEBUI_DATA_DIR ??
    join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "ul-omo-webui");
  return join(dataDir, "startup-task.cmd");
}

function winEnable(): void {
  const env = snapshotEnv();
  mkdirSync(dirname(wrapperPath()), { recursive: true });
  writeFileSync(wrapperPath(), buildWindowsWrapper(env), "utf8");
  run([
    "schtasks",
    "/Create",
    "/TN",
    TASK_NAME,
    "/SC",
    "ONLOGON",
    "/TR",
    `"${wrapperPath()}"`,
    "/F",
  ]);
  console.log(`已启用自启动：计划任务 ${TASK_NAME}（登录时执行 ${wrapperPath()}，崩溃 3 秒后自动重启）`);
  if (Object.keys(env).length > 0) {
    console.log(`已快照环境变量：${Object.keys(env).join(", ")}（改动后需重新 enable）`);
  }
}

function winDisable(): void {
  run(["schtasks", "/End", "/TN", TASK_NAME], { allowFail: true });
  run(["schtasks", "/Delete", "/TN", TASK_NAME, "/F"], { allowFail: true });
  if (existsSync(wrapperPath())) rmSync(wrapperPath());
  console.log("已停用并移除自启动任务。");
}

function winStatus(): void {
  const q = run(["schtasks", "/Query", "/TN", TASK_NAME], { allowFail: true });
  if (q.ok) {
    console.log(`任务存在：${TASK_NAME}`);
    console.log(q.output);
  } else {
    console.log("任务不存在（未启用自启动）。");
  }
}

// ---- 分发 ----

export async function runStartup(args: string[]): Promise<void> {
  const [cmd] = args;
  if (!cmd) usage();
  if (process.platform === "win32") {
    if (cmd === "enable") winEnable();
    else if (cmd === "disable") winDisable();
    else if (cmd === "status") winStatus();
    else usage();
  } else if (process.platform === "linux") {
    if (cmd === "enable") linuxEnable();
    else if (cmd === "disable") linuxDisable();
    else if (cmd === "status") linuxStatus();
    else usage();
  } else {
    die(`暂不支持平台 ${process.platform}（第一版仅 Linux 与 Windows，见 docs/09）。`);
  }
  process.exit(0);
}
