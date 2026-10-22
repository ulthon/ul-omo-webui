// 配置文件读写层（W1 todo 1）：全局配置目录的 tags.json / snippets.json 与
// 项目根 .ul-omo-webui.json 两类 JSON 源（schema version=1）。
// 读：mtime+size 缓存失效——外部改文件（含 git pull）后下一次读即生效，无需重启；
//     JSON 解析失败抛带文件路径的明确错误，绝不静默吞损坏文件。
// 写：进程内 per-file promise 链串行化；tmp+rename 原子写（写前清同目录同前缀的
//     崩溃残留 tmp）；稳定排序 + 2 空格缩进 + 末尾换行（git diff 友好）；
//     写前必须解析成功（不覆盖已损坏文件）。
// 注意：串行化是进程内的——多 server 实例共享同一配置目录属未定义行为
// （单用户单实例假设，README 已注明）；字段级未知键透传保留，列表条目仅取 name/content+sort。
// allow: SIZE_OK — 单一内聚职责（类型+规范化+文件IO+工厂），与项目既有模块规模惯例一致
// （db/meta.ts 433 行、api/engine-runtime.ts 同量级），拆分只会增加 import 耦合无结构收益。
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { selfDir } from "../runtime-paths";

// ---------- 领域类型（camelCase，供 REST 层直接序列化） ----------

/** 标签展示模式（todo 20 v2）：text=文字徽标，grid=色格 A 方格（渲染层语义） */
export type TagDisplayMode = "text" | "grid";

export const TAG_DISPLAY_MODES: readonly TagDisplayMode[] = ["text", "grid"];

/** 标签自定义色：#rrggbb 六位十六进制（大小写不限；REST 层 400 校验，读取层宽容丢弃） */
export const TAG_COLOR_RE = /^#[0-9a-f]{6}$/i;

export interface TagEntry {
  name: string;
  sort: number;
  /** 自定义色（缺省 = 前端按名称 hash 自动取色，hash 色绝不落盘） */
  color?: string;
  /** 展示覆盖（缺省 = 跟随全局 tags.displayMode） */
  display?: TagDisplayMode;
}

export interface SnippetEntry {
  content: string;
  sort: number;
}

/** 思考档（引擎实测 glm 系为 low/high/max，无 off；W2 todo 7 起为项目偏好字段） */
export type PreferredThinkingLevel = "low" | "high" | "max";

export const THINKING_LEVEL_VALUES: readonly PreferredThinkingLevel[] = ["low", "high", "max"];

export interface TagsFile {
  version: number;
  tags: TagEntry[];
  /** 未知字段透传保留 */
  [key: string]: unknown;
}

export interface SnippetsFile {
  version: number;
  snippets: SnippetEntry[];
  [key: string]: unknown;
}

export interface ProjectConfig {
  version: number;
  tags: TagEntry[];
  snippets: SnippetEntry[];
  preferredModel: string | null;
  permissionPreset: string | null;
  preferredThinkingLevel: PreferredThinkingLevel | null;
  [key: string]: unknown;
}

export interface ProjectConfigPatch {
  tags?: TagEntry[];
  snippets?: SnippetEntry[];
  preferredModel?: string | null;
  permissionPreset?: string | null;
  preferredThinkingLevel?: PreferredThinkingLevel | null;
}

export interface OpenConfigStoreOptions {
  /** 全局配置目录；缺省依次取 UL_OMO_WEBUI_CONFIG_DIR 环境变量、~/.config/ul-omo-webui/ */
  globalDir?: string;
  /** 项目根目录（其下读写 .ul-omo-webui.json）；缺省为宿主仓库根 */
  projectRoot?: string;
}

export const CONFIG_SCHEMA_VERSION = 1;

/** tags.json 专用 schema 版本（todo 20 v2：条目新增 color/display 可选字段）。
 * 读兼容 v1（versionOf 保原文，tagEntry 宽容解析）；首写升 2。 */
export const TAGS_SCHEMA_VERSION = 2;

