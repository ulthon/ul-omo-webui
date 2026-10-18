// 记忆浏览路由（docs08-r4 任务 12，只读）：GET /api/memory/facts?project=<绝对路径>。
// 数据源 = 项目记忆库 repo/notes/facts/*.md（front-matter + bullet 拆条）与
// repo/system/*.md（记忆正文 markdown 整体返回）。库定位（spike 钉死口径）：
// 优先读项目会话 JSONL 的 senpi-memory.session-binding 条目 data.identity；
// 缺失时按算法重算兜底：sha256(resolve(cwd))[:8] + basename 清洗 slug
//（NFKD → 非字母数字折叠 '-' → 截 40，空回退 "agent"）。
// 安全：realpath 防护——解析出的库目录必须落在 <home>/agents/ 内（home =
// OMO_MEMORY_HOME 或 ~/.omo/memory，与引擎同 HOME）；身份串形状白名单前置。
// 绝不写库；runtime/ 仅读 facts 运行 final.json 的 outcome/finishedAt 两字段（遥测白名单，
// docs08-r5 任务 14），其余管线工件不读；库不存在/空返回空列表 + 库路径说明字段，
// 库缺失时 telemetry=null（诚实空态）。
import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ApiDeps } from "./deps";
import { ApiError, route } from "./http";
import { validateProjectInput } from "./paths";

/** 会话 JSONL 里的绑定条目 customType（spike 实测序列化形态：
 * {"type":"custom","customType":"senpi-memory.session-binding","data":{"identity":…}}） */
const SESSION_BINDING_TYPE = "senpi-memory.session-binding";
/** 单会话文件最多读头部字节数（绑定条目在会话开头写入；256KB 足够且避免大文件全读） */
const SESSION_HEAD_BYTES = 256 * 1024;
/** 最多翻多少个会话找绑定条目（超出走重算兜底） */
const SESSION_PROBE_LIMIT = 20;
/** 会话数据里取出的身份串形状白名单（路径穿越在提取层即不可表达，realpath 防护兜底） */
const IDENTITY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 记忆库 home：显式 OMO_MEMORY_HOME 优先，否则 ~/.omo/memory（注入点供单测） */
function memoryHome(override?: string): string {
  return override ?? (process.env.OMO_MEMORY_HOME || join(homedir(), ".omo", "memory"));
}

/** basename 清洗 slug：NFKD → 非 [\p{L}\p{M}\p{N}] 折叠 '-' → NFC → 掐首尾 '-' →
 * 截 40 → 掐尾 '-'；空串回退 "agent"（与引擎 resolveMemoryIdentity 同源，spike (a)） */
function slugify(name: string): string {
  const folded = name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{M}\p{N}]/gu, "-")
    .normalize("NFC")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return folded === "" ? "agent" : folded;
}

/** 重算兜底：libId = `${slug}-${sha256(realpath 后的 cwd)[:8]}`（输入必须 realpath 形态） */
function memoryIdentityFor(projectReal: string): string {
  const hash = createHash("sha256").update(resolve(projectReal), "utf8").digest("hex").slice(0, 8);
  return `${slugify(basename(projectReal))}-${hash}`;
}

/** 读文件头部（绑定条目位于会话开头；读不到/异常返回 null） */
function readHead(path: string, max: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(max);
    const bytes = readSync(fd, buf, 0, max, 0);
    return buf.toString("utf8", 0, bytes);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** 从会话 JSONL 文本提取 data.identity；无绑定条目或形状不合法返回 null */
function identityFromSessionText(text: string): string | null {
  const idx = text.indexOf(SESSION_BINDING_TYPE);
  if (idx < 0) return null;
  const m = text.slice(idx, idx + 2048).match(/"identity"\s*:\s*"([^"]+)"/);
  const identity = m?.[1];
  return identity && IDENTITY_SHAPE.test(identity) ? identity : null;
}

