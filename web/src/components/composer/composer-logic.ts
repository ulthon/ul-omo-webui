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

// ---------- 大段粘贴转附件（B10 docs08-r3 任务 17；docs08-r7 任务 3 三态改造） ----------

/** 粘贴文本超过该 UTF-8 字节数即零点击转附件 chip（默认勾选=作为附件发送） */
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

// ---------- 粘贴 chip 三态（docs08-r7 任务 3：勾=附件保留 / 取消勾选=文本立即插入 / 叉=删除） ----------

/** chip 阶段：uploading=POST 在途（加载态）；ready=已落服务端临时区（可拼路径行、可 DELETE） */
export type PasteChipStage = "uploading" | "ready";

/** 大段文本粘贴 chip：文件落服务端临时区后 prompt 只带路径行；content 常驻
 *（取消勾选回插输入框，内容永不丢），bytes 供上传中展示体积文案。 */
export interface PasteChip {
  id: string;
  /** 服务端文件名；上传中为空串（展示用体积文案替代） */
  name: string;
  /** 服务端临时区绝对路径；上传中为空串（不可拼路径行、不可 DELETE） */
  path: string;
  /** 粘贴原文：取消勾选或 POST 失败回退时回插输入框 */
  content: string;
  /** UTF-8 字节数（onPaste 时计定） */
  bytes: number;
  stage: PasteChipStage;
}

/** 阈值判定（零点击转附件唯一门）：>4096 字节转 chip；4096 恰好不转（浏览器默认粘贴） */
export function pasteExceedsThreshold(text: string): boolean {
  return utf8ByteLength(text) > PASTE_ATTACHMENT_THRESHOLD;
}

/** 入列：上传中 chip 追加队尾（零点击即挂，勾选框默认勾选） */
export function startPasteChip(chips: readonly PasteChip[], chip: PasteChip): PasteChip[] {
  return [...chips, chip];
}

/** 上传落定：更新 name/path/stage。chip 已出列（用户抢先取消勾选/叉除/发送清空）时
 * 返回 orphan=true 且列表原样——调用方对该 path 做 best-effort DELETE（孤儿文件清理，
 * 48h 按龄清理兜底）。 */
export function settlePasteChip(
  chips: readonly PasteChip[],
  id: string,
  name: string,
  path: string,
): { chips: PasteChip[]; orphan: boolean } {
  if (!chips.some((c) => c.id === id)) return { chips: [...chips], orphan: true };
  return {
    chips: chips.map((c) => (c.id === id ? { ...c, name, path, stage: "ready" satisfies PasteChipStage } : c)),
    orphan: false,
  };
}

/** 出列（取消勾选与叉共用）：带回整条 chip——取消勾选用 content 回插、按 stage 决定
 * DELETE 时机；未知 id 列表原样返回 detached=null。 */
export function detachPasteChip(chips: readonly PasteChip[], id: string): { chips: PasteChip[]; detached: PasteChip | null } {
  const detached = chips.find((c) => c.id === id) ?? null;
  return { chips: chips.filter((c) => c.id !== id), detached };
}

/** 发送携带：仅就绪 chip（上传中无路径，绝不拼路径行）；纯上传中+空文本时发送早退 */
export function sendablePasteChips(chips: readonly PasteChip[]): Array<{ path: string }> {
  return chips.filter((c) => c.stage === "ready" && c.path !== "").map(({ path }) => ({ path }));
}

// ---------- 通用文件附件三态 chip（docs08 2026-10-23/24 批次任务 18） ----------
// 任意格式非图片文件（粘贴/选择）→ 二进制附件通道（t17）→ 三态 chip；
// 与 PasteChip（大段文本）完全分离：无「取消勾选回插」语义（文件内容不可回插
// 输入框），失败态改为行内重试/移除。图片仍走内联链路（分流是任务 19）。

/** 二进制通道单附件上限（与服务端 ATTACHMENT_BINARY_MAX_BYTES 对齐）：客户端预检，
 * 超限不出 chip（重试也必败，无意义）；服务端流式计数仍是唯一真相 */
export const FILE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export type FileChipStage = "uploading" | "ready" | "failed";