export function defaultGlobalDir(): string {
  return process.env.UL_OMO_WEBUI_CONFIG_DIR ?? join(homedir(), ".config", "ul-omo-webui");
}

function defaultProjectRoot(): string {
  // 与 meta.ts 同锚点：src 下模块相对仓库根；编译/打包后指向发行根
  return join(selfDir(), "..", "..");
}

export interface ConfigStore {
  readonly globalDir: string;
  readonly projectRoot: string | null;

  // 读（mtime+size 缓存，外部改动下次读即生效；文件不存在返回空文档）
  readTags(): TagsFile;
  readSnippets(): SnippetsFile;
  readProjectConfig(): ProjectConfig;

  /**
   * 项目文件原文直读（规范化前，todo 6 加法只读）：文件不存在返回 null；损坏或
   * 非 JSON 对象抛错（与 readProjectConfig 同语义）。供迁移/合并读判定
   * 「文件原文是否已有某字段」——规范化输出字段恒存在（缺失与显式 null 均为 null），
   * 只有原文键集合能区分两者（迁移过渡态判定依赖）。
   */
  readProjectRaw(): Record<string, unknown> | null;

  // 写（整替列表；读-改-写保留文件内未知字段；进程内串行、原子落盘）
  writeTags(tags: TagEntry[]): Promise<void>;
  writeSnippets(snippets: SnippetEntry[]): Promise<void>;
  /** 部分更新项目配置（文件不存在以空文档为基底），返回链上排队写入 */
  updateProjectConfig(patch: ProjectConfigPatch): Promise<void>;
}

// ---------- 规范化（字段缺失视为空 + 稳定排序） ----------

function sortTags(tags: TagEntry[]): TagEntry[] {
  return [...tags].sort((a, b) => a.sort - b.sort || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function sortSnippets(snippets: SnippetEntry[]): SnippetEntry[] {
  return [...snippets].sort((a, b) =>
    a.sort - b.sort || (a.content < b.content ? -1 : a.content > b.content ? 1 : 0),
  );
}

function emptyTagsFile(): TagsFile {
  return { version: CONFIG_SCHEMA_VERSION, tags: [] };
}

function emptySnippetsFile(): SnippetsFile {
  return { version: CONFIG_SCHEMA_VERSION, snippets: [] };
}

function emptyProjectConfig(): ProjectConfig {
  return {
    version: CONFIG_SCHEMA_VERSION,
    tags: [],
    snippets: [],
    preferredModel: null,
    permissionPreset: null,
    preferredThinkingLevel: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(parsed: unknown, filePath: string): Record<string, unknown> {
  if (!isRecord(parsed)) {
    throw new Error(`配置文件必须是 JSON 对象: ${filePath}`);
  }
  return parsed;
}

function versionOf(doc: Record<string, unknown>): number {
  return typeof doc.version === "number" ? doc.version : CONFIG_SCHEMA_VERSION;
}

function entriesOf<E>(value: unknown, filePath: string, field: string, item: (raw: unknown) => E): E[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`配置文件字段 ${field} 必须是数组: ${filePath}`);
  }
  return value.map(item);
}

function tagEntry(raw: unknown): TagEntry {
  const obj: Record<string, unknown> = isRecord(raw) ? raw : {};
  // color/display 宽容解析（防 read-modify-write 剥字段的第一刀）：合法值保留透传，
  // 非法值丢弃（写入口 routes-tags PUT 已 400 挡住，磁盘手改只损失该可选字段）
  const color = typeof obj.color === "string" && TAG_COLOR_RE.test(obj.color) ? obj.color : undefined;
  const display =
    typeof obj.display === "string" && (TAG_DISPLAY_MODES as readonly string[]).includes(obj.display)
      ? (obj.display as TagDisplayMode)
      : undefined;
  return {
    name: typeof obj.name === "string" ? obj.name : "",
    sort: typeof obj.sort === "number" && Number.isFinite(obj.sort) ? obj.sort : 0,
    ...(color !== undefined ? { color } : {}),
    ...(display !== undefined ? { display } : {}),
  };
}

function snippetEntry(raw: unknown): SnippetEntry {
  const obj: Record<string, unknown> = isRecord(raw) ? raw : {};
  return {
    content: typeof obj.content === "string" ? obj.content : "",
    sort: typeof obj.sort === "number" && Number.isFinite(obj.sort) ? obj.sort : 0,
  };
}

function stringOrNull(value: unknown, filePath: string, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`配置文件字段 ${field} 必须是 string 或 null: ${filePath}`);
  }
  return value;
}

