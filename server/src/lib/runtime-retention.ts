// 启动小项集(engine-open-read-batch 任务 8):①boot git 诊断(commit/dirty/版本告警)
// ②runtime 保留 30d——transcripts 按会话目录整删、reflection 保最近 N run、
// facts-queue 已消费条目按龄清。两者均为 onListening 后一次性任务(index.ts 装配,
// 先例:purgeStaleAttachments),失败只 warn 不阻塞请求。
//
// 删除安全三原则:
// 1) DRY-RUN 默认——enabled=false 仅日志输出可删清单;meta_kv
//    runtime.retentionEnabled="true" 才实删(index.ts 读开关);
// 2) realpath 守卫——三刀子目录与每个删除目标的 realpath 都必须落在该 runtime
//    目录的 realpath 之内,符号链接逃逸一律拒删并计数;
// 3) 名字白名单——transcripts 只删 UUIDv7 目录名、reflection 只删 reflection-run-N、
//    facts-queue 只删队列条目文件名正则;claims/failures/consumed/cursor 等台账与
//    active.lock/pending.json 一概不碰(引擎在途状态)。
//
// runtime 目录定位与 routes-memory.ts 同源:memoryHome = OMO_MEMORY_HOME ||
// ~/.omo/memory;identity = slugify(basename)+ "-" + sha256(项目绝对路径)[:8]
// (2026-11-06 实证:/data/projects/senpi-webui → senpi-webui-cd6e6588 与磁盘一致)。
// 只清 webui 已登记项目派生出的 runtime,不扫全 agents(其他代理的 runtime 不越权)。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { log } from "../obs/logger";

// ---------------------------------------------------------------------------
// ① boot git 诊断
// ---------------------------------------------------------------------------

/** spawnSync 超时(routes-git.ts GIT_TIMEOUT_MS 同款风格;挂死的 git 命令按超时杀) */
const GIT_TIMEOUT_MS = 10_000;
/** 推荐最低 git 版本:2.39(2026-11-05 实录死锁链阈值,见下方 WARN 文案) */
const GIT_MIN_RECOMMENDED = [2, 39, 0] as const;

export interface BootGitOptions {
  /** git 工作目录(缺省 process.cwd();非 git 目录静默降级) */
  cwd?: string;
  /** git 可执行(缺省 "git";测试注入不存在的路径模拟无 git 环境) */
  gitBinary?: string;
}

export interface BootGitResult {
  gitAvailable: boolean;
  version: string | null;
  /** version < 2.39 */
  stale: boolean;
  inRepo: boolean;
  commit: string | null;
  dirty: boolean;
}

