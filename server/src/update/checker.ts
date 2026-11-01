// 更新检测（2026-10-31 update 批，M2）：npm registry 元数据查询，零第三方依赖。
// - registry 基址：UL_OMO_WEBUI_UPDATE_REGISTRY > `npm config get registry`（本机为
//   npmmirror，绝不硬编码 registry.npmjs.org；探测一次后缓存）。
// - 包名/当前版本：env 覆盖（QA 注入）优先，回落自身 package.json——从本模块向上找
//   name=@ulthon/ul-omo-webui 的 package.json（对齐 runtime-paths 自锚点模式，兼容
//   源码/发行包两种形态；server/package.json 同名规则不符不入选）。
// - 单项失败（网络/解析/缺字段）→ latest:"unknown"、hasUpdate:false，整体静默降级
//   不报错（检查是后台软信号，不该打断使用）。
// - 版本比较：点分数字逐段（引擎版本形如 2026.10.27-1，取每段数字前缀，段缺失按 0）；
//   unknown 永不计为有更新。
// - 引擎 current 兑底（2026-11-01 批）：node_modules 解析失败（生产 checkout 形态）时
//   spawn PATH 上引擎 CLI --version（默认 omo；UL_OMO_WEBUI_UPDATE_ENGINE_BIN 覆盖/
//   空串关闸，同 env 注入风格），结果按 bin 缓存进程生命周期。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { selfDir } from "../runtime-paths";

export interface PkgVersionInfo {
  readonly current: string;
  readonly latest: string;
  readonly hasUpdate: boolean;
}

export interface UpdateCheckResult {
  readonly webui: PkgVersionInfo;
  readonly engine: PkgVersionInfo;
}

const OWN_PKG_NAME = "@ulthon/ul-omo-webui";
const DEFAULT_ENGINE_PKG = "@code-yeongyu/senpi";
const FETCH_TIMEOUT_MS = 8000;
/** 引擎 CLI --version 兑底探测超时（3s 内不出即弃，落 unknown） */
const ENGINE_BIN_TIMEOUT_MS = 3000;

/** fetch 形状收窄（测试注入用；实现方决定是否消费 signal） */
type FetchLike = (url: string, init?: { readonly signal?: AbortSignal }) => Promise<Response>;

// ---------- 版本比较 ----------

/** 段的数字前缀（"27-1" → 27；非数字开头 → 0） */
function numericPrefix(segment: string): number {
  const m = /^\d+/.exec(segment);
  return m === null ? 0 : Number(m[0]);
}

/** 点分数字逐段比较（>0 / 0 / <0）：前导 v 剥离，段缺失按 0，尾段非数字截断 */
export function compareVersions(a: string, b: string): number {
  const sa = a.replace(/^[vV]/, "").split(".");
  const sb = b.replace(/^[vV]/, "").split(".");
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const va = numericPrefix(sa[i] ?? "0");
    const vb = numericPrefix(sb[i] ?? "0");
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

function isNewer(candidate: string, current: string): boolean {
  return candidate !== "unknown" && current !== "unknown" && compareVersions(candidate, current) > 0;
}

function toInfo(current: string, latest: string): PkgVersionInfo {
  return { current, latest, hasUpdate: isNewer(latest, current) };
}

// ---------- 包名 / 当前版本解析 ----------

let ownPkgDirCache: string | null | undefined;

/** 向上找自身包目录（name 精确匹配才算） */
function ownPkgDir(): string | null {
  if (ownPkgDirCache !== undefined) return ownPkgDirCache;
  let dir = selfDir();
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
      if (pkg.name === OWN_PKG_NAME) return (ownPkgDirCache = dir);
    } catch {
      // 无 package.json 或不可读：继续向上
    }
    const parent = dirname(dir);
    if (parent === dir) return (ownPkgDirCache = null);
    dir = parent;
  }
}

