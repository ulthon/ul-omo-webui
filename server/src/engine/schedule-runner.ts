// schedule runner 托管监督（docs08 plan 任务 21）：server 启动拉起引擎
// `omo schedule run --watch` 子进程（到期触发的引擎侧本体），退出退避重启，
// 关停随 server。投递走 --exec 钩子：事件 JSON POST 回本进程 deliver 端点，
// 排队语义自动生效。
//
// 防误杀标识（orphan-reaper 判定纪律）：本子进程 argv 虽含引擎 cli 本体，但
// (a) 不登记进引擎 PID registry（判定 1 不命中）；(b) cwd 固定为 webui 运行
// 数据目录（判定 2 要求 cwd 精确等于管辖项目目录，永不命中）。
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ScheduleRunnerOptions {
  /** 引擎 cli 本体绝对路径（process-manager resolveEnginePaths 同源） */
  cliPath: string;
  /** 引擎 agent 目录（显式 OMO_CODING_AGENT_DIR，spawn 规范） */
  agentDir: string;
  /** webui 运行数据目录：hook 脚本落点 + runner cwd（防 orphan-reaper 判定 2） */
  dataDir: string;
  /** 投递回注端点 URL（含 host:port） */
  deliverUrl: string;
  /** 投递回注 bearer token */
  deliverToken: string;
  /** spawn 注入（测试替身）；缺省 node:child_process.spawn */
  spawnImpl?: typeof spawn;
  /** 退避基值/上限 ms */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  now?: () => number;
}

const RUNNER_POLL_SECONDS = 15;

/** 投递钩子脚本：stdin 收引擎 ScheduledPromptEvent JSON，POST 回 webui deliver 端点。
 * 运行期写入 DATA_DIR（源码/编译两形态通用），环境经 runner 继承（引擎契约：钩子
 * 继承 runner 环境）。 */
export function writeDeliverHookScript(dataDir: string): string {
  const path = join(dataDir, "schedule-deliver-hook.mjs");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    `// ul-omo-webui schedule 投递钩子（服务端启动时生成，勿手改）
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", async () => {
  try {
    const res = await fetch(process.env.UL_OMO_WEBUI_SCHEDULE_DELIVER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + process.env.UL_OMO_WEBUI_SCHEDULE_DELIVER_TOKEN },
      body: raw,
    });
    process.exit(res.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
});
`,
    { mode: 0o600 },
  );
  return path;
}

/** 退化判定：spawn 连续失败（如引擎 bundle 缺失）时降级为「列表+取消只读」 */
export class ScheduleRunnerSupervisor {
  private child: ChildProcess | null = null;
  private stopped = true;
  private restarts = 0;
  private backoffTimer: NodeJS.Timeout | null = null;
  private readonly spawnImpl: typeof spawn;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly now: () => number;
  private readonly hookPath: string;

  constructor(private readonly opts: ScheduleRunnerOptions) {
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.hookPath = writeDeliverHookScript(opts.dataDir);
  }

  /** runner 存活态（子进程在运行且未停止中） */
  alive(): boolean {
    return this.child !== null && this.stopped === false && this.child.exitCode === null;
  }

  /** 连续 spawn 失败达上限 → 降级只读（POST 禁用，列表/取消仍可用） */
  degraded(): boolean {
    return this.consecutiveSpawnFailures >= 3;
  }

  private consecutiveSpawnFailures = 0;

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.spawnChild();
  }

  private spawnChild(): void {
    if (this.stopped) return;
    let child: ChildProcess;
    try {
      child = this.spawnImpl(
        process.execPath,
        [this.opts.cliPath, "schedule", "run", "--watch", "--poll-seconds", String(RUNNER_POLL_SECONDS), "--exec", `"${process.execPath}" "${this.hookPath}"`],
        {
          cwd: this.opts.dataDir,
          env: {
            ...process.env,
            OMO_CODING_AGENT_DIR: this.opts.agentDir,
            SENPI_CODING_AGENT_DIR: this.opts.agentDir,
            OMO_NATIVE: "1",
            PI_OFFLINE: "1",
            UL_OMO_WEBUI_SCHEDULE_DELIVER_URL: this.opts.deliverUrl,
            UL_OMO_WEBUI_SCHEDULE_DELIVER_TOKEN: this.opts.deliverToken,
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
    } catch (err) {
      this.onSpawnFailure(err);
      return;
    }
    this.consecutiveSpawnFailures = 0;
    this.child = child;
    child.on("error", (err) => this.onSpawnFailure(err));
    child.stderr?.on("data", (chunk: Buffer) => {
      console.warn(`[schedule-runner] ${chunk.toString("utf8").trimEnd()}`);
    });
    child.on("exit", (code, signal) => {
      this.child = null;
      if (this.stopped) return;
      console.warn(`[schedule-runner] runner 退出（code=${code} signal=${signal ?? "null"}），退避重启`);
      this.scheduleRestart();
    });
  }

  private onSpawnFailure(err: unknown): void {
    if (this.stopped) return;
    this.consecutiveSpawnFailures += 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[schedule-runner] 启动失败（连续 ${this.consecutiveSpawnFailures} 次）：${msg}`);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.backoffTimer) return;
    const delay = Math.min(this.backoffBaseMs * 2 ** this.restarts, this.backoffMaxMs);
    this.restarts += 1;
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.spawnChild();
    }, delay);
    this.backoffTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
