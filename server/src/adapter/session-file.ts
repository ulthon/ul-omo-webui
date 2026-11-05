// 会话 jsonl 尾窗直读（docs08-2026-10-22-batch 任务 16 / GAP-6 修复）：
// 首载不再经引擎全量 getEntries（冷 spawn + 全量传输是切换耗时主因，任务 1 归因），
// 改为服务端直接反向分块读会话文件尾窗。title-gen.ts 直读先例：直读不抢占
// 活跃会话、不进 runExclusive、不触发 switchTo。
//
// 分页契约：
//   readTailEntries(path)      尾窗（最新 PAGE_LIMIT 条或累计 ≥8MB，文件序）
//   readEntriesBefore(path, beforeId)  上一窗：从 beforeId 起再向更早收一窗
//                              （含 beforeId 本身作重叠锚——客户端按 id 去重后恰补
//                              新条目，拼缝零重复零丢失；重叠覆盖 toolCall/Result 跨界）
//   readAllEntries(path)       正向流式全量（full=1 磁盘主读路径；逐块读禁整读）
//   读到文件头（session header 行不计条目）时 hasMore=false——比窗口短的会话不报
//   hasMore，前端不再翻页。
//   beforeId 不在文件中 → 抛 cursor_invalid（路由转 409）。
//
// 反向读实现：fs.open + 64KB 步进从文件尾向前，行边界按 \n 切；文件末尾无换行的
// 不完整行（写入进行中）丢弃——与引擎侧"读到即完整条目"语义一致。
import { open } from "node:fs/promises";
import type { EngineEntry } from "./engine-adapter";

/** 尾窗条目数（计划钦定 200） */
export const TAIL_WINDOW = 200;
/** 拼缝重叠条目数（计划钦定 16，覆盖 toolCall/Result 跨界） */
export const OVERLAP = 16;
/** 单次读取上限 = 窗口 + 重叠（任务 5 起仅为条数上限；另有字节上限） */
export const PAGE_LIMIT = TAIL_WINDOW + OVERLAP;
/** 单窗字节上限（任务 5 / plan engine-open-read-batch A-2）：窗口累计行字节数达
 *  8MiB 即停（与引擎侧分页 maxBytes 同源对齐），至少保 1 条——单条超限条目完整交付 */
export const WINDOW_BYTE_CAP = 8 * 1024 * 1024;
/** 反向/正向分块步长 */
const CHUNK_BYTES = 64 * 1024;

/** 尾窗读结果：entries 恒为文件序（旧→新） */
export interface TailWindowPage {
  entries: EngineEntry[];
  /** 本窗最旧条目 id（前端 ?before= 游标）；空窗为 null */
  oldestId: string | null;
  /** 文件最新条目 id（前向增量 cursor 同源） */
  leafId: string | null;
  /** 文件头方向是否还有更多条目 */
  hasMore: boolean;
}

/** cursor_invalid 错误（路由层转 409） */
export class CursorInvalidError extends Error {
  readonly code = "cursor_invalid";
  constructor() {
    super("before 游标在会话文件中不存在");
  }
}

/** 正向全量读结果：entries 文件序（旧→新），leafId 为最后一条条目 id（空文件 null） */
export interface FullReadResult {
  entries: EngineEntry[];
  leafId: string | null;
}

/** 单行解析；header 行（type==="session"）与不可解析行返回 null（跳过不计条目） */
function parseEntryLine(line: string): EngineEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as EngineEntry;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.type === "session") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 反向扫描会话 jsonl：从文件尾按 CHUNK_BYTES 步进向前读，收集至多 `wanted` 条
 * 条目行（文件序返回）。`anchorId` 给定时只统计严格早于该条的条目（含 anchor 本身
 * 作为重叠锚——见 readEntriesBefore）。返回条目（文件序）与 hasMore（文件头方向
 * 是否还有未收集的条目行）；anchor 未命中抛 CursorInvalidError。
 *
 * 完整性：只把「确认以 \n 结尾」的行当完整行；文件最末无换行的残行丢弃。
 */
