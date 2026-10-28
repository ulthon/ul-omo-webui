// 会话切换 sheet 最后消息预览（r10 todo 8）：sessions 列表响应逐会话尾读 jsonl
// 最后一条 user/assistant 文本截 60 字。反向分块读（只读文件尾块，不整文件入内存，
// 大文件代价恒定）；LRU 缓存（容量 200，键 = 会话 id）以 mtimeMs+size 失效——
// 会话更新时间变化即失效重读（background-tasks.ts 同先例）。
// 文件缺失/空/损坏 → 空串，绝不炸列表。
import { open, stat } from "node:fs/promises";

/** 单次尾读上限：预览只需最后一条消息，16KB 足够覆盖超长单条（其余截断） */
const PREVIEW_CHUNK_BYTES = 16 * 1024;
/** 预览长度上限（计划钦定 60 字，取末尾） */
export const PREVIEW_MAX_CHARS = 60;
/** LRU 容量（计划钦定 200） */
const PREVIEW_CACHE_CAPACITY = 200;

interface PreviewCacheEntry {
  mtimeMs: number;
  size: number;
  preview: string;
}

/** 键 = 会话 id；Map 迭代序即插入序，命中时 delete+set 重插实现 LRU */
const cache = new Map<string, PreviewCacheEntry>();

/** 低层 IO 面（依赖注入：单测以计数 fake 验证「命中缓存不重读文件」） */
export interface PreviewIo {
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  /** 读 [start, start+length) 字节 */
  read(path: string, start: number, length: number): Promise<Uint8Array>;
}

const defaultIo: PreviewIo = {
  async stat(path) {
    const st = await stat(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  },
  async read(path, start, length) {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, start);
      return bytesRead === length ? buf : buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  },
};

/** content 形态归一（title-gen.ts extractEntryText 同口径）：string 直用；blocks 数组
 * 取 type==="text" 的 text 拼接（toolCall/image 跳过） */
function extractEntryText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n").trim();
}

/** 轻量降噪：剥围栏标记行与行首 # 标记（只清呈现噪声，不做 markdown 全渲染） */
export function stripPreviewNoise(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, ""))
    .join("\n")
    .trim();
}

/** 尾块字节 → 预览文本：从末行向前找最后一条含非空文本的 user/assistant message；
 * 末尾无换行的残行（写入中）丢弃；chunk 首行可能被截半，从次行起消化（保守丢弃）。 */
export function extractPreviewFromTailChunk(chunk: string, wholeFile: boolean): string {
  let lines = chunk.split("\n");
  // 末元素恒丢弃：空串来自末尾换行；非空（整文件且无尾换行）= 写入中的残行，丢弃
  //（session-file.ts reverseScan 同语义：只认确认以 \n 结尾的完整行）
  lines.pop();
  // 尾块非整文件时首行可能是半行，跳过
  if (!wholeFile && lines.length > 1) lines = lines.slice(1);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // 损坏行跳过
    }
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const text = stripPreviewNoise(extractEntryText(message.content));
    if (text) return text.length > PREVIEW_MAX_CHARS ? text.slice(-PREVIEW_MAX_CHARS) : text;
  }
  return "";
}

/** 单会话尾读预览：mtimeMs+size 未变命中缓存（一次 stat 摊销，无 read）；
 * 变化/未缓存才读尾块。任何异常（缺失/权限/损坏）→ 空串。 */
export async function readSessionPreview(
  sessionPath: string,
  sessionId: string,
  io: PreviewIo = defaultIo,
): Promise<string> {
  try {
    const st = await io.stat(sessionPath);
    const hit = cache.get(sessionId);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      // LRU 触碰：重插到队尾
      cache.delete(sessionId);
      cache.set(sessionId, hit);
      return hit.preview;
    }
    let preview = "";
    if (st.size > 0) {
      const start = Math.max(0, st.size - PREVIEW_CHUNK_BYTES);
      const bytes = await io.read(sessionPath, start, st.size - start);
      const chunk = new TextDecoder("utf8", { fatal: false }).decode(bytes);
      preview = extractPreviewFromTailChunk(chunk, start === 0);
    }
    cache.set(sessionId, { mtimeMs: st.mtimeMs, size: st.size, preview });
    if (cache.size > PREVIEW_CACHE_CAPACITY) {
      // 逐出最旧（Map 首项）
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return preview;
  } catch {
    return "";
  }
}

/** 清空预览缓存（单测隔离 / 服务端测试用） */
export function clearSessionPreviewCache(): void {
  cache.clear();
}
