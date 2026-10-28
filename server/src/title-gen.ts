// 会话标题生成服务（计划 todo 8 / Scope 决策 9）：
// 独立 HTTP 直调模型端点（zai coding chat/completions），零引擎会话污染——
// 取数直读会话 jsonl 文件（首行 header 即 durable id 权威来源），严禁经
// adapter.messages/getEntries（会抢占活跃会话并撞引擎 ~16 个 open 会话上限）。
//
// 导出约定：所有 promise 必须被调用方 catch——自动路径（handleRoundSettled）
// 内部已全吞（console.warn，永不 reject）；手动路径（generateForSession）
// 抛 Error 由路由层转 502 带原因。进程关停（meta.close 后）在途结果自然
// 写入失败被丢弃。
//
// attempted Set 为进程内存态：失败不重试；服务重启后同会话可能再试一次，
// 属可接受上界（决策 9b，不加持久列）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetaDb } from "./db/meta";

export const DEFAULT_TITLE_BASEURL = "https://api.z.ai/api/coding/paas/v4/chat/completions";
export const DEFAULT_TITLE_MODEL = "zai-coding-cn/glm-5.3-flash";

/** prompt 按语言映射（计划任务 9；决策 9g 语义不变：会话内容进模板 + 只输出标题的
 * 指令即 injection 缓解）。zh 逐字保留原 TITLE_PROMPT_TEMPLATE；en 为新增英文档。
 * golden 逐字断言在 test/title-gen.test.ts 与 test/title-gen-trigger.test.ts（防常量引用同义反复）。 */
export type TitleLanguage = "zh" | "en";
export const TITLE_PROMPTS: Record<TitleLanguage, string> = {
  zh: "为以下对话生成一个不超过 16 个字的中文短标题，只输出标题本身",
  en: "Generate a short session title of at most 60 characters, output only the title",
};
/** 分档截断上限（计划任务 9 钦定值，禁止执行者自定）：zh 中文字数 / en 字符数 */
export const ZH_TITLE_MAX = 16;
export const EN_TITLE_MAX = 60;
/** meta_kv 键：服务端标题语言设置（缺省 zh；写入方为后续设置端点，本模块只读） */
export const TITLE_LANGUAGE_KV_KEY = "titlegen.language";
const MESSAGE_TRUNCATE = 500;
/** 自动路径超时（手动路径 ≤10s——Bun.serve 空闲 ~12s 掐断，spike 实证 14s 响应 Empty reply） */
export const AUTO_TIMEOUT_MS = 15_000;
export const MANUAL_TIMEOUT_MS = 10_000;

/** spike 实证（2026-10-11）：thinking enabled 13.5s、disabled 7.3s 且 0 reasoning
 * tokens——标题生成是轻任务，API 面的轻推理落点取 disabled（zai thinking 参数
 * 仅 enabled/disabled 两档，引擎的 low/high/max 是引擎侧 thinkingLevelMap 概念）。 */
const THINKING_DISABLED = { type: "disabled" } as const;

export function titleBaseUrl(): string {
  return process.env.UL_OMO_WEBUI_TITLE_BASEURL || DEFAULT_TITLE_BASEURL;
}

export function titleModel(): string {
  return process.env.UL_OMO_WEBUI_TITLE_MODEL || DEFAULT_TITLE_MODEL;
}

/** 标题语言解析（计划任务 9）：环境变量 UL_OMO_WEBUI_TITLE_LANG 覆盖（与
 * UL_OMO_WEBUI_TITLE_MODEL/BASEURL 同族同模式）> meta_kv titlegen.language > 缺省 zh。
 * env 非 zh/en 视为未设置（回退 kv/zh，不抛）；每次生成调用时解析，改设置无需重启。 */
export function resolveTitleLanguage(meta?: { getKv?(key: string): string | null }): TitleLanguage {
  const env = process.env.UL_OMO_WEBUI_TITLE_LANG;
  if (env === "zh" || env === "en") return env;
  return meta?.getKv?.(TITLE_LANGUAGE_KV_KEY) === "en" ? "en" : "zh";
}