/** 解析 `git version 2.39.5` → "2.39.5";不匹配返回 null */
function parseGitVersion(stdout: string): string | null {
  const m = stdout.match(/git version (\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

/** 版本比较:a < b 返回负数(逐段数值比较;缺段按 0) */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 启动 git 诊断:spawnSync 三连(--version / rev-parse HEAD / status --porcelain)。
 * 任何失败(git 缺失/超时/非 git 目录/dubious ownership)一律静默降级,绝不抛出。
 * 日志:仓库内 log.info("boot","git",{commit,dirty});版本 <2.39 额外 WARN 一行
 * (死锁链:git 读失败 → omo memory 扩展反复 stall → session worker 隔离 → 宿主
 * 连环重启,notes/facts/senpi-webui-active-session-interrupt-2026-11-05.md)。
 */
export function bootGitDiagnostics(opts: BootGitOptions = {}): BootGitResult {
  const cwd = opts.cwd ?? process.cwd();
  const git = opts.gitBinary ?? "git";
  const run = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(git, args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    // ENOENT(无 git)/ ETIMEDOUT(挂死被超时杀)等:status 缺失,统一按失败静默
    if (r.error || r.status === null) return { status: -1, stdout: "", stderr: "" };
    return {
      status: r.status,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
    };
  };

  const v = run(["--version"]);
  if (v.status !== 0) {
    return { gitAvailable: false, version: null, stale: false, inRepo: false, commit: null, dirty: false };
  }
  const version = parseGitVersion(v.stdout);
  const stale = version !== null && compareVersions(version, GIT_MIN_RECOMMENDED.join(".")) < 0;
  if (stale) {
    log.warn("boot", "git_version_stale", {
      version: version ?? "",
      minRecommended: GIT_MIN_RECOMMENDED.join("."),
      reason:
        `git ${version} < ${GIT_MIN_RECOMMENDED.join(".")}:老版本死锁链——git 读失败(--diff-merges=first-parent 等新参数不支持)` +
        "→ omo memory 扩展反复 stall → session worker 隔离 → 引擎宿主连环重启(2026-11-05 会话中断实录),建议升级 git",
    });
  }

  const head = run(["rev-parse", "HEAD"]);
  // 非 git 目录 / 权限问题等:静默降级,不打日志行
  if (head.status !== 0) {
    return { gitAvailable: true, version, stale, inRepo: false, commit: null, dirty: false };
  }
  const commit = head.stdout.trim();
  const status = run(["status", "--porcelain"]);
  const dirty = status.status === 0 && status.stdout.trim() !== "";
  log.info("boot", "git", { commit, dirty });
  return { gitAvailable: true, version, stale, inRepo: true, commit, dirty };
}

// ---------------------------------------------------------------------------
// ② runtime 保留 30d
// ---------------------------------------------------------------------------

/** transcripts 会话目录名:UUIDv7(version nibble=7;前 12 hex 为 Unix 毫秒) */
const UUIDV7_DIR = /^[0-9a-f]{12}7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** facts-queue 队列条目文件名(引擎同款正则:8 位日期 T 9 位毫秒 Z-12hex-8hex) */
const QUEUE_FILE = /^\d{8}T\d{9}Z-[a-f0-9]{12}-[a-f0-9]{8}\.json$/;
/** reflection run 目录 / completion 文件名(引擎 omo.js 同款形态) */
const REFLECTION_RUN = /^reflection-run-(\d+)$/;
const REFLECTION_COMPLETION = /^reflection-run-(\d+)\.json$/;
/** 日志里可删清单拼接上限(超长截断,防单行日志爆量) */
const LIST_LOG_MAX = 2000;

export interface RuntimeRetentionOptions {
  /** 记忆库 home(缺省 OMO_MEMORY_HOME || ~/.omo/memory,与 routes-memory 同源;测试注入) */
  memoryHome?: string;
  /** webui 已登记项目绝对路径(只清这些项目派生的引擎 runtime) */
  projects: string[];
  /** 实删开关;缺省 false = DRY-RUN(仅日志清单)。index.ts 侧读 meta_kv runtime.retentionEnabled */
  enabled?: boolean;
  /** transcripts/facts-queue 保留天数(缺省 30) */
  keepDays?: number;
  /** reflection 保最近 run 数(缺省 50;completions 同步同规则) */
  reflectionKeepRuns?: number;
  /** 当前时间(缺省 new Date();测试注入) */
  now?: Date;
}

export interface RuntimeRetentionReport {
  mode: "dry-run" | "delete";
  /** 实际扫到的 runtime 目录(realpath) */
  runtimeRoots: string[];
  /** DRY-RUN 可删清单(runtime 目录相对目标路径) */
  wouldDelete: string[];
  /** 实删清单(delete 模式) */
  deleted: string[];
  /** realpath 守卫拒绝的目标(逃逸/解析失败) */
  rejectedOutsideRoot: string[];
  /** 跳过的 runtime(目录缺失)与跳过的 facts-queue 刀(claims 台账损坏) */
  skippedRuntimes: string[];
  skippedFactsClaims: string[];
}

/** basename 清洗 slug(routes-memory slugify 同源:NFKD → 非 [\p{L}\p{M}\p{N}] 折叠 '-') */
function slugify(name: string): string {
  const folded = name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{M}\p{N}]/gu, "-")
    .normalize("NFC")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return folded === "" ? "agent" : folded;
}

/**
 * 项目 → 记忆身份串(routes-memory memoryIdentityFor 同源派生兜底口径):
 * `${slugify(basename)}-${sha256(项目绝对路径)[:8]}`。实证:与引擎写入磁盘的
 * agents/<identity>/ 一致(2026-11-06 对 senpi-webui 项目复算吻合)。
 */
export function memoryIdentityForProject(projectPath: string): string {
  let real = projectPath;
  try {
    real = realpathSync(projectPath);
  } catch {
    // 项目目录暂不可达(卸载盘等):按原路径派生,只是可能找不到 runtime → 跳过
  }
  const hash = createHash("sha256").update(resolve(real), "utf8").digest("hex").slice(0, 8);
  return `${slugify(basename(real))}-${hash}`;
}

function memoryHome(override?: string): string {
  return override ?? (process.env.OMO_MEMORY_HOME || join(homedir(), ".omo", "memory"));
}

/** UUIDv7 目录名 → 创建毫秒(前 12 hex);解析失败返回 null */
function uuidv7Millis(name: string): number | null {
  const ms = Number.parseInt(name.slice(0, 12), 16);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** 队列条目文件名 → 入队 UTC 毫秒("20261013T184400826Z" 段解析);失败返回 null */
function queueFileEpochMs(name: string): number | null {
  const s = name.slice(0, 19);
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(9, 11));
  const mi = Number(s.slice(11, 13));
  const se = Number(s.slice(13, 15));
  const ms = Number(s.slice(15, 18));
  const epoch = Date.UTC(y, mo - 1, d, h, mi, se, ms);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
}

/** 日志清单拼接:分号连接,超 LIST_LOG_MAX 截断(目录名/文件名本身无分隔符歧义) */
function clipList(items: string[]): string {
  const joined = items.join("; ");
  return joined.length > LIST_LOG_MAX ? joined.slice(0, LIST_LOG_MAX) + `; …(共 ${items.length} 项,已截断)` : joined;
}

/** realpath 守卫:目标必须落在 runtime 根内(逃逸/解析失败返回 false) */
function confinedInside(rootReal: string, target: string): boolean {
  try {
    const targetReal = realpathSync(target);
    return targetReal === rootReal || targetReal.startsWith(rootReal + "/");
  } catch {
    return false;
  }
}

interface BladeOutcome {
  targets: string[];
  rejected: string[];
}

/** transcripts 刀:>keepDays 的会话目录整删。龄取 max(UUIDv7 创建毫秒, mtime):
 * UUIDv7 形态不合的名字直接跳过(白名单);mtime 新说明仍在写(续会话),不删。 */
function scanTranscripts(transcriptsPath: string, nowMs: number, keepMs: number): BladeOutcome {
  const targets: string[] = [];
  const rejected: string[] = [];
  let entries;
  try {
    entries = readdirSync(transcriptsPath, { withFileTypes: true });
  } catch {
    return { targets, rejected };
  }
  for (const e of entries) {
    // lstat 语义:symlink 目录 isDirectory=false,天然不进清单(rmSync 也不跟随 symlink)
    if (!e.isDirectory() || !UUIDV7_DIR.test(e.name)) continue;
    const dir = join(transcriptsPath, e.name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    const createdMs = uuidv7Millis(e.name) ?? mtimeMs;
    if (nowMs - Math.max(createdMs, mtimeMs) < keepMs) continue;
    targets.push(dir);
  }
  return { targets, rejected };
}

/** reflection 刀:runs 目录与 completions 文件各自按 run 编号保最大 keepRuns 个。
 * active.lock/pending.json 等在途工件不匹配白名单正则,天然不动。 */
function scanReflection(reflectionPath: string, keepRuns: number): { runTargets: string[]; completionTargets: string[] } {
  const runTargets: string[] = [];
  const completionTargets: string[] = [];
  const runsPath = join(reflectionPath, "runs");
  const completionsPath = join(reflectionPath, "completions");
  try {
    const runs = readdirSync(runsPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && REFLECTION_RUN.test(e.name))
      .map((e) => ({ name: e.name, n: Number(e.name.match(REFLECTION_RUN)![1]) }))
      .sort((a, b) => b.n - a.n);
    for (const victim of runs.slice(keepRuns)) runTargets.push(join(runsPath, victim.name));
  } catch {
    // runs 缺失/不可读:跳过该刀
  }
  try {
    const completions = readdirSync(completionsPath, { withFileTypes: true })
      .filter((e) => e.isFile() && REFLECTION_COMPLETION.test(e.name))
      .map((e) => ({ name: e.name, n: Number(e.name.match(REFLECTION_COMPLETION)![1]) }))
      .sort((a, b) => b.n - a.n);
    for (const victim of completions.slice(keepRuns)) completionTargets.push(join(completionsPath, victim.name));
  } catch {
    // completions 缺失/不可读:跳过该刀
  }
  return { runTargets, completionTargets };
}

/** facts-queue 刀:>keepDays 且无在途 claim 的队列条目文件删。claims.json 读取/
 * 解析失败 → 整刀跳过(安全降级,返回 null claim 集合标记);台账文件
 * (claims/failures/consumed)与 cursor/、parked/ 目录不匹配队列正则,天然不动。 */
function scanFactsQueue(
  factsPath: string,
  nowMs: number,
  keepMs: number,
): { targets: string[]; claimsBroken: boolean } {
  const targets: string[] = [];
  let claimKeys: Set<string> | null = new Set<string>();
  try {
    const raw = readFileSync(join(factsPath, "claims.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      claimKeys = new Set(Object.keys(parsed as Record<string, unknown>));
    }
    // null/数组等异形:当空集(引擎只写对象形态,异形视为无在途)
  } catch {
    // claims.json 缺失:引擎尚未写过 claim,视为无在途;JSON 损坏:保守跳过整刀
    const broken = existsSafe(join(factsPath, "claims.json"));
    if (broken) return { targets, claimsBroken: true };
  }
  try {
    const entries = readdirSync(factsPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !QUEUE_FILE.test(e.name)) continue;
      const epoch = queueFileEpochMs(e.name);
      if (epoch === null || nowMs - epoch < keepMs) continue;
      // 在途 claim(key = 文件名去掉 19 字符时间戳段,与引擎 slice(19) 同口径)不删
      if (claimKeys && claimKeys.has(e.name.slice(19))) continue;
      targets.push(join(factsPath, e.name));
    }
  } catch {
    return { targets, claimsBroken: false };
  }
  return { targets, claimsBroken: false };
}

function existsSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * runtime 保留主入口:对每个 webui 已登记项目派生 runtime 目录跑三刀。
 * DRY-RUN 默认(enabled 缺省 false):日志输出可删清单,不动任何文件;
 * enabled=true 实删。每个 runtime 一行 log.info("boot","runtime_retention",…)
 * (诊断日志流 GET /api/diagnostics/logs 可查),末尾一行汇总。
 */
export function runRuntimeRetention(opts: RuntimeRetentionOptions): RuntimeRetentionReport {
  const nowMs = (opts.now ?? new Date()).getTime();
  const keepMs = (opts.keepDays ?? 30) * 24 * 60 * 60 * 1000;
  const keepRuns = opts.reflectionKeepRuns ?? 50;
  const mode: "dry-run" | "delete" = opts.enabled === true ? "delete" : "dry-run";
  const report: RuntimeRetentionReport = {
    mode,
    runtimeRoots: [],
    wouldDelete: [],
    deleted: [],
    rejectedOutsideRoot: [],
    skippedRuntimes: [],
    skippedFactsClaims: [],
  };

  const home = memoryHome(opts.memoryHome);
  const seenIdentities = new Set<string>();
  for (const project of opts.projects) {
    const identity = memoryIdentityForProject(project);
    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);
    const runtimePath = join(home, "agents", identity, "runtime");
    let rootReal: string;
    try {
      rootReal = realpathSync(runtimePath);
    } catch {
      report.skippedRuntimes.push(identity);
      continue;
    }
    report.runtimeRoots.push(rootReal);

    // 三刀子目录守卫:子目录本身若是指向 runtime 外的 symlink,整刀拒
    const blades: Array<[string, string]> = [
      ["transcripts", "transcripts"],
      ["reflection", "reflection"],
      ["facts-queue", "facts-queue"],
    ];
    for (const [sub] of blades) {
      if (!confinedInside(rootReal, join(rootReal, sub))) {
        report.rejectedOutsideRoot.push(join(runtimePath, sub));
      }
    }

    // transcripts
    const transcripts = scanTranscripts(join(runtimePath, "transcripts"), nowMs, keepMs);
    // reflection(runs+completions;不按龄,按数量)
    const reflection = scanReflection(join(runtimePath, "reflection"), keepRuns);
    // facts-queue
    const facts = scanFactsQueue(join(runtimePath, "facts-queue"), nowMs, keepMs);
    if (facts.claimsBroken) report.skippedFactsClaims.push(identity);

    const targets = [
      ...transcripts.targets,
      ...reflection.runTargets,
      ...reflection.completionTargets,
      ...facts.targets,
    ];
    // 目标级 realpath 守卫:逃逸目标拒删并计数
    const confined: string[] = [];
    for (const t of targets) {
      if (confinedInside(rootReal, t)) confined.push(t);
      else report.rejectedOutsideRoot.push(t);
    }
    const names = confined.map((t) => basename(t));

    if (mode === "delete") {
      for (const t of confined) {
        try {
          rmSync(t, { recursive: true, force: true });
          report.deleted.push(t);
        } catch (err) {
          log.warn("boot", "runtime_retention_delete_failed", {
            identity,
            target: basename(t),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else {
      report.wouldDelete.push(...confined);
    }

    log.info("boot", "runtime_retention", {
      identity,
      mode,
      transcriptsCount: transcripts.targets.length,
      reflectionRunsCount: reflection.runTargets.length,
      reflectionCompletionsCount: reflection.completionTargets.length,
      factsQueueCount: facts.targets.length,
      list: clipList(names),
    });
  }

  log.info("boot", "runtime_retention_summary", {
    mode,
    runtimes: report.runtimeRoots.length,
    skipped: report.skippedRuntimes.length,
    wouldDeleteCount: report.wouldDelete.length,
    deletedCount: report.deleted.length,
    rejectedOutsideCount: report.rejectedOutsideRoot.length,
  });
  return report;
}
