// Composer 纯逻辑助手（todo 21）：草稿来源决策、localStorage 兜底、图片校验、
// 输入历史翻页。DOM 无关的函数放这里，供 bun 单测直接覆盖；
// FileReader 等浏览器 API 的薄封装也集中在此（单测跳过）。

import type { CommandsResponse, DraftInfo, InputHistoryItem, SlashCommandInfo } from "@/lib/api";
import { CHAT_COMMANDS } from "@/components/chat/commands";

// ---------- 草稿（服务端 + localStorage 兜底） ----------

/** 防抖落库间隔（计划 todo 21：1s） */
export const DRAFT_DEBOUNCE_MS = 1000;

/** 图片大小上限：超过拒绝并提示（自定值，记录于 .omo/qa/W4/composer.md） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 单条 prompt 图片数上限（与服务端 parseImages 上限一致，routes-session.ts） */
export const MAX_IMAGES = 8;

const DRAFT_KEY_PREFIX = "ul-omo-webui:draft:";

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

// ---------- 斜杠输入提示（docs08-r3 任务 19） ----------

export type SlashSection = "extension" | "skill" | "prompt" | "webui";

/** 下拉条目：section 供分段渲染与段标题，name 为命令形态（技能含 "skill:" 前缀） */
export interface SlashItem {
  section: SlashSection;
  name: string;
  description?: string;
}

/** 四个引擎未注册命令（chat/commands.ts supported=false 名单）：绝不进下拉，
 * 选择/直发路径由命令门拦截不变 */
const UNSUPPORTED_COMMANDS = new Set(CHAT_COMMANDS.filter((c) => !c.supported).map((c) => c.name));

/**
 * 触发判定（纯派生）：值以 "/" 开头且首 token 未闭合（无空白）时返回 token 文本
 * （"/" → ""；"/ini" → "ini"）；首 token 闭合（出现空格）或非斜杠开头返回 null。
 */
export function slashTriggerToken(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? m[1] : null;
}

/** webui 静态命令段（docs08-r5 任务 8）：引擎 get_commands 枚举不含 compact
 *  （spike 隔离实例重核 75 条无命中——枚举源只收 extension/prompts/skills），
 *  webui 直调压缩端点的命令在此补挂，段名标注来源，不冒充引擎命令；引擎侧若
 *  未来注册同名命令则优先用引擎行（过滤去重）。 */
export const WEBUI_SLASH_COMMANDS: Array<{ name: string; description: string }> = [
  { name: "compact", description: "压缩上下文（webui 端点直调，非引擎命令）" },
];

/** 三段+webui 过滤：token 前缀匹配（技能行对去 "skill:" 前缀短名同样命中）；
 *  三不支持命令排除；webui 静态段在引擎命令段同名时去重 */
export function filterSlashGroups(commands: CommandsResponse, token: string): Record<SlashSection, SlashItem[]> {
  const q = token.toLowerCase();
  const matches = (name: string): boolean => {
    const lower = name.toLowerCase();
    return lower.startsWith(q) || (lower.startsWith("skill:") && lower.slice(6).startsWith(q));
  };
  const pick = (section: SlashSection, rows: SlashCommandInfo[]): SlashItem[] =>
    rows
      .filter((r) => r.name.length > 0 && !UNSUPPORTED_COMMANDS.has(r.name.toLowerCase()) && matches(r.name))
      .map((r) => ({ section, name: r.name, ...(r.description ? { description: r.description } : {}) }));
  const extension = pick("extension", commands.commands.extension);
  const extensionNames = new Set(extension.map((r) => r.name.toLowerCase()));
  return {
    extension,
    skill: pick("skill", commands.commands.skill),
    prompt: pick("prompt", commands.commands.prompt),
    webui: WEBUI_SLASH_COMMANDS.filter(
      (c) => !UNSUPPORTED_COMMANDS.has(c.name) && !extensionNames.has(c.name.toLowerCase()) && matches(c.name),
    ).map((c) => ({ section: "webui", name: c.name, description: c.description })),
  };
}

/** 空数据（available=false / 取数失败）的空段组，调用方统一走过滤渲染空态 */
export const EMPTY_SLASH_GROUPS: Record<SlashSection, SlashItem[]> = {
  extension: [],
  skill: [],
  prompt: [],
  webui: [],
};

/** 键盘导航扁平序：引擎命令 → 技能 → 用户提示 → webui 静态命令（与渲染分段一致） */
export function flattenSlashItems(groups: Record<SlashSection, SlashItem[]>): SlashItem[] {
  return [...groups.extension, ...groups.skill, ...groups.prompt, ...groups.webui];
}

/** 选择替换：首个斜杠 token 换为 /<name>（含尾部空格），保留其余输入；用户补参数后按普通 prompt 发送（webui compact 选中后直接回车即裸命令直调） */
export function slashReplaceToken(text: string, name: string): string {
  return `/${name} ${text.replace(/^\/\S*/, "")}`;
}