function ownPkgField(field: "name" | "version"): string | null {
  const dir = ownPkgDir();
  if (dir === null) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    const value = pkg[field];
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

/** webui 包名：env UL_OMO_WEBUI_UPDATE_PKG > 自身 package.json name > 约定名 */
export function webuiPackageName(): string {
  return process.env.UL_OMO_WEBUI_UPDATE_PKG?.trim() || ownPkgField("name") || OWN_PKG_NAME;
}

/** webui 当前版本：env UL_OMO_WEBUI_UPDATE_CURRENT_OVERRIDE（QA 字符串透传）> 自身 version */
export function webuiCurrentVersion(): string {
  return process.env.UL_OMO_WEBUI_UPDATE_CURRENT_OVERRIDE?.trim() || ownPkgField("version") || "unknown";
}

/** 引擎包名：env UL_OMO_WEBUI_UPDATE_ENGINE_PKG > 固定 @code-yeongyu/senpi */
export function enginePackageName(): string {
  return process.env.UL_OMO_WEBUI_UPDATE_ENGINE_PKG?.trim() || DEFAULT_ENGINE_PKG;
}

/** 引擎当前版本：node_modules 内包的 package.json（node 原生解析）；解析失败
 *  （生产 checkout 形态缺包/不可读）兑底引擎 CLI --version，仍失败 → unknown */
export function engineCurrentVersion(): string {
  try {
    const pkgPath = createRequire(import.meta.url).resolve(`${enginePackageName()}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return engineVersionFromBin();
  }
}

/** 引擎 CLI --version 兑底探测：UL_OMO_WEBUI_UPDATE_ENGINE_BIN > "omo"（PATH）；
 *  空串显式关闸（单测保持 unknown 旧语义，同 env 注入风格）。结果按 bin 缓存进程
 *  生命周期（CLI 版本运行期不变，不重复 spawn）；spawn/超时/空输出一律 unknown
 *  且不缓存（下次检查可重试）。 */
const engineBinVersionCache = new Map<string, string>();

function engineVersionFromBin(): string {
  const override = process.env.UL_OMO_WEBUI_UPDATE_ENGINE_BIN?.trim();
  if (override === "") return "unknown";
  const bin = override !== undefined && override !== "" ? override : "omo";
  const cached = engineBinVersionCache.get(bin);
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: ENGINE_BIN_TIMEOUT_MS }) as string;
    // 归一化：omo --version 实测输出「omo 5.1.51 (engine: senpi 2026.10.27-1)」，取
    // senpi 版本；无包装时取首个版本形 token；解不出则 unknown（不缓存可重试）
    const line = out.split("\n", 1)[0]?.trim() ?? "";
    const m = line.match(/senpi\s+v?([0-9][^\s)]*)/i) ?? line.match(/v?([0-9][0-9._-]*)/);
    const version = m?.[1] ?? "";
    if (version === "") return "unknown";
    engineBinVersionCache.set(bin, version);
    return version;
  } catch {
    return "unknown";
  }
}

// ---------- registry 基址 ----------

let registryCache: string | null | undefined; // undefined = 未探测

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** registry 基址：env > 本机 npm 配置（一次探测后缓存；探测失败 → null，检查静默降级） */
export function registryBase(): string | null {
  const env = process.env.UL_OMO_WEBUI_UPDATE_REGISTRY?.trim();
  if (env !== undefined && env !== "") return stripTrailingSlash(env);
  if (registryCache === undefined) {
    try {
      const url = execFileSync("npm", ["config", "get", "registry"], { encoding: "utf8", timeout: 5000 }).trim();
      registryCache = url === "" ? null : stripTrailingSlash(url);
    } catch {
      registryCache = null; // npm 不可用：latest 落 unknown，不报错
    }
  }
  return registryCache;
}

/** 单包 dist-tags.latest（全量元数据，兼容镜像）；任何失败 → "unknown" */
async function fetchLatest(base: string, name: string, doFetch: FetchLike): Promise<string> {
  try {
    const res = await doFetch(`${base}/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return "unknown";
    const meta = (await res.json()) as { "dist-tags"?: { latest?: unknown } };
    const latest = meta["dist-tags"]?.latest;
    return typeof latest === "string" && latest.trim() !== "" ? latest.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

export interface CheckOptions {
  /** fetch 注入口（测试）；缺省全局 fetch */
  readonly fetchImpl?: FetchLike;
}

/** 全量检查：webui + 引擎并行查询；单项失败不影响另一项，整体恒 resolve */
export async function checkUpdates(options: CheckOptions = {}): Promise<UpdateCheckResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = registryBase();
  if (base === null) {
    return { webui: toInfo(webuiCurrentVersion(), "unknown"), engine: toInfo(engineCurrentVersion(), "unknown") };
  }
  const [webuiLatest, engineLatest] = await Promise.all([
    fetchLatest(base, webuiPackageName(), doFetch),
    fetchLatest(base, enginePackageName(), doFetch),
  ]);
  return {
    webui: toInfo(webuiCurrentVersion(), webuiLatest),
    engine: toInfo(engineCurrentVersion(), engineLatest),
  };
}
