// 扩展资源面与 auth 凭证检查（docs08-2026-10-22 批次任务 24）：
// - 资源清单：直读 <agentDir>/{extensions,skills,prompts} 三目录 + settings.json
//   packages（npm 安装的扩展包，install/remove 的可见落点）；
// - 启停态：settings.json `extensionsState`（webui 自持键，Record<"kind/name", boolean>，
//   缺省 enabled=true）。引擎核心未见既有资源禁用键（2026-10-23 实证 pi-agent-core /
//   harness config），按计划契约「settings.json 启停态」由 webui 持有；写经模块级串行
//   promise 链 + temp+rename 原子替换（计划「串行锁」，防并发启停交错覆盖）；
// - auth 检查：CLI 第一优先（spawnSync `omo auth check --provider <p> --no-refresh`，
//   退出码 0/1/2 → 就绪/未配置/错误，超时 10s）；provider 取 settings.json
//   defaultProvider，缺则 auth.json 首个键，两者皆无直接 not_configured（不 spawn）。
//   CLI 非 ready 时 HTTP 直验兜底：models.json providers.<p>.baseUrl 存在、api 属
//   OpenAI 兼容（openai-completions/openai-responses/缺省）且 auth.json 有 key →
//   GET {baseUrl}/models + Bearer（10s 超时）——2xx → ready、401/403 → not_configured、
//   其余/网络错 → error（修复生产缺陷：CLI 在 server 子进程内恒 exit=2 invalid）。
//   凭证材料绝不回显——响应只含 status/provider/checkedAt/checkedVia，不含任何 CLI 输出；
// - install/remove/update：非交互可行性已实证（2026-10-23：stdin 关闭下
//   `omo install npm:<不存在包>` 干净 E404 退出、`omo remove` 干净退出、`omo update`
//   无提示持续运行），可行→做：async spawn 有界超时（install/remove 120s、update 180s）。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCompiledBinary, releaseRoot } from "../runtime-paths";
import { ApiError } from "./http";

export const AUTH_TIMEOUT_MS = 10_000;
export const INSTALL_REMOVE_TIMEOUT_MS = 120_000;
export const UPDATE_TIMEOUT_MS = 180_000;

export type ResourceKind = "extension" | "skill" | "prompt" | "package";
export const RESOURCE_KINDS: readonly ResourceKind[] = ["extension", "skill", "prompt", "package"];

export interface ExtensionItem {
  name: string;
  kind: ResourceKind;
  enabled: boolean;
  /** package 项的安装源（npm:<pkg>@<ver> 等），remove 动作的入参 */
  source?: string;
}