/** "provider/model" → 取 provider（凭证键）与裸 id（HTTP model 参数）。
 * 缺前缀时按默认端点属主 provider 处理。 */
export function splitTitleModel(model: string): { provider: string; bareModel: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { provider: "zai-coding-cn", bareModel: model };
  return { provider: model.slice(0, slash), bareModel: model.slice(slash + 1) };
}

/** agentDir auth.json 读指定 provider 的 key（缺失/损坏返回 null，调用方抛错） */
export function readApiKey(agentDir: string, provider: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<
      string,
      { key?: unknown }
    >;
    const key = parsed[provider]?.key;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- jsonl 直读

export interface SessionHeadMessages {
  /** 磁盘 header id（= durable id，store 行 durableSessionId 同源） */
  durableId: string;
  /** 首条 user 消息文本；null = 未出现过 user 消息 */
  userText: string | null;
  /** 首条含文本的 assistant 消息文本；null = 无含文本的 assistant */
  assistantText: string | null;
  hasAssistant: boolean;
}

/** content 形态：string 直用；blocks 数组取 type==="text" 的 text 拼接（toolCall 跳过） */
function extractEntryText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  }
  return parts.join("\n").trim();
}

/** 逐行解析会话 jsonl，取 header durable id + 首条 user/assistant 消息文本；
 * 缺 header（未落盘/损坏）返回 null。 */
export function parseSessionHead(content: string): SessionHeadMessages | null {
  let durableId: string | null = null;
  let userText: string | null = null;
  let assistantText: string | null = null;
  let hasAssistant = false;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // 尾部半行/损坏行跳过
    }
    if (entry.type === "session") {
      if (typeof entry.id === "string" && entry.id) durableId = entry.id;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown; content?: unknown } | undefined;
    if (!message || typeof message.role !== "string") continue;
    if (message.role === "user" && userText === null) {
      userText = extractEntryText(message.content);
    } else if (message.role === "assistant") {
      hasAssistant = true;
      // 首条 assistant 常为 toolCall 无文本：取首条含文本的（标题素材更有效）
      if (assistantText === null) {
        const text = extractEntryText(message.content);
        if (text) assistantText = text;
      }
    }
    if (userText !== null && hasAssistant && assistantText !== null) break;
  }
  if (!durableId) return null;
  return { durableId, userText, assistantText, hasAssistant };
}

/** 会话文件直读（缺失/不可读返回 null，不抛） */
export function readSessionHead(sessionPath: string): SessionHeadMessages | null {
  let content: string;
  try {
    content = readFileSync(sessionPath, "utf8");
  } catch {
    return null;
  }
  return parseSessionHead(content);
}

/** 尾部读取字节上限（约 2000 tokens，计划 todo 2 钦定）：取会话内容末段做标题素材 */
export const SESSION_TAIL_CHARS = 8000;

export interface SessionTailMessages {
  /** 磁盘 header id（= durable id，与 readSessionHead 同源） */
  durableId: string;
  /** 尾部最后一条非空 user 消息文本；null = 尾部无 user 消息 */
  userText: string | null;
  /** 尾部最后一条含文本的 assistant 消息文本；null = 无 */
  assistantText: string | null;
}

/** 解析会话 jsonl 尾部：durable id 取自 header（header 固定在文件首部，全量扫描只为取 id）；
 * user/assistant 文本取尾部约 SESSION_TAIL_CHARS 字符内的最后一条非空。缺 header 返回 null。
 * 尾段切分产生的首条半行/损坏行按解析失败跳过。 */
