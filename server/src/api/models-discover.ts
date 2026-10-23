// OpenAI 兼容 provider 模型发现（docs08-2026-10-22 批次任务 23）：
// 读 models.json 中 provider 的 baseUrl → fetch <baseUrl>/models（30s 超时）→
// 与既有 models 数组合并去重（保留既有条目，新增只补 {id} 默认形态）→
// 原子写回（temp+rename）。失败不落盘；discover 自身多次写经模块级串行
// promise 链防交错覆盖。写回只依赖 rename 原子性：readCustomModels 是同步
// readFileSync 直读（engine-runtime.ts），读方只见旧或新完整文件、永不见半写态。
// 发现/合并语义对齐引擎 `omo models discover`（chunk-56COAYOU.js）：载荷接受
// 裸数组或 {data:[...]}，条目须有非空字符串 id，按 id 去重保序。
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError } from "./http";

export const DISCOVERY_TIMEOUT_MS = 30_000;

/** 引擎侧认可的 OpenAI 兼容 api 集（openai-completions/openai-responses）；api 字段
 * 缺省视为兼容（引擎对缺省同样放行）。 */
const OPENAI_COMPATIBLE_APIS = new Set(["openai-completions", "openai-responses"]);

interface ProviderEntry {
  baseUrl?: unknown;
  apiKey?: unknown;
  api?: unknown;
  headers?: unknown;
  models?: unknown;
}

export interface ModelsDocument {
  providers?: Record<string, ProviderEntry>;
}

export interface ListedModel {
  id: string;
}

export interface DiscoveryReport {
  provider: string;
  url: string;
  /** 拉到的远端模型 id（去重保序） */
  discovered: string[];
  /** 本地缺失（可导入）的 id */
  added: string[];
  /** 本地已有（保留既有，绝不改写）的 id */
  unchanged: string[];
  /** 实际写入的 id（仅导入且确有新增时非空） */
  imported: string[] | null;
  written: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------- 纯函数（导出供单测）

/** 载荷解析：裸数组或 {data:[...]}；条目须为对象且 id 非空字符串，按 id 去重保序。 */
export function parseModelListing(payload: unknown): ListedModel[] {
  const data = Array.isArray(payload) ? payload : isRecord(payload) ? payload.data : undefined;
  if (!Array.isArray(data)) return [];
  const listed = new Map<string, ListedModel>();
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim() === "") continue;
    if (!listed.has(entry.id)) listed.set(entry.id, { id: entry.id });
  }
  return [...listed.values()];
}

/** baseUrl → <baseUrl>/models（去尾斜杠拼接）；非法/缺失返回 null。 */
export function discoveryListingUrl(baseUrl: unknown): { request: string; display: string } | null {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  return { request: url.toString(), display: url.toString() };
}

/** 请求头：accept JSON + provider.headers（null 值删头）+ apiKey 兜底 Bearer
 * （已显式配置 authorization 头时不覆盖）。apiKey 不回显到任何响应。 */