interface SettingsDoc {
  defaultProvider?: unknown;
  packages?: unknown;
  extensionsState?: unknown;
  [key: string]: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------- settings 读写（串行锁）

function readSettings(agentDir: string): SettingsDoc {
  const file = join(agentDir, "settings.json");
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** settings.json 写串行锁：多次写经 promise 链排队，防交错覆盖（models-discover 同款纪律） */
let writeQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

/** 原子写：temp+rename，读方只见旧或新完整文件 */
function writeSettingsAtomic(agentDir: string, doc: SettingsDoc): void {
  mkdirSync(agentDir, { recursive: true });
  const file = join(agentDir, "settings.json");
  const tmp = join(agentDir, `.settings.json.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

// ---------------------------------------------------------------- 资源清单扫描

function stateMap(agentDir: string): Record<string, boolean> {
  const raw = readSettings(agentDir).extensionsState;
  if (!isRecord(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

function stripExt(name: string): string {
  return name.replace(/\.(js|mjs|ts)$/, "");
}

/** 三目录 + packages 扫描；目录缺失返回空段（诚实空态），畸形清单（无 SKILL.md 的目录等）跳过 */
export function listExtensions(agentDir: string): ExtensionItem[] {
  const state = stateMap(agentDir);
  const items: ExtensionItem[] = [];
  const enabledOf = (kind: ResourceKind, name: string): boolean => state[`${kind}/${name}`] ?? true;

  const extDir = join(agentDir, "extensions");
  if (existsSync(extDir)) {
    for (const name of readdirSync(extDir)) {
      const full = join(extDir, name);
      if (!statSync(full).isFile()) continue;
      if (!/\.(js|mjs|ts)$/.test(name)) continue;
      items.push({ name: stripExt(name), kind: "extension", enabled: enabledOf("extension", stripExt(name)) });
    }
  }

  const skillsDir = join(agentDir, "skills");
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      const full = join(skillsDir, name);
      if (!statSync(full).isDirectory()) continue;
      // 畸形清单：无 SKILL.md 的目录不列入（引擎同样不加载）
      if (!existsSync(join(full, "SKILL.md"))) continue;
      items.push({ name, kind: "skill", enabled: enabledOf("skill", name) });
    }
  }

  const promptsDir = join(agentDir, "prompts");
  if (existsSync(promptsDir)) {
    for (const name of readdirSync(promptsDir)) {
      const full = join(promptsDir, name);
      if (!statSync(full).isFile()) continue;
      if (!name.endsWith(".md")) continue;
      items.push({ name: name.slice(0, -3), kind: "prompt", enabled: enabledOf("prompt", name.slice(0, -3)) });
    }
  }

  // settings.json packages（npm 安装的扩展包）：install/remove 的可见落点；包恒启用
  //（引擎级启停无非交互面，不伪造开关）
  const packages = readSettings(agentDir).packages;
  if (Array.isArray(packages)) {
    for (const p of packages) {
      if (typeof p !== "string" || p.trim() === "") continue;
      const source = p;
      const name = p.replace(/^npm:/, "").replace(/@[^@]+$/, "") || p;
      items.push({ name, kind: "package", enabled: true, source });
    }
  }

  items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : RESOURCE_KINDS.indexOf(a.kind) - RESOURCE_KINDS.indexOf(b.kind)));
  return items;
}

export interface ToggleResult {
  name: string;
  kind: ResourceKind;
  enabled: boolean;
}

/** 启停写入（串行锁内完成读-改-写）；资源不存在 404 */
export async function setResourceEnabled(
  agentDir: string,
  kind: ResourceKind,
  name: string,
  enabled: boolean,
): Promise<ToggleResult> {
  if (kind === "package") {
    throw new ApiError(400, "invalid_kind", "package 资源不参与启停（引擎级启停无非交互面）");
  }
  return serialized(async () => {
    const exists = listExtensions(agentDir).some((it) => it.kind === kind && it.name === name);
    if (!exists) {
      throw new ApiError(404, "extension_not_found", `资源不存在：${kind}/${name}`);
    }
    const doc = readSettings(agentDir);
    const raw = isRecord(doc.extensionsState) ? doc.extensionsState : {};
    doc.extensionsState = { ...raw, [`${kind}/${name}`]: enabled };
    writeSettingsAtomic(agentDir, doc);
    return { name, kind, enabled };
  });
}

// ---------------------------------------------------------------- auth 凭证检查

export type AuthStatusValue = "ready" | "not_configured" | "error";

export interface AuthStatus {
  status: AuthStatusValue;
  /** 检查所用的 provider 名；未配置为 null。绝不回显凭证材料 */
  provider: string | null;
  checkedAt: number;
  detail: string | null;
  /** 结果通道：cli = 引擎 CLI（第一优先，含 CLI 缺失/无法直验时的降级）；http = CLI 非 ready 后的 OpenAI 兼容直验兜底 */
  checkedVia: "cli" | "http";
}

/** 引擎 CLI（node + omo.js）解析；与 senpi-adapter exportHtml 同源推导 */
export function resolveEngineCli(pluginDir: string): { nodeBin: string; cliJs: string } | null {
  const cliJs = isCompiledBinary()
    ? join(releaseRoot(), "engine", "node_modules", "omo-ai", "bin", "omo.js")
    : join(dirname(pluginDir), "bin", "omo.js");
  if (!existsSync(cliJs)) return null;
  return { nodeBin: process.execPath, cliJs };
}

function authProviderOf(agentDir: string): string | null {
  const settings = readSettings(agentDir);
  if (typeof settings.defaultProvider === "string" && settings.defaultProvider.trim() !== "") {
    return settings.defaultProvider;
  }
  // settings 未配 → auth.json 首个 provider 键（只读键名，绝不读值）
  const authFile = join(agentDir, "auth.json");
  if (!existsSync(authFile)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(authFile, "utf8"));
    if (isRecord(parsed)) {
      const key = Object.keys(parsed)[0];
      if (typeof key === "string" && key !== "") return key;
    }
  } catch {
    // 畸形 auth.json → 视作未配置
  }
  return null;
}

export interface AuthCheckOptions {
  agentDir: string;
  engineCli: { nodeBin: string; cliJs: string } | null;
  timeoutMs?: number;
  /** 指定 provider 检查（POST /api/auth/check）：CLI 实证支持 `auth check --provider <p>`，
   * 给定时跳过 authProviderOf 推导直接使用；不给定保持既有默认推导语义。 */
  provider?: string;
}

/** OpenAI 兼容 api 值（models.json providers.<p>.api）：/models 直验可行 */
const OPENAI_COMPATIBLE_APIS: ReadonlySet<string> = new Set(["openai-completions", "openai-responses"]);

/** auth.json 指定 provider 的 key（直验 Bearer 用，仅内存传递绝不外显）；缺失/畸形 → null */
function providerKeyOf(agentDir: string, provider: string): string | null {
  const entry = readAuthDoc(agentDir)[provider];
  return isRecord(entry) && typeof entry.key === "string" && entry.key !== "" ? entry.key : null;
}

/** HTTP 直验条件：models.json providers.<p> 的 baseUrl 非空且 api 兼容（缺省视作 OpenAI 兼容）。
 * 返回 null = 无法直验（条目缺失/无 baseUrl/api 非兼容如 anthropic）。 */
function providerHttpFallbackConfig(agentDir: string, provider: string): { baseUrl: string } | null {
  const entry = readModelsLoose(agentDir)[provider];
  if (!isRecord(entry)) return null;
  const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
  if (baseUrl === "") return null;
  if (typeof entry.api === "string" && !OPENAI_COMPATIBLE_APIS.has(entry.api)) return null;
  return { baseUrl };
}

/** CLI 非 ready 后的 HTTP 直验兜底：GET {baseUrl去尾斜杠}/models + Bearer key
 * （Node 24 全局 fetch + AbortSignal.timeout，缺省 10s）。2xx → ready；401/403 →
 * not_configured；网络错/超时/其他状态 → error。detail 简短且绝不含 key。
 * 直验条件不满足（baseUrl/api/key 任一缺失）返回 null，调用方保留 CLI 结果。 */
async function httpFallbackCheck(agentDir: string, provider: string, timeoutMs?: number): Promise<AuthStatus | null> {
  const cfg = providerHttpFallbackConfig(agentDir, provider);
  if (cfg === null) return null;
  const key = providerKeyOf(agentDir, provider);
  if (key === null) return null;
  const timeout = timeoutMs ?? AUTH_TIMEOUT_MS;
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/models`;
  const viaHttp = (status: AuthStatusValue, detail: string | null): AuthStatus => ({
    status,
    provider,
    checkedAt: Date.now(),
    detail,
    checkedVia: "http",
  });
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeout) });
    if (res.ok) return viaHttp("ready", null);
    if (res.status === 401 || res.status === 403) {
      return viaHttp("not_configured", `HTTP 直验 ${res.status}：凭证被服务端拒绝`);
    }
    return viaHttp("error", `HTTP 直验失败（HTTP ${res.status}）`);
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    return viaHttp("error", aborted ? `HTTP 直验超时（${timeout}ms）` : `HTTP 直验网络错误：${reason}`);
  }
}

