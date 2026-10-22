// schedule 定时任务文件存储（docs08 plan 任务 21）：直写引擎既有 schema 的
// schedule pending 目录（引擎无 create RPC，本模块是计划选定的对齐手段——状态
// 文件写入，不改引擎代码）。
//
// 目录布局与状态语义完全对齐引擎（omo-ai 官配 @code-yeongyu/senpi
// core/extensions/builtin/schedule/store.ts）：
//
//     <agentDir>/schedule/pending/<id>.json     等待到期
//     <agentDir>/schedule/firing/...            runner 已认领（引擎自管理，只读）
//     <agentDir>/schedule/failed/<id>@<n>.json  投递失败/运行器死亡（只读+本侧 abandoned 标记）
//     <agentDir>/schedule/cancelled/<id>        墓碑（存在即取消，内容不参与语义）
//
// 本模块只做：列表（pending）、创建（直写 pending）、取消（pending → cancelled
// 移动，即写墓碑）、会话删除标记（pending → failed，lastError 记 abandoned）。
// 到期触发/认领/重排/失败归档全部归引擎 runner（schedule-runner.ts 托管），本侧
// 不做分布式锁、不做轮询触发。
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 与引擎 SCHEDULED_JOB_VERSION 对齐 */
export const SCHEDULE_JOB_VERSION = 1;
/** 引擎 JOB_ID 契约 */
export const JOB_ID_RE = /^sch_[a-z0-9]{12}$/;
/** 引擎 MIN_EVERY_SECONDS：runner 轮询语义下更密只漂移 */
export const MIN_EVERY_MS = 60_000;
/** 引擎 MAX_SCHEDULE_AHEAD_MS：最远可预约 366 天 */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
/** 引擎 MAX_PROMPT_BYTES：UTF-8 字节 */
export const MAX_PROMPT_BYTES = 16 * 1024;
/** 引擎 MAX_PENDING_JOBS_PER_SESSION */
export const MAX_PENDING_PER_SESSION = 50;
/** 引擎 MAX_PENDING_JOBS_TOTAL */
export const MAX_PENDING_TOTAL = 1000;
/** job 文件大小上限（超限按 invalid 报告不解析，对齐引擎 MAX_JOB_FILE_BYTES） */
export const MAX_JOB_FILE_BYTES = 64 * 1024;

export interface ScheduleJob {
  version: typeof SCHEDULE_JOB_VERSION;
  id: string;
  /** 所属会话 durable id；到期 prompt 归它 */
  sessionId: string;
  /** 创建时会话文件绝对路径（未落盘为 null） */
  sessionFile: string | null;
  /** 会话工作目录 */
  cwd: string;
  prompt: string;
  createdAt: number;
  /** 下次到期时刻，epoch ms */
  dueAt: number;
  /** 循环周期 ms；一次性为 null */
  everyMs: number | null;
  fireCount: number;
  lastFiredAt: number | null;
  lastError: string | null;
}

/** 列表行：state 由所在目录决定（目录即状态） */
export interface ScheduleJobRecord {
  state: "pending" | "firing" | "failed";
  file: string;
  job: ScheduleJob;
  /** firing/failed 记录的 occurrence 序号（文件名 @n 段） */
  occurrence?: number;
}

export interface ScheduleListResult {
  jobs: ScheduleJobRecord[];
  /** 不可解析/命名异常的记录（如实报告，不静默丢） */
  invalid: { file: string; error: string }[];
}

const RECORD_FILE = /^(sch_[a-z0-9]{12})(?:@(\d+)(?:~\d+-\d+)?)?\.json$/;

export function scheduleDir(agentDir: string): string {
  return join(agentDir, "schedule");
}

function stateDirs(dir: string): { state: ScheduleJobRecord["state"]; path: string }[] {
  return [
    { state: "pending", path: join(dir, "pending") },
    { state: "firing", path: join(dir, "firing") },
    { state: "failed", path: join(dir, "failed") },
  ];
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

/** 原子替换写：同目录 0600 隐藏临时文件 + rename（读方只见旧或新完整文件） */
export async function writeJobAtomic(filePath: string, job: ScheduleJob): Promise<void> {
  await ensureDir(dirname(filePath));
  const temp = join(dirname(filePath), `.schedule-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, filePath);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

function parseJob(raw: unknown, expectedId: string): ScheduleJob {
  if (typeof raw !== "object" || raw === null) throw new Error("job 不是 JSON 对象");
  const r = raw as Record<string, unknown>;
  const need = (k: string): unknown => {
    if (!(k in r)) throw new Error(`缺少字段 ${k}`);
    return r[k];
  };
  if (need("version") !== SCHEDULE_JOB_VERSION) throw new Error("version 不兼容");
  const id = need("id");
  if (typeof id !== "string" || !JOB_ID_RE.test(id)) throw new Error("id 非法");
  if (id !== expectedId) throw new Error(`id ${id} 与文件名不符`);
  const str = (k: string): string => {
    const v = need(k);
    if (typeof v !== "string") throw new Error(`${k} 必须是字符串`);
    return v;
  };
  const num = (k: string): number => {
    const v = need(k);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} 必须是有限数字`);
    return v;
  };
  const numOrNull = (k: string): number | null => {
    const v = need(k);
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) throw new Error(`${k} 必须是数字或 null`);
    return v as number | null;
  };
  return {
    version: SCHEDULE_JOB_VERSION,
    id,
    sessionId: str("sessionId"),
    // 引擎 schema 允许 null（会话未落盘时创建）
    sessionFile: ((): string | null => {
      const v = need("sessionFile");
      if (v !== null && typeof v !== "string") throw new Error("sessionFile 必须是字符串或 null");
      return v as string | null;
    })(),
    cwd: str("cwd"),
    prompt: str("prompt"),
    createdAt: num("createdAt"),
    dueAt: num("dueAt"),
    everyMs: numOrNull("everyMs"),
    fireCount: num("fireCount"),
    lastFiredAt: numOrNull("lastFiredAt"),
    lastError: ((): string | null => {
      const v = need("lastError");
      if (v !== null && typeof v !== "string") throw new Error("lastError 必须是字符串或 null");
      return v as string | null;
    })(),
  };
}