export interface FileChip {
  id: string;
  /** 原始文件名（chip 展示 + ?name= 参数）；重试沿用 */
  name: string;
  /** 原始字节数（上传中体积文案 + 预检） */
  bytes: number;
  /** 服务端临时区绝对路径；非就绪态为空串（不可拼路径行、不可 DELETE） */
  path: string;
  stage: FileChipStage;
  /** failed 态行内错误文案（apiErrorMessage 产出）；其余态空串 */
  error: string;
}

/** 发送时文件附件路径行拼装（B10 铁律同文：内容不进 prompt，只带绝对路径行） */
export function appendFileAttachmentLines(text: string, files: ReadonlyArray<{ path: string }>): string {
  if (files.length === 0) return text;
  const lines = files.map((f) => `[已附加文件：${f.path}（按需读取）]`);
  return text ? `${text}\n${lines.join("\n")}` : lines.join("\n");
}

/** 入列：上传中 chip 追加队尾 */
export function startFileChip(chips: readonly FileChip[], chip: FileChip): FileChip[] {
  return [...chips, chip];
}

/** 上传落定：填 path 转 ready。chip 已出列（在途移除/发送清空）返回 orphan=true
 * 且列表原样——调用方 best-effort DELETE 孤儿文件（48h 按龄清理兑底）。 */
export function settleFileChip(chips: readonly FileChip[], id: string, path: string): { chips: FileChip[]; orphan: boolean } {
  if (!chips.some((c) => c.id === id)) return { chips: [...chips], orphan: true };
  return {
    chips: chips.map((c) => (c.id === id ? { ...c, path, stage: "ready" satisfies FileChipStage, error: "" } : c)),
    orphan: false,
  };
}

/** 上传失败：转 failed 态携带行内错误文案（chip 保留供重试）；未知 id 原样 */
export function failFileChip(chips: readonly FileChip[], id: string, error: string): FileChip[] {
  return chips.map((c) => (c.id === id ? { ...c, stage: "failed" satisfies FileChipStage, error } : c));
}

/** 重试复位：回上传中态（path 清空，POST 成功后重新填）；未知 id 原样 */
export function resetFileChip(chips: readonly FileChip[], id: string): FileChip[] {
  return chips.map((c) => (c.id === id ? { ...c, path: "", stage: "uploading" satisfies FileChipStage, error: "" } : c));
}

/** 出列（移除）：带回整条 chip（ready 态由调用方 DELETE） */
export function detachFileChip(chips: readonly FileChip[], id: string): { chips: FileChip[]; detached: FileChip | null } {
  const detached = chips.find((c) => c.id === id) ?? null;
  return { chips: chips.filter((c) => c.id !== id), detached };
}

/** 发送携带：仅 ready chip（uploading 由发送门拦截，failed 不携带）；纯 failed/空文本
 * 发送早退由发送可达性判定处理 */
export function sendableFileChips(chips: readonly FileChip[]): Array<{ path: string }> {
  return chips.filter((c) => c.stage === "ready" && c.path !== "").map(({ path }) => ({ path }));
}

/** 上传在途判定（stale_state 语义钉死）：任一 uploading chip 在场则发送门拦截 */
export function hasUploadingFileChip(chips: readonly FileChip[]): boolean {
  return chips.some((c) => c.stage === "uploading");
}

/** 发送可达：存在可随消息携带的 chip（ready 文件 chip；failed 单独不使能发送） */
export function sendableFileChipCount(chips: readonly FileChip[]): number {
  return sendableFileChips(chips).length;
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
  { name: "compact", description: "压缩上下文（引擎协议直调，与 CLI 同入口）" },
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

/** 停止钮意图（docs08-2026-10-23-24-batch 任务 12）：后台态（runState=background_running）
 *  且当前无流式回合（queueAvailable=false）时点击停止钮不给中断语义——后台任务不受
 *  abort 协议面作用，返回 background-hint 由调用方出「有后台任务」提示；其余一切
 *  组合（含后台态叠加流式回合——中断的是当前回合）保持原 abort 语义。 */
export function stopIntent(
  runState: string | null | undefined,
  queueAvailable: boolean,
): "abort" | "background-hint" {
  return runState === "background_running" && !queueAvailable ? "background-hint" : "abort";
}
