// boulder.json 存储访问（暂停/恢复控制面，2026-10-31 方案 b）：项目 .omo/boulder.json
// 的受限读写面——本模块是 webui 首次引入的对引擎域内文件的写路径，写面刻意收敛为
// 「定位会话绑定的 work → 只改其 status 字段」一个操作（其余字段原样保留）。
//
// —— 引擎读取语义（omo-ai 5.1.51，分档设计报告 §1.2/§2.ii）——
// 引擎每次选取都从磁盘现读，校验仅「对象/非数组/非空」+ 形状归一化，无 status 枚举
// 校验；续跑门槛只放行字面量 "active"/"paused"。因此把绑定的 work status 写成
// "user_paused"（任意非 active/paused 值等效，取描述性命名）即令续跑钩子永久沉默，
// 且不被 staleness demotion 翻写（它只遍历 status==="active" 的 work）。
//
// —— 写安全（报告 §2.iii）——
// 读-改-写前重读最新文件（含 mtime 缓存失效后重读），tmp+rename 同目录原子替换：
// 引擎读侧要么见到旧完整文件要么见到新完整文件，消除截断撕裂窗。残余 TOCTOU
// （引擎 staleness demotion 的整文件写恰好落在本次读与写之间）窗口毫秒级，接受备案。
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 暂停态：非 active/paused，引擎续跑门槛（Xme）判 null → 钩子永久沉默 */
export const USER_PAUSED_STATUS = "user_paused";
/** 恢复态：回到引擎状态门放行的字面量 */
export const ACTIVE_STATUS = "active";

/** boulder.json 的 work 条目（本模块关心字段的宽松形状，其余字段不触碰） */
export interface BoulderWorkEntry {
  status?: unknown;
  stale_since?: unknown;
  updated_at?: unknown;
  [key: string]: unknown;
}

/** 定位结果：会话绑定的 work（宽松解析规则与 routes-plans.matchBoundWork 同口径：
 *  session_ids 条目去 "<agent>:" 前缀后与 durable id 精确相等；多命中 active_work_id
 *  优先，否则键序第一个） */
export interface BoundWorkRef {
  workId: string;
  status: string | null;
}

// —— mtime 缓存（schedule-store 直读先例 + mtime 失效）：同进程高频读省重复 parse ——
interface CacheLine {
  mtimeMs: number;
  state: Record<string, unknown>;
}
const cache = new Map<string, CacheLine>();

function boulderPath(cwd: string): string {
  return join(cwd, ".omo", "boulder.json");
}

function sessionKeyMatches(entry: unknown, sessionId: string): boolean {
  return typeof entry === "string" && (entry === sessionId || entry.endsWith(`:${sessionId}`));
}

/** boulder state（宽松 unknown）→ 会话绑定的 work 键与当前 status；无绑定 → null */
function locateWork(state: unknown, sessionId: string): BoundWorkRef | null {
  if (typeof state !== "object" || state === null) return null;
  const works = (state as { works?: unknown }).works;
  if (typeof works !== "object" || works === null) return null;
  const worksRec = works as Record<string, unknown>;
  const activeWorkId = (state as { active_work_id?: unknown }).active_work_id;
  const matches: string[] = [];
  for (const [workId, raw] of Object.entries(worksRec)) {
    const work = raw as BoulderWorkEntry | null;
    if (!work || typeof work !== "object" || !Array.isArray(work.session_ids)) continue;
    if (work.session_ids.some((entry) => sessionKeyMatches(entry, sessionId))) matches.push(workId);
  }
  if (matches.length === 0) return null;
  const workId = typeof activeWorkId === "string" && matches.includes(activeWorkId) ? activeWorkId : matches[0];
  const status = (worksRec[workId] as BoulderWorkEntry).status;
  return { workId, status: typeof status === "string" ? status : null };
}

/** 读 boulder.json（mtime 缓存）；缺失/损坏/形状非法 → null（与引擎「视为无 boulder」同语义） */
export async function readBoulder(cwd: string): Promise<Record<string, unknown> | null> {
  const path = boulderPath(cwd);
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    cache.delete(path);
    return null;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.state;
  let state: unknown;
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch {
    cache.delete(path);
    return null;
  }
  // 引擎解析器的合法性下限：对象 / 非数组 / 非空
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    cache.delete(path);
    return null;
  }
  const rec = state as Record<string, unknown>;
  cache.set(path, { mtimeMs, state: rec });
  return rec;
}

/** 定位会话绑定的 work 及其 status；无 boulder / 无绑定 → null */
export async function getBoundWork(cwd: string, sessionId: string): Promise<BoundWorkRef | null> {
  const state = await readBoulder(cwd);
  if (!state) return null;
  return locateWork(state, sessionId);
}

/** 原子替换写：同目录隐藏临时文件 + rename（读方只见旧或新完整文件）。
 *  模式对齐 schedule-store.writeJobAtomic 先例。 */
async function writeBoulderAtomic(cwd: string, state: Record<string, unknown>): Promise<void> {
  const path = boulderPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.boulder-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(state, null, 2), { encoding: "utf8" });
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/** 只改会话绑定 work 的 status 字段（其余字段与同文件其余条目原样保留）：
 *  resume 顺手清 stale_since 并刷新 updated_at（签名去重键 work_id:updated_at 随之
 *  前移，避免恢复后被旧签名去重挡一轮）；pause 不碰其他字段。
 *  无 boulder / 无绑定 → null（调用方按 409 报告）；成功 → { workId }。 */
export async function setBoundWorkStatus(
  cwd: string,
  sessionId: string,
  status: typeof USER_PAUSED_STATUS | typeof ACTIVE_STATUS,
): Promise<{ workId: string } | null> {
  // 写前重读最新文件（缓存可能过期；miss 时函数内部已重读）
  const state = await readBoulder(cwd);
  const found = state ? locateWork(state, sessionId) : null;
  if (!state || !found) return null;
  const work = (state.works as Record<string, BoulderWorkEntry>)[found.workId];
  work.status = status;
  if (status === ACTIVE_STATUS) {
    delete work.stale_since;
    work.updated_at = new Date().toISOString();
  }
  await writeBoulderAtomic(cwd, state);
  cache.delete(boulderPath(cwd));
  return { workId: found.workId };
}

/** 测试钩子：清空 mtime 缓存（跨用例隔离） */
export function clearBoulderCacheForTest(): void {
  cache.clear();
}