/** async：CLI 第一优先——spawnSync omo auth check 退出码 0/1/2 → ready/not_configured/error，
 * ready 直接采用（checkedVia="cli"）；超时/CLI 缺失 → error。CLI 非 ready 时走 HTTP 直验兜底
 * （生产缺陷：CLI 在 server 子进程内恒 exit=2 invalid，设置页添加凭证从未成功——2026-11-11 修复）；
 * 无法直验（baseUrl/api/key 任一缺失）保留 CLI 结果，error 时 detail 注明。
 * provider 无法确定时直接 not_configured（不 spawn）。--no-refresh：只读检查不触凭证刷新。 */
export async function checkAuthStatus(opts: AuthCheckOptions): Promise<AuthStatus> {
  const provider = opts.provider ?? authProviderOf(opts.agentDir);
  const viaCli = (status: AuthStatusValue, detail: string | null): AuthStatus => ({
    status,
    provider,
    checkedAt: Date.now(),
    detail,
    checkedVia: "cli",
  });
  if (!provider) return viaCli("not_configured", null);
  let cli: AuthStatus;
  if (!opts.engineCli) {
    cli = viaCli("error", "omo CLI 不存在，无法检查凭证");
  } else {
    const r = spawnSync(opts.engineCli.nodeBin, [opts.engineCli.cliJs, "auth", "check", "--provider", provider, "--no-refresh"], {
      encoding: "utf8",
      timeout: opts.timeoutMs ?? AUTH_TIMEOUT_MS,
      cwd: opts.agentDir,
      env: { ...process.env, OMO_CODING_AGENT_DIR: opts.agentDir, SENPI_CODING_AGENT_DIR: opts.agentDir },
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      cli = viaCli("error", `凭证检查超时（${opts.timeoutMs ?? AUTH_TIMEOUT_MS}ms）`);
    } else if (r.error) {
      cli = viaCli("error", `凭证检查启动失败：${r.error.message}`);
    } else if (r.status === 0) {
      cli = viaCli("ready", null);
    } else if (r.status === 1) {
      cli = viaCli("not_configured", null);
    } else {
      cli = viaCli("error", `凭证检查失败（exit=${r.status ?? "null"}）`);
    }
  }
  if (cli.status === "ready") return cli;
  const http = await httpFallbackCheck(opts.agentDir, provider, opts.timeoutMs);
  if (http !== null) return http;
  if (cli.status === "error") {
    return { ...cli, detail: `${cli.detail ?? "CLI 检查失败"}；无法 HTTP 直验（缺 baseUrl、api 非兼容或无 key）` };
  }
  return cli;
}

// ---------------------------------------------------------------- 凭证写入（r10 批次任务 13）

/** auth.json 直读（回滚快照用）；缺失/损坏返回空表 */
function readAuthDoc(agentDir: string): Record<string, unknown> {
  const file = join(agentDir, "auth.json");
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** auth.json 原子写（temp+rename，同 settings 纪律） */
function writeAuthDocAtomic(agentDir: string, doc: Record<string, unknown>): void {
  mkdirSync(agentDir, { recursive: true });
  const file = join(agentDir, "auth.json");
  const tmp = join(agentDir, `.auth.json.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

/** 写入粘贴凭证：auth.json[provider]={key}（引擎认证存储同款形态，见 readApiKey）+
 * settings.json defaultProvider=provider（authProviderOf 检查面同源）。
 * 返回回滚函数：恢复两处旧值（原本无 auth.json 则删除，不留空壳文件）；
 * key 只落引擎认证文件，不经任何日志。
 * 同步写入（调用点为单发用户动作；saveAndCheckCredential 内紧接检查，无并发交错面）。 */
export function applyAuthCredential(agentDir: string, provider: string, apiKey: string): () => void {
  const prevAuth = readAuthDoc(agentDir);
  const prevProvider = readSettings(agentDir).defaultProvider;
  const prevAuthExisted = existsSync(join(agentDir, "auth.json"));
  writeAuthDocAtomic(agentDir, { ...prevAuth, [provider]: { key: apiKey } });
  writeSettingsAtomic(agentDir, { ...readSettings(agentDir), defaultProvider: provider });
  return () => {
    const restore: Record<string, unknown> = { ...readAuthDoc(agentDir) };
    if (prevAuth[provider] === undefined) delete restore[provider];
    else restore[provider] = prevAuth[provider];
    if (prevAuthExisted) writeAuthDocAtomic(agentDir, restore);
    else rmSync(join(agentDir, "auth.json"), { force: true });
    const s = readSettings(agentDir);
    if (prevProvider === undefined) delete s.defaultProvider;
    else s.defaultProvider = prevProvider;
    writeSettingsAtomic(agentDir, s);
  };
}

export interface CredentialSaveResult {
  /** 复用既有三态检查结果（绝不回显凭证材料） */
  status: AuthStatus;
  /** 非 ready 时已回滚（无效 key 不落盘） */
  rolledBack: boolean;
}

/** 粘贴凭证端到端：写入 → checkAuthStatus（async：CLI 第一优先 + HTTP 直验兜底）；
 * 非 ready 回滚（含 not_configured/error）。失败不抛——失败原因在 status.detail。 */
export async function saveAndCheckCredential(opts: {
  agentDir: string;
  engineCli: { nodeBin: string; cliJs: string } | null;
  provider: string;
  apiKey: string;
  /** 可选 baseUrl：非空串时同步 models.json providers.<id>.baseUrl；检查未过同事务回滚 */
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<CredentialSaveResult> {
  const rollbackAuth = applyAuthCredential(opts.agentDir, opts.provider, opts.apiKey);
  const rollbackModels = applyAuthBaseUrl(opts.agentDir, opts.provider, opts.baseUrl ?? "");
  const status = await checkAuthStatus({
    agentDir: opts.agentDir,
    engineCli: opts.engineCli,
    timeoutMs: opts.timeoutMs,
  });
  if (status.status !== "ready") {
    rollbackModels();
    rollbackAuth();
    return { status, rolledBack: true };
  }
  return { status, rolledBack: false };
}

// ---------------------------------------------------------------- 凭证列表 / 删除（provider 认证配置面批次）

/** key 掩码：长度 ≥8 → 前 3 + "***" + 后 4；否则全 "***"。绝不回显完整 key。 */
export function maskKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0) return "***";
  if (key.length < 8) return "***";
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

/** models.json 宽松直读：仅判 hasBaseUrl 用，缺失/损坏一律返回空表（不抛）。 */
function readModelsLoose(agentDir: string): Record<string, unknown> {
  const file = join(agentDir, "models.json");
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const providers = isRecord(parsed) ? parsed.providers : undefined;
    return isRecord(providers) ? providers : {};
  } catch {
    return {};
  }
}

export interface AuthProviderItem {
  name: string;
  /** auth.json 条目 type 字段（既有写入形态无 type 时为 null） */
  type: string | null;
  keyMask: string;
  /** models.json 该 provider 是否配置了 baseUrl */
  hasBaseUrl: boolean;
}

/** 列 auth.json 全部 provider（GET /api/auth/providers）：只读键名与 type，绝不读值外显；
 * auth.json 缺失/损坏 → 空数组。 */
export function listAuthProviders(agentDir: string): AuthProviderItem[] {
  const doc = readAuthDoc(agentDir);
  const providers = readModelsLoose(agentDir);
  return Object.entries(doc).map(([name, entry]) => ({
    name,
    type: isRecord(entry) && typeof entry.type === "string" ? entry.type : null,
    keyMask: maskKey(isRecord(entry) ? entry.key : undefined),
    hasBaseUrl: typeof (providers[name] as Record<string, unknown> | undefined)?.baseUrl === "string"
      && (providers[name] as Record<string, unknown>).baseUrl !== "",
  }));
}

/** 删除 auth.json 指定 provider（DELETE /api/auth/providers/:id）：不存在 404；
 * temp+rename 原子写（同 writeAuthDocAtomic 纪律）。不动 models.json。 */
export function deleteAuthProvider(agentDir: string, provider: string): void {
  const doc = readAuthDoc(agentDir);
  if (!(provider in doc)) {
    throw new ApiError(404, "auth_provider_not_found", `凭证不存在：${provider}`);
  }
  const next = { ...doc };
  delete next[provider];
  writeAuthDocAtomic(agentDir, next);
}

/** models.json 原子写（temp+rename，models-discover 同款纪律）；目录确保存在 */
function writeModelsDocAtomic(agentDir: string, doc: Record<string, unknown>): void {
  mkdirSync(agentDir, { recursive: true });
  const file = join(agentDir, "models.json");
  const tmp = join(agentDir, `.models.json.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

/** models.json 宽松整读（回滚快照用）；缺失/损坏返回 null（原本无有效文件） */
function readModelsDocLoose(agentDir: string): Record<string, unknown> | null {
  const file = join(agentDir, "models.json");
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** baseUrl 写入（POST /api/auth/credentials 可选 baseUrl）：providers.<id>.baseUrl 同步——
 * 条目不存在则建最小条目 {baseUrl, api:"openai-completions", models:[]}；存在则只改 baseUrl，
 * 其余字段不动。返回回滚函数：恢复整份 models.json 旧态（原本无有效文件则删除）。
 * 空 baseUrl（空串）= 不改动 models.json，回滚为空操作（同事务语义）。 */
function applyAuthBaseUrl(agentDir: string, provider: string, baseUrl: string): () => void {
  if (baseUrl === "") return () => {};
  const prev = readModelsDocLoose(agentDir);
  const prevExisted = existsSync(join(agentDir, "models.json"));
  const doc: Record<string, unknown> = prev ? { ...prev } : {};
  const providers = isRecord(doc.providers) ? { ...doc.providers } : {};
  const entry = isRecord(providers[provider]) ? { ...(providers[provider] as Record<string, unknown>) } : null;
  providers[provider] = entry === null
    ? { baseUrl, api: "openai-completions", models: [] }
    : { ...entry, baseUrl };
  doc.providers = providers;
  writeModelsDocAtomic(agentDir, doc);
  return () => {
    if (prev !== null) writeModelsDocAtomic(agentDir, prev);
    else rmSync(join(agentDir, "models.json"), { force: true });
  };
}

// ---------------------------------------------------------------- install / remove / update

export type ExtensionAction = "install" | "remove" | "update";

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** CLI 输出末尾截断（只回执行日志，不回凭证——auth 输出不经此路径） */
function tail(text: string, max = 1500): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  return lines.slice(-20).join("\n").slice(-max);
}

/** 非交互 spawn（stdin 关闭 + 有界超时，超时 kill）；exit 0 → ok */
export function runExtensionAction(opts: {
  agentDir: string;
  engineCli: { nodeBin: string; cliJs: string } | null;
  action: ExtensionAction;
  source?: string;
}): Promise<ActionResult> {
  const cli = opts.engineCli;
  const label = opts.action === "update" ? "omo update" : `omo ${opts.action} ${opts.source ?? ""}`.trim();
  if (!cli) {
    return Promise.resolve({ ok: false, message: "omo CLI 不存在，动作不可用（引擎 CLI 安装）" });
  }
  const args = [cli.cliJs, opts.action];
  if (opts.action !== "update") {
    if (typeof opts.source !== "string" || opts.source.trim() === "") {
      return Promise.resolve({ ok: false, message: "安装源必填" });
    }
    args.push(opts.source.trim());
  }
  const timeoutMs = opts.action === "update" ? UPDATE_TIMEOUT_MS : INSTALL_REMOVE_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(cli.nodeBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.agentDir,
      env: { ...process.env, OMO_CODING_AGENT_DIR: opts.agentDir, SENPI_CODING_AGENT_DIR: opts.agentDir },
    });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      out += d.toString();
    });
    const finish = (ok: boolean, message: string): void => {
      clearTimeout(timer);
      resolve({ ok, message });
    };
    child.on("error", (err) => finish(false, `${label} 启动失败：${err.message}`));
    child.on("close", (code, signal) => {
      if (signal === "SIGKILL") finish(false, `${label} 超时（${timeoutMs}ms）被终止`);
      else if (code === 0) finish(true, tail(out) || `${label} 完成`);
      else finish(false, tail(`${label} 失败（exit=${code}）\n${out}`));
    });
  });
}