export function parseSessionTail(content: string): SessionTailMessages | null {
  let durableId: string | null = null;
  for (const line of content.split("\n")) {
    if (!line.includes('"type":"session"') && !line.includes('"type": "session"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; id?: unknown };
      if (entry.type === "session" && typeof entry.id === "string" && entry.id) durableId = entry.id;
    } catch {
      continue;
    }
  }
  if (!durableId) return null;
  const tail = content.length > SESSION_TAIL_CHARS ? content.slice(-SESSION_TAIL_CHARS) : content;
  let userText: string | null = null;
  let assistantText: string | null = null;
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // 尾段首条半行/损坏行跳过
    }
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown; content?: unknown } | undefined;
    if (!message || typeof message.role !== "string") continue;
    const text = extractEntryText(message.content);
    if (!text) continue;
    if (message.role === "user") userText = text;
    else if (message.role === "assistant") assistantText = text;
  }
  return { durableId, userText, assistantText };
}

/** 会话文件尾部直读（缺失/不可读返回 null，不抛） */
export function readSessionTail(sessionPath: string): SessionTailMessages | null {
  let content: string;
  try {
    content = readFileSync(sessionPath, "utf8");
  } catch {
    return null;
  }
  return parseSessionTail(content);
}

// ---------------------------------------------------------------- prompt 与 HTTP

export function buildTitlePrompt(
  userText: string,
  assistantText: string | null,
  language: TitleLanguage = "zh",
): string {
  const parts = [`用户：${userText.slice(0, MESSAGE_TRUNCATE)}`];
  if (assistantText) parts.push(`助手：${assistantText.slice(0, MESSAGE_TRUNCATE)}`);
  return `${TITLE_PROMPTS[language]}\n\n${parts.join("\n")}`;
}