/** 拆 YAML front-matter：返回 description 与正文；无/残缺 front-matter 时全文当正文 */
function splitFrontMatter(text: string): { description: string | null; body: string } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { description: null, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return { description: null, body: text };
  let description: string | null = null;
  for (let i = 1; i < end; i += 1) {
    const m = lines[i].match(/^description:\s*(.*)$/);
    if (m && m[1].trim()) description = m[1].trim();
  }
  return { description, body: lines.slice(end + 1).join("\n") };
}

/** facts 正文拆条：bullet 行各成一条（剥 "- " 标记，内容原文保留），续行并入上一条 */
function bulletEntries(body: string): string[] {
  const entries: string[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    const bullet = line.match(/^\s*-\s+(.*)$/);
    if (bullet) {
      entries.push(bullet[1]);
    } else if (entries.length > 0) {
      entries[entries.length - 1] += `\n${line.trimEnd()}`;
    }
  }
  return entries;
}

/** 目录下 *.md 列表（降序；目录不存在/不可读 = 空库态，不抛） */
function listMarkdownFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".md")).sort((a, b) => b.localeCompare(a));
}

/** facts 月文件组：front-matter 跳过、bullet 拆条、原文完整不截断 */
function readFactGroups(dir: string): Array<{ file: string; description: string | null; entries: string[] }> {
  return listMarkdownFiles(dir).map((file) => {
    const { description, body } = splitFrontMatter(readFileSync(join(dir, file), "utf8"));
    return { file, description, entries: bulletEntries(body) };
  });
}

/** system 记忆正文组：markdown 正文整体返回（不拆条，渲染层按正文块呈现） */
function readSystemGroups(dir: string): Array<{ file: string; description: string | null; body: string }> {
  return listMarkdownFiles(dir).map((file) => {
    const { description, body } = splitFrontMatter(readFileSync(join(dir, file), "utf8"));
    return { file, description, body: body.trim() };
  });
}

/** 遥测卡（docs08-r5 任务 14，只读）：库存在时的硬数据。字段口径均由 mini-spike 钉死
 *（.omo/evidence/docs08-r5/task-14-spike.md：committed=outcome 字段、日界线=服务器本地时区、
 * 损坏 JSON 跳过+warn 计数）。 */
export interface MemoryTelemetry {
  /** 当日 committed 记忆运行个数 */
  todayCount: number;
  /** facts bullet 条目总数 */
  totalEntries: number;
  /** facts + system 的 *.md 文件数 */
  fileCount: number;
  /** 最新 facts 文件 mtime（ISO 串；无 facts 文件为 null） */
  lastEntryAt: string | null;
  /** repo/system/*.md 磁盘字节和（UI 文案定“system 文件体积”，非注入体积） */
  systemBytes: number;
}

/** 服务器本地时区日界线键（YYYY-M-D 本地年月日；刻意不用 UTC 口径，见 mini-spike 结论 2） */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 文件 stat（缺失/非普通文件/不可读一律 null） */
function statOrNull(path: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(path);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** 当日 committed 运行计数（mini-spike 钉死口径）：outcome==="committed" 且 finishedAt
 * 本地年月日等于 now；损坏 JSON 跳过并 console.warn 汇总计数；无 final.json（进行中/
 * 中断运行）与日期不可解析静默不计 */
function countTodayCommittedRuns(runsDir: string, now: Date): number {
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return 0; // runtime/facts/runs 不存在 = 今日无运行，非错误
  }
  const todayKey = localDateKey(now);
  let count = 0;
  let skipped = 0;
  for (const name of names) {
    let raw: string;
    try {
      raw = readFileSync(join(runsDir, name, "final.json"), "utf8");
    } catch {
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      skipped += 1;
      continue;
    }
    const at = new Date(String(data.finishedAt ?? ""));
    if (data.outcome === "committed" && !Number.isNaN(at.getTime()) && localDateKey(at) === todayKey) {
      count += 1;
    }
  }
  if (skipped > 0) console.warn(`[memory-telemetry] ${skipped} 个损坏 final.json 已跳过（${runsDir}）`);
  return count;
}

/** 遥测计算（只读；runtime/ 仅触碰 facts 运行 final.json，见文件头白名单）。
 * factsGroups 复用路由已拆条结果，避免二次解析。 */
