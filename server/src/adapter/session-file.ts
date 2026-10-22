// 会话 jsonl 尾窗直读（docs08-2026-10-22-batch 任务 16 / GAP-6 修复）：
// 首载不再经引擎全量 getEntries（冷 spawn + 全量传输是切换耗时主因，任务 1 归因），
// 改为服务端直接反向分块读会话文件尾窗。title-gen.ts 直读先例：直读不抢占
// 活跃会话、不进 runExclusive、不触发 switchTo。
//
// 分页契约：
//   readTailEntries(path)      尾窗（最新 PAGE_LIMIT 条，文件序）
//   readEntriesBefore(path, beforeId)  上一窗：从 beforeId 起再向更早收 PAGE_LIMIT 条
//                              （含 beforeId 本身作重叠锚——客户端按 id 去重后恰补
//                              新条目，拼缝零重复零丢失；重叠覆盖 toolCall/Result 跨界）
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
/** 单次读取上限 = 窗口 + 重叠 */
export const PAGE_LIMIT = TAIL_WINDOW + OVERLAP;
/** 反向分块步长 */
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
        if (collected.length > wanted) {
          // 多收出一条 = 文件头方向还有条目
          hasMore = true;
          collected.length = wanted;
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

/** 尾窗直读：最新 PAGE_LIMIT 条（文件序）；空会话（仅 header）返回空窗 */
export async function readTailEntries(sessionPath: string): Promise<TailWindowPage> {
  return reverseScan(sessionPath, PAGE_LIMIT);
}

/** 上一窗直读：从 beforeId 起向更早收 PAGE_LIMIT 条（含 beforeId 重叠锚，文件序） */
export async function readEntriesBefore(sessionPath: string, beforeId: string): Promise<TailWindowPage> {
  return reverseScan(sessionPath, PAGE_LIMIT, beforeId);
}