async function reverseScan(
  sessionPath: string,
  wanted: number,
  anchorId?: string,
): Promise<TailWindowPage> {
  const fh = await open(sessionPath, "r");
  try {
    const size = (await fh.stat()).size;
    let pos = size;
    let remainder = ""; // 窗口前缘的未完成行片段（拼接更早 chunk 后再切）
    // 反向收集的完整条目行（原文）；entries[0] 最旧
    const collected: EngineEntry[] = [];
    // 窗口累计行字节数（任务 5 字节上限；只计已收集条目行，跳过行不计）
    let collectedBytes = 0;
    let leafId: string | null = null;
    let hasMore = false;
    let anchorSeen = anchorId === undefined;
    let firstChunk = true;

    while (pos > 0) {
      const step = Math.min(CHUNK_BYTES, pos);
      const start = pos - step;
      const buf = Buffer.alloc(step);
      await fh.read(buf, 0, step, start);
      let text = buf.toString("utf8") + remainder;
      pos = start;
      remainder = "";

      let parts = text.split("\n");
      if (firstChunk) {
        // 末尾无换行 = 写入中的残行，丢弃
        if (size > 0 && !text.endsWith("\n")) {
          parts.pop();
        }
        firstChunk = false;
      }
      if (pos > 0) {
        // 头部片段可能是半行，留待与更早 chunk 拼接
        remainder = parts.shift() ?? "";
      } else {
        // 文件首行（完整）入切分序列
        if (parts[0] === "") parts.shift();
      }
      text = "";

      // 反向逐行消化
      for (let i = parts.length - 1; i >= 0; i--) {
        const entry = parseEntryLine(parts[i]);
        if (!entry) continue;
        if (!anchorSeen) {
          if (entry.id === anchorId) anchorSeen = true;
          else continue;
        }
        if (leafId === null) leafId = entry.id;
        collected.push(entry);
        collectedBytes += Buffer.byteLength(parts[i]);
        if (collected.length > wanted) {
          // 多收出一条 = 文件头方向还有条目
          hasMore = true;
          collected.length = wanted;
          return { entries: collected.reverse(), oldestId: collected[0]?.id ?? null, leafId, hasMore };
        }
        // 字节截停（任务 5）：窗口累计 ≥8MiB 即停，至少已保本条（检查在 push 后）。
        // hasMore 判定：跨 chunk（pos>0）只能多报（余下可能全是 header/损坏行），多报
        // 只多一次空窗请求且 oldestId 恒随窗推进，不产生同锚循环；终端 chunk（pos===0）
        // 精确判定——余下行中存在可解析条目行才算，单条超限的末窗不误报翻页。
        if (collectedBytes >= WINDOW_BYTE_CAP) {
          hasMore = pos > 0 || parts.slice(0, i).some((l) => parseEntryLine(l) !== null);
          return { entries: collected.reverse(), oldestId: collected[0]?.id ?? null, leafId, hasMore };
        }
      }
      parts = [];
    }
    if (!anchorSeen) throw new CursorInvalidError();
    // 扫到文件头：hasMore=false；剩余半行是文件首行残缺（损坏），忽略
    return { entries: collected.reverse(), oldestId: collected[0]?.id ?? null, leafId, hasMore: false };
  } finally {
    await fh.close();
  }
}

/** 尾窗直读：最新 PAGE_LIMIT 条或累计 8MiB（文件序）；空会话（仅 header）返回空窗 */
export async function readTailEntries(sessionPath: string): Promise<TailWindowPage> {
  return reverseScan(sessionPath, PAGE_LIMIT);
}

/** 上一窗直读：从 beforeId 起向更早收一窗（含 beforeId 重叠锚，文件序） */
export async function readEntriesBefore(sessionPath: string, beforeId: string): Promise<TailWindowPage> {
  return reverseScan(sessionPath, PAGE_LIMIT, beforeId);
}

/**
 * 正向流式全量读（任务 5 / full=1 磁盘主读路径）：fs.open + CHUNK_BYTES 顺序分块
 * 读，行边界按 \n 切，禁止 readFileSync 整文件读入。header 行与不可解析行跳过
 * （与 reverseScan 同约定：损坏行不崩、不计条目）；文件末尾无换行的残行（写入
 * 进行中）丢弃。文件头方向即读尽，hasMore 恒 false（全量语义无翻页）。
 */