export function buildDiscoveryHeaders(provider: ProviderEntry): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (isRecord(provider.headers)) {
    for (const [name, value] of Object.entries(provider.headers)) {
      if (value === null) delete headers[name];
      else if (typeof value === "string") headers[name] = value;
    }
  }
  if (typeof provider.apiKey === "string" && provider.apiKey !== "") {
    const hasAuth = Object.keys(headers).some((n) => n.toLowerCase() === "authorization");
    if (!hasAuth) headers.authorization = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

/** 合并（纯函数）：返回 [nextDocument, added, unchanged]。既有条目原样保留
 * （同一引用，字节不变）；新增只补 {id} 默认形态（对齐引擎 discover 缺省）。 */
export function mergeDiscoveredModels(
  document: ModelsDocument,
  providerId: string,
  listed: ListedModel[],
): { document: ModelsDocument; added: string[]; unchanged: string[] } {
  const providers = { ...document.providers };
  const provider = providers[providerId];
  const configured = Array.isArray(provider?.models) ? [...(provider!.models as unknown[])] : [];
  const added: string[] = [];
  const unchanged: string[] = [];
  for (const item of listed) {
    const index = configured.findIndex((e) => isRecord(e) && e.id === item.id);
    if (index >= 0) {
      unchanged.push(item.id);
      continue;
    }
    configured.push({ id: item.id });
    added.push(item.id);
  }
  providers[providerId] = { ...provider, models: configured };
  return { document: { ...document, providers }, added, unchanged };
}

/** providers 结构完整性校验：providers 是对象、每项是对象、models（若有）是数组
 * 且条目为含非空字符串 id 的对象。返回首个问题的描述，合法返回 null。 */
export function validateModelsDocument(document: unknown): string | null {
  if (!isRecord(document)) return "顶层必须是 JSON 对象";
  const providers = document.providers;
  if (providers === undefined) return null;
  if (!isRecord(providers)) return "providers 必须是对象";
  for (const [name, entry] of Object.entries(providers)) {
    if (!isRecord(entry)) return `provider "${name}" 必须是对象`;
    if (entry.models === undefined) continue;
    if (!Array.isArray(entry.models)) return `provider "${name}" 的 models 必须是数组`;
    for (const m of entry.models) {
      if (!isRecord(m) || typeof m.id !== "string" || m.id === "") {
        return `provider "${name}" 的 models 条目必须有非空字符串 id`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- 读写与串行

export function readModelsDocument(modelsPath: string): { content: string; document: ModelsDocument } {
  let content: string;
  try {
    content = readFileSync(modelsPath, "utf8");
  } catch (err) {
    throw new ApiError(400, "models_unreadable", `无法读取 models.json：${err instanceof Error ? err.message : String(err)}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch (err) {
    throw new ApiError(400, "models_invalid", `models.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const invalid = validateModelsDocument(document);
  if (invalid) throw new ApiError(400, "models_invalid", `models.json 结构不完整：${invalid}`);
  return { content, document: document as ModelsDocument };
}

/** 模块级串行链：discover 的读-改-写整体排队，防多次导入交错覆盖。 */
let discoverQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = discoverQueue.then(fn, fn);
  discoverQueue = next.catch(() => undefined);
  return next;
}

/** 原子写回：同目录 temp + rename（readFileSync 读方只见旧或新完整文件）。 */
function writeModelsJsonAtomic(modelsPath: string, document: ModelsDocument): void {
  const temp = `${modelsPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, modelsPath);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      /* temp 清理尽力而为 */
    }
    throw new ApiError(500, "models_write_failed", `models.json 写回失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function fetchListing(
  url: { request: string; display: string },
  provider: ProviderEntry,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ListedModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`超时（${DISCOVERY_TIMEOUT_MS / 1000}s）`)), DISCOVERY_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  let response: Response;
  try {
    response = await fetchImpl(url.request, { headers: buildDiscoveryHeaders(provider), signal: controller.signal });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(502, "discover_upstream_failed", `GET ${url.display} 失败：${reason}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
  if (!response.ok) {
    throw new ApiError(502, "discover_upstream_failed", `GET ${url.display} 失败：HTTP ${response.status}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(502, "discover_upstream_failed", `GET ${url.display} 未返回 JSON`);
  }
  const listed = parseModelListing(payload);
  // 空列表/无模型字段形态在此显式报错（调用方可区分"远端确实一个模型都没有"）
  if (listed.length === 0 && !listingHasModels(payload)) {
    throw new ApiError(502, "discover_bad_listing", `GET ${url.display} 未返回模型列表`);
  }
  return listed;
}

function listingHasModels(payload: unknown): boolean {
  const data = Array.isArray(payload) ? payload : isRecord(payload) ? payload.data : undefined;
  return Array.isArray(data);
}

// ---------------------------------------------------------------- 入口（导出供路由与单测）

/** 列出 models.json 中可发现的 provider（GET /api/models/discover）。 */
export function listDiscoverableProviders(modelsPath: string): Array<{ id: string; baseUrl: string; api: string | null; modelCount: number }> {
  if (!existsSync(modelsPath)) return [];
  const { document } = readModelsDocument(modelsPath);
  const out: Array<{ id: string; baseUrl: string; api: string | null; modelCount: number }> = [];
  for (const [id, entry] of Object.entries(document.providers ?? {})) {
    out.push({
      id,
      baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
      api: typeof entry.api === "string" ? entry.api : null,
      modelCount: Array.isArray(entry.models) ? entry.models.length : 0,
    });
  }
  return out;
}

/** 发现一次：always 拉远端并 diff；importIds 非空时把选中的新增合并写回。
 * 失败（读/取/解析/校验任一步）一律不落盘。多次调用经模块级串行。 */
export async function discoverProviderModels(options: {
  modelsPath: string;
  providerId: string;
  /** 导入选择："all" 全部新增，或新增 id 子集；缺省 = 仅预览不写盘 */
  importIds?: string[] | "all";
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<DiscoveryReport> {
  return serialized(async () => {
    const { modelsPath, providerId, importIds, fetchImpl = fetch, signal } = options;
    const { document } = readModelsDocument(modelsPath);
    const provider = document.providers?.[providerId];
    if (!isRecord(provider)) {
      throw new ApiError(400, "provider_not_found", `models.json 中不存在 provider "${providerId}"`);
    }
    if (typeof provider.api === "string" && !OPENAI_COMPATIBLE_APIS.has(provider.api)) {
      throw new ApiError(400, "provider_not_compatible", `provider "${providerId}" 的 api 为 "${provider.api}"，不是 OpenAI 兼容类型`);
    }
    if (typeof provider.baseUrl !== "string" || provider.baseUrl.trim() === "") {
      throw new ApiError(400, "invalid_baseurl", `provider "${providerId}" 缺少 baseUrl，无法发现模型`);
    }
    const url = discoveryListingUrl(provider.baseUrl);
    if (!url) {
      throw new ApiError(400, "invalid_baseurl", `provider "${providerId}" 的 baseUrl 不是合法 URL`);
    }
    const listed = await fetchListing(url, provider, fetchImpl, signal);

    const configuredIds = new Set(
      Array.isArray(provider.models)
        ? provider.models.filter((m): m is Record<string, unknown> => isRecord(m) && typeof m.id === "string").map((m) => m.id)
        : [],
    );
    const discovered = listed.map((m) => m.id);
    const added = discovered.filter((id) => !configuredIds.has(id));
    const unchanged = discovered.filter((id) => configuredIds.has(id));

    const importing = importIds !== undefined;
    if (!importing || added.length === 0) {
      return { provider: providerId, url: url.display, discovered, added, unchanged, imported: null, written: false };
    }

    let selected: string[];
    if (importIds === "all") {
      selected = added;
    } else {
      if (!Array.isArray(importIds) || importIds.some((id) => typeof id !== "string")) {
        throw new ApiError(400, "invalid_import", "import 必须是 \"all\" 或模型 id 字符串数组");
      }
      const unknown = importIds.filter((id) => !added.includes(id));
      if (unknown.length > 0) {
        throw new ApiError(400, "invalid_import", `import 含未知或已存在的模型 id：${unknown.join(", ")}`);
      }
      selected = importIds;
    }
    const listedSelected = new Set(selected);
    const { document: nextDocument, added: mergedAdded } = mergeDiscoveredModels(document, providerId, listed.filter((m) => listedSelected.has(m.id)));
    // 写前再校验（防既有文档病态：校验由 readModelsDocument 兜底，这里防御合并结果）
    const invalid = validateModelsDocument(nextDocument);
    if (invalid) throw new ApiError(500, "models_invalid", `合并结果结构不完整，已放弃写回：${invalid}`);
    writeModelsJsonAtomic(modelsPath, nextDocument);
    return { provider: providerId, url: url.display, discovered, added, unchanged, imported: mergedAdded, written: true };
  });
}

/** 默认 models.json 路径（与 spawn/直读同源 agentDir）。 */
export function defaultModelsPath(agentDirPath: string): string {
  return join(agentDirPath, "models.json");
}

/** mtime 读取（测试断言"失败零改"用）。 */
export function modelsMtimeMs(modelsPath: string): number {
  return statSync(modelsPath).mtimeMs;
}