/** 档位字段（closed set）：非法值抛错（绝不静默吞），由合并读层降级 configError */
function thinkingLevelOrNull(value: unknown, filePath: string, field: string): PreferredThinkingLevel | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !THINKING_LEVEL_VALUES.includes(value as PreferredThinkingLevel)) {
    throw new Error(`配置文件字段 ${field} 必须是 ${THINKING_LEVEL_VALUES.join("/")} 或 null: ${filePath}`);
  }
  return value as PreferredThinkingLevel;
}

function normalizeTagsFile(parsed: unknown, filePath: string): TagsFile {
  const doc = parseObject(parsed, filePath);
  return {
    ...doc,
    version: versionOf(doc),
    tags: sortTags(entriesOf(doc.tags, filePath, "tags", tagEntry)),
  };
}

function normalizeSnippetsFile(parsed: unknown, filePath: string): SnippetsFile {
  const doc = parseObject(parsed, filePath);
  return {
    ...doc,
    version: versionOf(doc),
    snippets: sortSnippets(entriesOf(doc.snippets, filePath, "snippets", snippetEntry)),
  };
}

function normalizeProjectConfig(parsed: unknown, filePath: string): ProjectConfig {
  const doc = parseObject(parsed, filePath);
  return {
    ...doc,
    version: versionOf(doc),
    tags: sortTags(entriesOf(doc.tags, filePath, "tags", tagEntry)),
    snippets: sortSnippets(entriesOf(doc.snippets, filePath, "snippets", snippetEntry)),
    preferredModel: stringOrNull(doc.preferredModel, filePath, "preferredModel"),
    permissionPreset: stringOrNull(doc.permissionPreset, filePath, "permissionPreset"),
    preferredThinkingLevel: thinkingLevelOrNull(doc.preferredThinkingLevel, filePath, "preferredThinkingLevel"),
  };
}

// ---------- 单文件层（读缓存 + 写链） ----------

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** tmp 文件命名前缀：.tags.json.tmp-* / .snippets.json.tmp-* / .ul-omo-webui.json.tmp-* */
function tmpPrefix(filePath: string): string {
  return `.${basename(filePath)}.tmp-`;
}

