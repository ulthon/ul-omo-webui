// Composer 纯逻辑助手（todo 21）：草稿来源决策、localStorage 兜底、图片校验、
// 输入历史翻页。DOM 无关的函数放这里，供 bun 单测直接覆盖；
// FileReader 等浏览器 API 的薄封装也集中在此（单测跳过）。

import type { DraftInfo, InputHistoryItem } from "@/lib/api";

// ---------- 草稿（服务端 + localStorage 兜底） ----------

/** 防抖落库间隔（计划 todo 21：1s） */
export const DRAFT_DEBOUNCE_MS = 1000;

/** 图片大小上限：超过拒绝并提示（自定值，记录于 .omo/qa/W4/composer.md） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 单条 prompt 图片数上限（与服务端 parseImages 上限一致，routes-session.ts） */
export const MAX_IMAGES = 8;

const DRAFT_KEY_PREFIX = "senpi-webui:draft:";

export interface LocalDraft {
  content: string;
  /** 服务端保存失败的时刻（ISO），用于诊断，不参与决策 */
  savedAt: string;
}

export function draftKey(sessionId: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}`;
}

function storageAvailable(): boolean {
  return typeof localStorage !== "undefined";
}

export function readLocalDraft(sessionId: string): LocalDraft | null {
  if (!storageAvailable()) return null;
  try {
    const raw = localStorage.getItem(draftKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalDraft>;
    if (typeof parsed.content !== "string") return null;
    return { content: parsed.content, savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "" };
  } catch {
    return null;
  }
}

export function writeLocalDraft(sessionId: string, content: string): void {
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(draftKey(sessionId), JSON.stringify({ content, savedAt: new Date().toISOString() } satisfies LocalDraft));
  } catch {
    // 配额满等异常不阻塞输入（兜底失败时内容仍在组件状态里，直到刷新前都有救）
  }
}

export function clearLocalDraft(sessionId: string): void {
  if (!storageAvailable()) return;
  try {
    localStorage.removeItem(draftKey(sessionId));
  } catch {
    // 忽略
  }
}

/** 草稿来源：server=服务端草稿（已落库）；local=本地兜底胜出（需要回同步服务端） */
export type DraftSource = "server" | "local" | "none";

/**
 * 草稿恢复来源决策：默认优先服务端草稿（跨设备/刷新语义）；两处都有时取较新者——
 * 服务端保存失败期间的 localStorage 兜底必然晚于最后一次成功保存，服务恢复后按
 * 时间戳取新，避免恢复到过期服务端草稿丢掉失败期间的输入。
 * source==="local" 时调用方应安排补同步（content 尚未落服务端）。
 */
export function resolveDraftSource(server: DraftInfo | null, local: LocalDraft | null): { content: string; source: DraftSource } {
  const serverContent = server?.content ?? "";
  const localContent = local?.content ?? "";
  if (!serverContent && !localContent) return { content: "", source: "none" };
  if (serverContent && localContent) {
    const serverAt = Date.parse(server?.updatedAt ?? "") || 0;
    const localAt = Date.parse(local?.savedAt ?? "") || 0;
    return localAt > serverAt ? { content: localContent, source: "local" } : { content: serverContent, source: "server" };
  }
  return serverContent ? { content: serverContent, source: "server" } : { content: localContent, source: "local" };
}

// ---------- 图片 ----------

export function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/** 校验待上传图片，返回错误提示文案；null 表示通过 */
export function validateImageFile(file: { size: number; type: string }): string | null {
  if (!file.type.startsWith("image/")) return "仅支持图片文件";
  if (file.size > MAX_IMAGE_BYTES) return `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB，已拒绝`;
  return null;
}

/** FileReader 薄封装：读为 dataURL（base64 前缀由 dataUrlToBase64 剥离） */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

// ---------- 输入历史翻页 ----------

/**
 * 翻页纯函数：older 往更旧（index+1，末端截断）；newer 往更新（index-1），
 * 越过最新一条返回 null（调用方据此关闭历史态并还原进入前的草稿）。
 */
export function stepHistoryIndex(index: number, dir: "older" | "newer", count: number): number | null {
  if (dir === "older") return Math.min(index + 1, count - 1);
  return index - 1 >= 0 ? index - 1 : null;
}

/** 历史条目在提示条里的预览文本（单行截断） */
export function historyPreview(item: InputHistoryItem, max = 40): string {
  const oneLine = item.content.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

// ---------- 大段粘贴转附件（B10 docs08-r3 任务 17） ----------

/** 粘贴文本超过该 UTF-8 字节数即弹选择条（原样插入 / 作为附件发送 / 忽略） */
export const PASTE_ATTACHMENT_THRESHOLD = 4096;

/** UTF-8 字节数：阈值判定按字节口径（与服务端 1MB 上限、CJK 粘贴场景对齐） */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 选择条体积文案：KB 一位小数（≥100 KB 取整），恒有 " KB" 后缀 */
export function formatPasteKb(bytes: number): string {
  const kb = bytes / 1024;
  const rounded = kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10;
  return `${rounded} KB`;
}

/**
 * 发送时 prompt 体拼接（铁律：附件内容不进 prompt 正文，只带绝对路径行由引擎
 * 按需读取）：text + 换行 + 每附件一行 `[大段文本已保存为附件：<绝对路径>（按需读取）]`；
 * text 为空（纯附件发送）时仅返回路径行。无附件原样返回。
 */
export function appendAttachmentLines(text: string, attachments: ReadonlyArray<{ path: string }>): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((a) => `[大段文本已保存为附件：${a.path}（按需读取）]`);
  return text ? `${text}\n${lines.join("\n")}` : lines.join("\n");
}