/** 模型输出清洗：去首尾引号/空白，按语言分档截断（zh 16 字 / en 60 字符） */
export function sanitizeTitle(raw: string, language: TitleLanguage = "zh"): string {
  const stripped = raw
    .trim()
    .replace(/^["'「『]+/, "")
    .replace(/["'」』]+$/, "")
    .trim();
  const max = language === "en" ? EN_TITLE_MAX : ZH_TITLE_MAX;
  return Array.from(stripped)
    .slice(0, max)
    .join("");
}

async function requestTitle(opts: {
  baseUrl: string;
  apiKey: string;
  bareModel: string;
  prompt: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  language: TitleLanguage;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await opts.fetchImpl(opts.baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: opts.bareModel,
        thinking: THINKING_DISABLED,
        messages: [{ role: "user", content: opts.prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = data.choices?.[0]?.message?.content;
    const title = sanitizeTitle(typeof content === "string" ? content : "", opts.language);
    if (!title) throw new Error("模型返回空标题");
    return title;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 服务

/** 回合落定信息（清位前捕获；sessionId 可能是未落盘 holder 别名） */
export interface RoundSettleInfo {
  sessionId: string;
  sessionPath: string;
}

export interface TitleGenDeps {
  meta: Pick<
    MetaDb,
    | "getSessionMeta"
    | "getSessionGeneratedTitle"
    | "setSessionGeneratedTitle"
    | "setSessionRenamedTitle"
    | "getKv"
  >;
  agentDir: string;
  /** sessionId → 会话 store 行（path 供 jsonl 直读、name 供触发条件）。
   * 不触发引擎 spawn；null = 会话不存在（已删/未知项目）。 */
  resolveSessionRow(sessionId: string): Promise<{ path: string; name?: string } | null>;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class TitleGenService {
  /** 进行中（以解析后 durable id 为键）；finally 清理 */
  private readonly inFlight = new Set<string>();
  /** 失败不重试（进程内存态；重启后可能再试一次，可接受上界） */
  private readonly attempted = new Set<string>();
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: TitleGenDeps) {
    this.baseUrl = deps.baseUrl ?? titleBaseUrl();
    this.model = deps.model ?? titleModel();
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** 自动路径（组合根接 EngineRuntimeOptions.onRoundSettled）：永不 reject。
   * 触发条件（决策 9c）：无 renamedTitle、无引擎 name、无 generatedTitle、
   * 存在首条 assistant 消息；幂等靠 in-flight + generatedTitle 已存在双保险。 */
  async handleRoundSettled(_projectPath: string, info: RoundSettleInfo, reason: string): Promise<void> {
    try {
      await this.autoGenerate(info, reason);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[title-gen] 自动生成失败（${info.sessionPath}，${reason}）：${message}`);
    }
  }

  private async autoGenerate(info: RoundSettleInfo, _reason: string): Promise<void> {
    const row = await this.deps.resolveSessionRow(info.sessionId);
    if (!row) return; // 会话已删等，静默放弃
    const head = readSessionHead(row.path);
    if (!head) return;
    // durable id 解析：settleInfo.sessionId 可能是 holder 别名（新会话首回合
    // 主场景），一律以 jsonl header id（磁盘权威）为 meta 读写与标记键
    const durable = head.durableId;
    if (this.inFlight.has(durable) || this.attempted.has(durable)) return;
    if (this.deps.meta.getSessionMeta(durable)?.renamedTitle) return;
    if (this.deps.meta.getSessionGeneratedTitle(durable)) return;
    if (row.name) return; // 引擎 name 会话不自动生成（标题永不可见，避免浪费调用）
    if (!head.hasAssistant || !head.userText) return; // 中断回合仅 user 消息不触发
    this.inFlight.add(durable);
    try {
      // 语言每次调用时解析（env 覆盖 > meta_kv > zh）：设置变更不重启即生效
      const title = await this.callModel(head, AUTO_TIMEOUT_MS, resolveTitleLanguage(this.deps.meta));
      this.deps.meta.setSessionGeneratedTitle(durable, title);
    } catch (err) {
      this.attempted.add(durable);
      throw err; // 交 handleRoundSettled 统一 warn
    } finally {
      this.inFlight.delete(durable);
    }
  }

  /** 手动路径（POST /api/sessions/:id/generate-title）：同步生成，失败抛错
   * 由路由转 502 带原因。不查 attempted（用户显式重试可再试）与 renamedTitle/
   * generatedTitle/name 触发条件（结果写 renamedTitle，覆盖一切既有形态）；
   * in-flight 仍防并发重入。
   *
   * language（计划任务 9）：由手动入口（routes-session POST generate-title）读服务端
   * 设置后传入；缺省 zh 保持旧调用形态行为不变。 */
  async generateForSession(sessionId: string, language: TitleLanguage = "zh"): Promise<string> {
    const row = await this.deps.resolveSessionRow(sessionId);
    if (!row) throw new Error(`会话不存在：${sessionId}`);
    // 计划 todo 2：手动生成取尾部（长会话标题应反映最近内容），自动路径仍读首部
    const head = readSessionTail(row.path);
    if (!head) throw new Error(`会话文件不可读或未落盘：${row.path}`);
    if (!head.userText) throw new Error("会话还没有用户消息，无法生成标题");
    if (this.inFlight.has(head.durableId)) throw new Error("该会话标题生成进行中");
    this.inFlight.add(head.durableId);
    try {
      const title = await this.callModel(head, MANUAL_TIMEOUT_MS, language);
      this.deps.meta.setSessionRenamedTitle(head.durableId, title);
      return title;
    } finally {
      this.inFlight.delete(head.durableId);
    }
  }

  private callModel(
    head: Pick<SessionHeadMessages, "durableId" | "userText" | "assistantText">,
    timeoutMs: number,
    language: TitleLanguage,
  ): Promise<string> {
    const { provider, bareModel } = splitTitleModel(this.model);
    const apiKey = readApiKey(this.deps.agentDir, provider);
    if (!apiKey) throw new Error(`凭证缺失：${this.deps.agentDir}/auth.json 无 ${provider} 的 key`);
    return requestTitle({
      baseUrl: this.baseUrl,
      apiKey,
      bareModel,
      prompt: buildTitlePrompt(head.userText ?? "", head.assistantText, language),
      timeoutMs,
      fetchImpl: this.fetchImpl,
      language,
    });
  }
}
