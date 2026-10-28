// 扩展资源面与 auth 凭证检查（docs08-2026-10-22 批次任务 24）：
// - 资源清单：直读 <agentDir>/{extensions,skills,prompts} 三目录 + settings.json
//   packages（npm 安装的扩展包，install/remove 的可见落点）；
// - 启停态：settings.json `extensionsState`（webui 自持键，Record<"kind/name", boolean>，
//   缺省 enabled=true）。引擎核心未见既有资源禁用键（2026-10-23 实证 pi-agent-core /
//   harness config），按计划契约「settings.json 启停态」由 webui 持有；写经模块级串行
//   promise 链 + temp+rename 原子替换（计划「串行锁」，防并发启停交错覆盖）；
// - auth 检查：spawnSync `omo auth check --provider <p> --no-refresh`（退出码 0/1/2 →
//   就绪/未配置/错误，超时 10s）；provider 取 settings.json defaultProvider，缺则
//   auth.json 首个键，两者皆无直接 not_configured（不 spawn）。凭证材料绝不回显——
//   响应只含 status/provider/checkedAt，不含任何 CLI 输出；
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
}

/** spawnSync omo auth check：退出码 0/1/2 → ready/not_configured/error；超时/CLI 缺失 → error。
 * provider 无法确定时直接 not_configured（不 spawn）。--no-refresh：只读检查不触凭证刷新。 */
export function checkAuthStatus(opts: AuthCheckOptions): AuthStatus {
  const now = Date.now();
  const provider = authProviderOf(opts.agentDir);
  if (!provider) return { status: "not_configured", provider: null, checkedAt: now, detail: null };
  if (!opts.engineCli) {
    return { status: "error", provider, checkedAt: now, detail: "omo CLI 不存在，无法检查凭证" };
  }
  const r = spawnSync(opts.engineCli.nodeBin, [opts.engineCli.cliJs, "auth", "check", "--provider", provider, "--no-refresh"], {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? AUTH_TIMEOUT_MS,
    cwd: opts.agentDir,
    env: { ...process.env, OMO_CODING_AGENT_DIR: opts.agentDir, SENPI_CODING_AGENT_DIR: opts.agentDir },
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { status: "error", provider, checkedAt: now, detail: `凭证检查超时（${opts.timeoutMs ?? AUTH_TIMEOUT_MS}ms）` };
  }
  if (r.error) {
    return { status: "error", provider, checkedAt: now, detail: `凭证检查启动失败：${r.error.message}` };
  }
  if (r.status === 0) return { status: "ready", provider, checkedAt: now, detail: null };
  if (r.status === 1) return { status: "not_configured", provider, checkedAt: now, detail: null };
  return { status: "error", provider, checkedAt: now, detail: `凭证检查失败（exit=${r.status ?? "null"}）` };
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
 * 同步写入（调用点为单发用户动作；saveAndCheckCredential 内紧接同步检查，无并发交错面）。 */
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

/** 粘贴凭证端到端：写入 → checkAuthStatus；非 ready 回滚（含 not_configured/error）。
 * 同步执行（spawnSync 既有纪律），失败不抛——失败原因在 status.detail。 */
export function saveAndCheckCredential(opts: {
  agentDir: string;
  engineCli: { nodeBin: string; cliJs: string } | null;
  provider: string;
  apiKey: string;
  timeoutMs?: number;
}): CredentialSaveResult {
  const rollback = applyAuthCredential(opts.agentDir, opts.provider, opts.apiKey);
  const status = checkAuthStatus({
    agentDir: opts.agentDir,
    engineCli: opts.engineCli,
    timeoutMs: opts.timeoutMs,
  });
  if (status.status !== "ready") {
    rollback();
    return { status, rolledBack: true };
  }
  return { status, rolledBack: false };
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