function atomicWrite(filePath: string, text: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  // 写前清同目录同前缀的崩溃残留 tmp（上次进程 rename 前中断留下的）
  const prefix = tmpPrefix(filePath);
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix)) unlinkSync(join(dir, name));
  }
  const tmpPath = join(dir, `${prefix}${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmpPath, text);
  renameSync(tmpPath, filePath);
}

interface StatInfo {
  exists: boolean;
  mtimeMs: number;
  size: number;
}

function statOrEnoent(filePath: string): StatInfo {
  try {
    const st = statSync(filePath);
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    if (isEnoent(err)) return { exists: false, mtimeMs: 0, size: 0 };
    throw err;
  }
}

/**
 * 单文件读写层。读带 mtime+size 缓存（自写后缓存同步更新）；写走进程内
 * promise 链串行化，链上执行体为同步块（读现有 → serialize → tmp+rename → 缓存更新），
 * 单线程下读不可能插入执行体中间，rename 原子性保证读者只见旧值或新值。
 */
function makeFileLayer<T>(
  filePath: string,
  emptyDoc: () => T,
  normalize: (parsed: unknown, filePath: string) => T,
) {
  let cache: { mtimeMs: number; size: number; doc: T } | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  /** 调用前提：文件存在。解析失败抛带路径的明确错误。 */
  function parseDoc(): T {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`配置文件不是合法 JSON: ${filePath}（${reason}）`);
    }
    return normalize(parsed, filePath);
  }

  function read(): T {
    const st = statOrEnoent(filePath);
    if (!st.exists) return emptyDoc();
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.doc;
    const doc = parseDoc();
    cache = { mtimeMs: st.mtimeMs, size: st.size, doc };
    return doc;
  }

  /** 原文直读（不规范化、不走缓存——迁移/过渡态判定低频路径，同步小文件读可接受）。
   * 文件不存在返回 null；解析失败抛与 parseDoc 同文案的带路径错误。 */
  function readRaw(): unknown {
    const st = statOrEnoent(filePath);
    if (!st.exists) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`配置文件不是合法 JSON: ${filePath}（${reason}）`);
    }
    return parsed;
  }

  function write(merge: (existing: T | null) => T): Promise<void> {
    const run = (): void => {
      // 写前必须解析成功：文件存在但损坏时在此抛错，不覆盖
      const existing = statOrEnoent(filePath).exists ? parseDoc() : null;
      const doc = merge(existing);
      atomicWrite(filePath, JSON.stringify(doc, null, 2) + "\n");
      const st = statSync(filePath);
      cache = { mtimeMs: st.mtimeMs, size: st.size, doc };
    };
    const next = writeChain.then(run);
    // 失败不断链：后续写不受前次失败阻塞
    writeChain = next.catch(() => {});
    return next;
  }

  return { read, readRaw, write };
}

// ---------- 工厂 ----------

export function openConfigStore(options: OpenConfigStoreOptions = {}): ConfigStore {
  const globalDir = options.globalDir ?? defaultGlobalDir();
  const projectRoot = options.projectRoot === undefined ? defaultProjectRoot() : options.projectRoot;

  const tagsLayer = makeFileLayer(
    join(globalDir, "tags.json"),
    emptyTagsFile,
    normalizeTagsFile,
  );
  const snippetsLayer = makeFileLayer(
    join(globalDir, "snippets.json"),
    emptySnippetsFile,
    normalizeSnippetsFile,
  );
  const projectConfigPath = join(projectRoot, ".ul-omo-webui.json");
  const projectLayer = makeFileLayer(
    projectConfigPath,
    emptyProjectConfig,
    normalizeProjectConfig,
  );

  return {
    globalDir,
    projectRoot,

    readTags: () => tagsLayer.read(),
    readSnippets: () => snippetsLayer.read(),
    readProjectConfig: () => projectLayer.read(),

    readProjectRaw: () => {
      const raw = projectLayer.readRaw();
      if (raw === null) return null;
      if (!isRecord(raw)) throw new Error(`配置文件必须是 JSON 对象: ${projectConfigPath}`);
      return raw;
    },

    writeTags(entries) {
      return tagsLayer.write((existing) => ({
        ...(existing ?? emptyTagsFile()),
        // 首写（含从 v1 文件整替）即升 v2（todo 20）；读 v1 不拒不迁（宽容解析）
        version: TAGS_SCHEMA_VERSION,
        tags: sortTags(entries),
      }));
    },

    writeSnippets(entries) {
      return snippetsLayer.write((existing) => ({
        ...(existing ?? emptySnippetsFile()),
        snippets: sortSnippets(entries),
      }));
    },

    updateProjectConfig(patch) {
      return projectLayer.write((existing) => {
        const base = existing ?? emptyProjectConfig();
        return {
          ...base,
          tags: patch.tags === undefined ? base.tags : sortTags(patch.tags),
          snippets: patch.snippets === undefined ? base.snippets : sortSnippets(patch.snippets),
          preferredModel: patch.preferredModel === undefined ? base.preferredModel : patch.preferredModel,
          permissionPreset:
            patch.permissionPreset === undefined ? base.permissionPreset : patch.permissionPreset,
          preferredThinkingLevel:
            patch.preferredThinkingLevel === undefined ? base.preferredThinkingLevel : patch.preferredThinkingLevel,
        };
      });
    },
  };
}