export function readMemoryTelemetry(
  libDir: string,
  factsGroups: Array<{ entries: string[] }>,
  now: Date,
): MemoryTelemetry {
  const factsDir = join(libDir, "repo", "notes", "facts");
  const systemDir = join(libDir, "repo", "system");
  const factsFiles = listMarkdownFiles(factsDir);
  const systemFiles = listMarkdownFiles(systemDir);
  let systemBytes = 0;
  let lastMs: number | null = null;
  for (const file of systemFiles) systemBytes += statOrNull(join(systemDir, file))?.size ?? 0;
  for (const file of factsFiles) {
    const st = statOrNull(join(factsDir, file));
    if (st && (lastMs === null || st.mtimeMs > lastMs)) lastMs = st.mtimeMs;
  }
  return {
    todayCount: countTodayCommittedRuns(join(libDir, "runtime", "facts", "runs"), now),
    totalEntries: factsGroups.reduce((n, g) => n + g.entries.length, 0),
    fileCount: factsFiles.length + systemFiles.length,
    lastEntryAt: lastMs === null ? null : new Date(lastMs).toISOString(),
    systemBytes,
  };
}

export function createMemoryRoutes(deps: ApiDeps & { memoryHome?: string }): Hono {
  const app = new Hono();
  app.get("/api/memory/facts", route(async (c: Context) => {
    const project = validateProjectInput(c.req.query("project"));
    // 只读已注册项目（越界 403；路径形状/存在性校验在 validateProjectInput 400）
    if (!deps.meta.listProjectMeta().some((row) => row.projectPath === project)) {
      throw new ApiError(403, "project_not_registered", `项目未注册，拒绝读取：${project}`);
    }

    // 库定位：优先会话绑定条目（最近 20 个会话逐个读头部），缺失重算兜底；
    // 会话列表读不到（项目库损坏等）不炸，同样走兜底
    let identity: string | null = null;
    try {
      const sessions = await deps.engines.sessionsList(project);
      const recent = [...sessions]
        .sort((a, b) => b.modified.localeCompare(a.modified))
        .slice(0, SESSION_PROBE_LIMIT);
      for (const session of recent) {
        const head = readHead(session.path, SESSION_HEAD_BYTES);
        if (!head) continue;
        identity = identityFromSessionText(head);
        if (identity) break;
      }
    } catch {
      // 兜底重算
    }
    identity ??= memoryIdentityFor(project);

    const home = memoryHome(deps.memoryHome);
    const agentsRoot = join(home, "agents");
    const libDir = join(agentsRoot, identity);

    // realpath 防护：库目录真实落点必须在 agents/ 内（等于目录本身/符号链接逃逸一律拒绝）
    let agentsReal: string | null = null;
    try {
      agentsReal = realpathSync(agentsRoot);
    } catch {
      // agents/ 不存在 = 全局无任何记忆库
    }
    let libReal: string | null = null;
    if (agentsReal) {
      try {
        libReal = realpathSync(libDir);
      } catch {
        // 库不存在（诚实空态）
      }
      if (libReal && (libReal === agentsReal || !libReal.startsWith(agentsReal + "/"))) {
        throw new ApiError(403, "memory_escape", `记忆库路径越界被拒绝：${identity}`);
      }
    }
    // 库存在/缺失两分支直返：if 内对 let libReal 直接收窄（const 别名对 let 不收窄）
    if (libReal !== null && statSync(libReal).isDirectory()) {
      const factsGroups = readFactGroups(join(libReal, "repo", "notes", "facts"));
      return c.json({
        project,
        libraryId: identity,
        libraryPath: libReal,
        exists: true,
        facts: factsGroups,
        system: readSystemGroups(join(libReal, "repo", "system")),
        telemetry: readMemoryTelemetry(libReal, factsGroups, new Date()),
      });
    }
    // 库缺失 = telemetry null（诚实空态：无库即无遥测数字可报）
    return c.json({
      project,
      libraryId: identity,
      libraryPath: libReal ?? libDir,
      exists: false,
      facts: [],
      system: [],
      telemetry: null,
    });
  }));
  return app;
}