export async function readAllEntries(sessionPath: string): Promise<FullReadResult> {
  const fh = await open(sessionPath, "r");
  try {
    const size = (await fh.stat()).size;
    const entries: EngineEntry[] = [];
    let pos = 0;
    let carry = ""; // 上块尾部的不完整行片段（与下块头部拼接）
    while (pos < size) {
      const step = Math.min(CHUNK_BYTES, size - pos);
      const buf = Buffer.alloc(step);
      // read 返回实际读取字节数（常规文件等于 step，防御性推进防死循环）
      const { bytesRead: read } = await fh.read(buf, 0, step, pos);
      if (read <= 0) break;
      pos += read;
      const text = carry + buf.toString("utf8", 0, read);
      const parts = text.split("\n");
      // 尾部片段留待与下块拼接；末块残留即文件尾残行（写入中），循环外丢弃
      carry = parts.pop() ?? "";
      for (const part of parts) {
        const entry = parseEntryLine(part);
        if (entry) entries.push(entry);
      }
    }
    // 尾块残留：文件末尾无换行的残行（写入中）丢弃——与 reverseScan 同语义
    return { entries, leafId: entries[entries.length - 1]?.id ?? null };
  } finally {
    await fh.close();
  }
}

/** 前向增量读结果（任务 13 / F4 IS-2 切回校准磁盘优先）：entries 为 afterId 之后
 *  的条目（文件序）；cursor 为响应游标——读尽时即文件末条目 id（afterId 之后无新
 *  条目时即 afterId 本身，对齐引擎 getEntries(since) 增量 0 条回 leafId 的语义），
 *  字节截停时为最后交付条目 id。 */
export interface AfterReadResult {
  entries: EngineEntry[];
  cursor: string;
}

/**
 * 前向增量直读（任务 13 / F4 IS-2）：?cursor= 前向增量不再经引擎冷 spawn，改服务
 * 端正向分块扫描会话文件，收集 afterId 之后的全部条目。语义对齐引擎 getEntries(since)。
 * afterId 不在文件中（compaction 重写/换代）抛 CursorInvalidError（路由转 409，客户端
 * 升级 full=1）；字节上限 WINDOW_BYTE_CAP 与尾窗同源：累计 ≥8MiB 截停（至少保 1 条），
 * cursor 回退最后交付条目 id（senpi-adapter 分页预算截停同语义——前端 setCursor 后
 * 下次校准续读，不丢数据）。header 行与损坏行跳过、末尾无换行残行丢弃，均与
 * readAllEntries 同约定。
 */
export async function readEntriesAfter(sessionPath: string, afterId: string): Promise<AfterReadResult> {
  const fh = await open(sessionPath, "r");
  try {
    const size = (await fh.stat()).size;
    const entries: EngineEntry[] = [];
    let pos = 0;
    let carry = "";
    let anchorSeen = false;
    let collectedBytes = 0;
    while (pos < size) {
      const step = Math.min(CHUNK_BYTES, size - pos);
      const buf = Buffer.alloc(step);
      const { bytesRead: read } = await fh.read(buf, 0, step, pos);
      if (read <= 0) break;
      pos += read;
      const text = carry + buf.toString("utf8", 0, read);
      const parts = text.split("\n");
      carry = parts.pop() ?? "";
      for (const part of parts) {
        const entry = parseEntryLine(part);
        if (!entry) continue;
        if (!anchorSeen) {
          if (entry.id !== afterId) continue;
          anchorSeen = true;
          continue;
        }
        entries.push(entry);
        collectedBytes += Buffer.byteLength(part);
        if (collectedBytes >= WINDOW_BYTE_CAP) {
          // 字节截停（检查在 push 后，至少保 1 条）：cursor 回退最后交付条目
          return { entries, cursor: entries[entries.length - 1]!.id };
        }
      }
    }
    if (!anchorSeen) throw new CursorInvalidError();
    // 读尽：cursor 为文件末条目 id（增量 0 条时即 afterId，对齐引擎 since=leafId 语义）
    return { entries, cursor: entries[entries.length - 1]?.id ?? afterId };
  } finally {
    await fh.close();
  }
}
