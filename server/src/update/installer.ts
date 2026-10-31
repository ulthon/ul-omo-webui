// 更新安装（2026-10-31 update 批，M3）：npm -g 安装 + 延迟重启调度，模块级互斥。
// - 仅 Linux 支持：npm -g 装的是目标包、不动运行中代码，失败也不影响存活（500+logTail）。
// - 成功 → systemd-run --on-active=3s 调度重启命令（异步但验证落地，失败写入日志）；进程退出由路由层
//   响应 200 后经注入的 shutdown 优雅收口（systemd Restart=on-failure 下显式 restart 双保险）。
// - 每次运行追加 DATA_DIR/update-install.log（openchamber 同名先例）：start 行 + 子进程
//   输出 + result 行。
// - 互斥：同刻仅一次安装；失败解锁，成功刻意不解（进程已进入关停窗口，防二次触发）。
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { registryBase, webuiPackageName } from "./checker";

const INSTALL_TIMEOUT_MS = 300_000;
const LOG_TAIL_CHARS = 500;
const SYSTEMD_UNIT_FILE = "/etc/systemd/system/ul-omo-webui.service";

export type UpdateTarget = "webui" | "engine";

/** npm 子进程执行形状（测试注入）；失败统一抛 InstallSpawnError */
export type RunInstallFn = (
  file: string,
  args: string[],
  opts: { readonly timeout: number },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

/** npm 安装失败（非零退出/超时/无法启动），输出已捕获 */
export class InstallSpawnError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "InstallSpawnError";
  }
}

export interface InstallFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly logTail?: string;
}

export type InstallResult = { readonly restarting: true; readonly version: string } | InstallFailure;

export interface InstallDeps {
  /** 运行数据目录（update-install.log 落点，服务端启动已保证存在） */
  readonly dataDir: string;
  readonly now?: () => Date;
  /** npm 执行注入（测试）；缺省 execFile 包装（超时杀进程，输出全捕获） */
  readonly runInstall?: RunInstallFn;
  /** 重启调度注入（测试）；缺省 systemd-run 3s 延迟触发 */
  readonly scheduleRestart?: (restartCmd: string) => void;
  /** 平台覆盖（测试注入 501 路径） */
  readonly platform?: string;
}

/** execFile 包装：stdout/stderr 捕获，超时杀进程，失败归一为 InstallSpawnError */
const defaultRunInstall: RunInstallFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: opts.timeout, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err !== null) reject(new InstallSpawnError(err.message, String(stdout), String(stderr)));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** 重启命令：env > 系统级 unit 存在 → system 级，否则用户级 */
function resolveRestartCmd(): string {
  const env = process.env.UL_OMO_WEBUI_UPDATE_RESTART_CMD?.trim();
  if (env !== undefined && env !== "") return env;
  return existsSync(SYSTEMD_UNIT_FILE)
    ? "systemctl restart ul-omo-webui"
    : "systemctl --user restart ul-omo-webui";
}

/** fire-and-forget 但验证调度落地：systemd-run 失败/非零退出写入更新日志（openchamber #1862 教训：哑火即死服务） */
function defaultScheduleRestart(restartCmd: string, onIssue?: (msg: string) => void): void {
  const fail = (msg: string): void => {
    (onIssue ?? ((m: string) => console.error(`[update] ${m}`)))(msg);
  };
  const child = spawn("systemd-run", ["--on-active=3s", ...restartCmd.split(/\s+/)], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", (e: Error) => fail(`[restart-scheduler] systemd-run spawn 失败: ${e.message}`));
  child.stderr?.on("data", (d: Buffer) => {
    const s = String(d).trim();
    if (s !== "") fail(`[restart-scheduler] systemd-run stderr: ${s.slice(0, 200)}`);
  });
  child.on("exit", (code: number | null) => {
    if (code !== 0) fail(`[restart-scheduler] systemd-run 退出码 ${code}`);
  });
  child.unref();
}

// 模块级互斥（单实例假设与 config-store 同）：同刻仅一次安装
let installInFlight = false;

export async function installUpdate(
  deps: InstallDeps,
  target: UpdateTarget,
  version: string,
): Promise<InstallResult> {
  if ((deps.platform ?? process.platform) !== "linux") {
    return { status: 501, code: "update_unsupported", message: "Windows 更新暂不支持，请在终端手动更新" };
  }
  if (installInFlight) {
    return { status: 409, code: "update_in_progress", message: "更新已在进行中" };
  }
  installInFlight = true;
  const result = await runInstall(deps, target, version);
  if (!("restarting" in result)) installInFlight = false; // 失败解锁；成功保持（进程即将关停）
  return result;
}

async function runInstall(deps: InstallDeps, target: UpdateTarget, version: string): Promise<InstallResult> {
  const now = deps.now ?? (() => new Date());
  const run = deps.runInstall ?? defaultRunInstall;
  mkdirSync(deps.dataDir, { recursive: true });
  const logPath = join(deps.dataDir, "update-install.log");
  const appendLog = (line: string): void => {
    try {
      appendFileSync(logPath, `${line}\n`);
    } catch {
      // 日志尽力而为：落盘失败不阻断安装本身
    }
  };

  const pkg = webuiPackageName();
  const base = registryBase();
  appendLog(`[${now().toISOString()}] start target=${target} version=${version} pkg=${pkg} registry=${base ?? "unresolved"}`);
  if (base === null) {
    appendLog(`[${now().toISOString()}] result failed: 无法确定 npm registry 基址`);
    return { status: 500, code: "registry_unresolved", message: "无法确定 npm registry 基址" };
  }

  let out: { readonly stdout: string; readonly stderr: string };
  try {
    out = await run("npm", ["install", "-g", `${pkg}@${version}`, "--registry", base], {
      timeout: INSTALL_TIMEOUT_MS,
    });
  } catch (err) {
    const failure = err instanceof InstallSpawnError
      ? err
      : new InstallSpawnError(err instanceof Error ? err.message : String(err), "", "");
    appendLog(failure.stdout);
    appendLog(failure.stderr);
    appendLog(`[${now().toISOString()}] result failed: ${failure.message}`);
    return {
      status: 500,
      code: "npm_install_failed",
      message: "npm install 失败",
      logTail: `${failure.stdout}\n${failure.stderr}`.trim().slice(-LOG_TAIL_CHARS),
    };
  }

  appendLog(out.stdout);
  appendLog(out.stderr);
  const restartCmd = resolveRestartCmd();
  const schedule: (restartCmd: string) => void =
    deps.scheduleRestart ?? ((cmd: string) => defaultScheduleRestart(cmd, appendLog));
  schedule(restartCmd);
  appendLog(`[${now().toISOString()}] scheduled restart: systemd-run --on-active=3s ${restartCmd}`);
  appendLog(`[${now().toISOString()}] result ok version=${version}`);
  return { restarting: true, version };
}