/** 全状态列表，按到期时间升序；坏文件进 invalid 不丢弃（对齐引擎 listScheduledJobs 语义） */
export async function listScheduleJobs(dir: string): Promise<ScheduleListResult> {
  const jobs: ScheduleJobRecord[] = [];
  const invalid: { file: string; error: string }[] = [];
  for (const { state, path } of stateDirs(dir)) {
    let names: string[];
    try {
      names = await readdir(path);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const rel = join(state, name);
      const match = RECORD_FILE.exec(name);
      if (!match) {
        if (name.endsWith(".json")) invalid.push({ file: rel, error: "文件名不符合记录契约" });
        continue;
      }
      const id = match[1];
      const occurrence = match[2] === undefined ? undefined : Number(match[2]);
      // pending 记录不带 occurrence；firing/failed 带（引擎命名契约）
      if (state === "pending" ? occurrence !== undefined : occurrence === undefined) {
        invalid.push({ file: rel, error: `${state}/ 记录命名形态异常` });
        continue;
      }
      try {
        const full = join(path, name);
        const info = await stat(full);
        if (info.size > MAX_JOB_FILE_BYTES) throw new Error(`文件超过 ${MAX_JOB_FILE_BYTES} 字节`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(full, "utf8"));
        } catch (err) {
          throw new Error(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
        }
        jobs.push({ state, file: rel, job: parseJob(parsed, id), ...(occurrence === undefined ? {} : { occurrence }) });
      } catch (err) {
        invalid.push({ file: rel, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  jobs.sort((a, b) => a.job.dueAt - b.job.dueAt || a.job.id.localeCompare(b.job.id));
  return { jobs, invalid };
}

/** 生成引擎契约 id（sch_ + 12 位小写字母数字），冲突重试 */
export function newJobId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (;;) {
    const bytes = randomBytes(12);
    let id = "sch_";
    for (const b of bytes) id += alphabet[b % alphabet.length];
    if (JOB_ID_RE.test(id)) return id;
  }
}

export interface CreateJobCaps {
  perSession: number;
  total: number;
}

export const DEFAULT_CAPS: CreateJobCaps = { perSession: MAX_PENDING_PER_SESSION, total: MAX_PENDING_TOTAL };

/**
 * 创建一条 pending job（直写文件）。上限语义：写入前计数，已达上限即拒
 * （400 语义由路由层给；本层抛 ScheduleLimitError）。
 */
export async function createScheduleJob(dir: string, job: ScheduleJob, caps: CreateJobCaps = DEFAULT_CAPS): Promise<void> {
  const { jobs } = await listScheduleJobs(dir);
  const pending = jobs.filter((r) => r.state === "pending");
  if (pending.length >= caps.total) throw new ScheduleLimitError(`定时任务总数已达上限（${caps.total}）`);
  const perSession = pending.filter((r) => r.job.sessionId === job.sessionId).length;
  if (perSession >= caps.perSession) throw new ScheduleLimitError(`该会话定时任务已达上限（${caps.perSession}）`);
  const pendingPath = join(dir, "pending", `${job.id}.json`);
  await writeJobAtomic(pendingPath, job);
}

export class ScheduleLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleLimitError";
  }
}

/**
 * 取消：写墓碑（cancelled/<id>）后把 pending 文件移动过去（移动即墓碑落位，
 * 引擎 listScheduledJobs 不读 cancelled/，只检查墓碑存在性）。不存在返回 null。
 */
export async function cancelScheduleJob(dir: string, id: string): Promise<ScheduleJob | null> {
  if (!JOB_ID_RE.test(id)) return null;
  const pendingPath = join(dir, "pending", `${id}.json`);
  let job: ScheduleJob;
  try {
    job = parseJob(JSON.parse(await readFile(pendingPath, "utf8")), id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  await ensureDir(join(dir, "cancelled"));
  await rename(pendingPath, join(dir, "cancelled", id));
  return job;
}

/**
 * 会话删除 → 该会话全部 pending 任务标 invalid（对齐引擎 abandoned 语义）：
 * 改写 lastError 后移入 failed/（引擎列表如实报告；runner 不再触发 pending 外记录）。
 * 返回标记的任务 id 列表。
 */
export async function abandonSessionJobs(dir: string, sessionId: string, reason: string): Promise<string[]> {
  const { jobs } = await listScheduleJobs(dir);
  const marked: string[] = [];
  for (const record of jobs) {
    if (record.state !== "pending" || record.job.sessionId !== sessionId) continue;
    const from = join(dir, record.file);
    const updated: ScheduleJob = { ...record.job, lastError: reason };
    await ensureDir(join(dir, "failed"));
    // 引擎 failed 记录命名契约：<id>@<n>.json（occurrence = fireCount+1）
    await writeJobAtomic(join(dir, "failed", `${record.job.id}@${record.job.fireCount + 1}.json`), updated);
    await rm(from, { force: true });
    marked.push(record.job.id);
  }
  return marked;
}
