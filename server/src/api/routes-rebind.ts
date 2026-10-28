// 会话 rebind 路由（r10 todo 18 / GAP-15）：仓库目录移动后旧会话找回。
//
// 背景：会话库按项目路径编码目录组织（<agentDir>/sessions/--encoded-cwd--/），
// 仓库一挪 webui 里这些会话就"消失"（数据在但无入口）。CLI `omo --rebind` 的
// 语义（引擎 bundle chunk-7UNN3YHW.js rebindSessionFile/moveSessionFile 实证）：
// 1. 读源 JSONL 首行 session header，重写其中 cwd 为目标项目路径；
// 2. 写目标目录临时文件（wx 独占），rename 成 <targetDir>/<basename(source)>；
// 3. 迁移 sidecars：extensions/<ext>/<encodeURIComponent(sessionId)>.json 与
//    resident-blobs/<sessionId>/（目标不存在才移，EXDEV 退 cp+rm）；
// 4. 删除源文件——物理移动是既有语义所必需：会话发现（SessionManager.list）
//    只按目标项目编码目录扫描，无引用式登记面，meta.db 亦无会话-项目绑定字段
//    （meta_session 仅按 session_id 记 pinned/title 等元数据，导入无需写库）。
//    本路由按同一语义实现（文件被移动，非复制；源目录不留副本）。
//
// 与引擎 CLI 的差异（有意降级，SDK 未导出面）：不做跨进程 move-lock/holder 探测
// ——rebind 目标是旧目录会话（非 webui 驱动的当前项目会话），活跃冲突由
// already_bound/conflict 逐会话结构化报告兜底。
//
// 输入校验：oldPath 不要求目录存在（移动后的旧仓库恰恰不存在——会话库键是
// 路径字符串本身），仅词法校验（非空字符串、绝对路径、无 NUL、resolve 后非根）；
// project 走 validateProjectInput（必须存在 + realpath 规范形态，与列表口径一致）。
import { Hono, type Context } from "hono";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SessionManager } from "@code-yeongyu/senpi";
import { encodeCwdToSessionDirName } from "../adapter/senpi-adapter";
import { agentDir as defaultAgentDir } from "../config";
import { ApiError, parseJsonBody, route } from "./http";
import { validateProjectInput } from "./paths";
import type { ApiDeps } from "./deps";

/** 旧目录路径词法校验：非空字符串 + 绝对路径 + 无 NUL + resolve 后非文件系统根。
 *  不要求目录存在（会话库按路径字符串键组织，旧仓库移动后已不存在是常态）。 */
function validateOldPathInput(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiError(400, "invalid_old_path", "oldPath 必须是绝对目录路径");
  }
  if (!isAbsolute(raw)) {
    throw new ApiError(400, "invalid_old_path", `oldPath 必须是绝对路径：${raw}`);
  }
  if (raw.includes("\0")) {
    throw new ApiError(400, "invalid_old_path", "oldPath 不能包含 NUL 字节");
  }
  const resolved = resolve(raw);
  if (resolved === "/") {
    throw new ApiError(400, "invalid_old_path", "oldPath 不能是文件系统根");
  }
  return resolved;
}

/** 读 JSONL 首行 session header：{type:"session", id, cwd, ...}。
 *  首行缺失/非 JSON/非 session header 抛错（引擎同判定：Cannot rebind session）。 */
interface SessionHeaderLine {
  header: Record<string, unknown> & { type: "session"; id: string };
  rest: string;
}

function readHeaderLine(sessionFile: string): SessionHeaderLine {
  const content = readFileSync(sessionFile, "utf-8");
  const newline = content.indexOf("\n");
  const firstLine = newline === -1 ? content : content.slice(0, newline);
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    parsed = undefined;
  }
  const header = parsed as { type?: unknown; id?: unknown } | undefined;
  if (
    typeof header !== "object" ||
    header === null ||
    header.type !== "session" ||
    typeof header.id !== "string"
  ) {
    throw new Error(`会话文件首行不是 session header：${sessionFile}`);
  }
  return {
    header: header as SessionHeaderLine["header"],
    rest: newline === -1 ? "" : content.slice(newline + 1),
  };
}

/** 迁移 sidecars（引擎 moveSessionSidecars 同语义）：extensions 边车 JSON 与
 *  resident-blobs 目录，目标不存在才移；EXDEV（跨设备）退 recursive copy + rm。 */
function moveSessionSidecars(fromDir: string, toDir: string, sessionId: string): void {
  const encodedId = encodeURIComponent(sessionId);
  const extensionsDir = join(fromDir, "extensions");
  if (existsSync(extensionsDir)) {
    for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const from = join(extensionsDir, entry.name, `${encodedId}.json`);
      if (existsSync(from)) movePath(from, join(toDir, "extensions", entry.name, `${encodedId}.json`));
    }
  }
  const blobs = join(fromDir, "resident-blobs", sessionId);
  if (existsSync(blobs)) movePath(blobs, join(toDir, "resident-blobs", sessionId));
}

function movePath(from: string, to: string): void {
  if (existsSync(to)) return;
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** 单会话重绑（引擎 moveSessionFile 同语义）：header cwd 重写 + 临时文件 wx 独占 +
 *  sidecars 迁移 + rename 成目标 + 删源。source 已不在而目标在 → already_bound
 *  （幂等）；目标已存在而源还在 → conflict（引擎同错误形态）。 */
function rebindSessionFile(
  source: string,
  target: string,
  targetCwd: string,
): { disposition: "moved" | "already_bound" } {
  if (target !== source && !existsSync(source) && existsSync(target)) {
    return { disposition: "already_bound" };
  }
  const { header, rest } = readHeaderLine(source);
  if (target !== source && existsSync(target)) {
    throw new ApiError(409, "rebind_conflict", `目标项目已存在同名会话文件：${basename(target)}`);
  }
  const targetDir = dirname(target);
  mkdirSync(targetDir, { recursive: true });
  const temp = join(targetDir, `.${basename(source)}.rebind-${process.pid}.tmp`);
  rmSync(temp, { force: true });
  writeFileSync(temp, `${JSON.stringify({ ...header, cwd: targetCwd })}\n${rest}`, { flag: "wx" });
  if (target !== source) moveSessionSidecars(dirname(source), targetDir, header.id);
  renameSync(temp, target);
  if (target !== source) rmSync(source, { force: true });
  return { disposition: "moved" };
}

/** 目录内 .jsonl 文件计数（scan 响应用：与解析成功数的差 = 损坏/非会话文件数） */
function countJsonlFiles(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

export function createRebindRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const agentRoot = deps.agentDir ?? defaultAgentDir();
  const sessionsRoot = (projectOrPath: string) => join(agentRoot, "sessions", encodeCwdToSessionDirName(projectOrPath));

  // 扫描预览：旧目录 → 会话行清单（导入前用户确认用）。
  // 目录不存在/空 → sessions 空数组（不报错不崩：用户先见清单再决定导入）；
  // 损坏 JSONL（首行非 session header）不入清单但计入 totalFiles（差值即可见跳过数）。
  // alreadyBound = 目标项目编码目录已存在同名文件（含 oldPath 即当前项目的情形）。
  app.post("/api/sessions/rebind/scan", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = validateProjectInput(body.project);
    const oldPath = validateOldPathInput(body.oldPath);
    const oldDir = sessionsRoot(oldPath);
    const targetDir = sessionsRoot(project);
    const rows = existsSync(oldDir) ? await SessionManager.list(oldPath, oldDir) : [];
    const sessions = rows.map((row) => ({
      id: row.id,
      name: row.name ?? null,
      firstMessage: row.firstMessage,
      messageCount: row.messageCount,
      created: row.created instanceof Date ? row.created.toISOString() : String(row.created),
      modified: row.modified instanceof Date ? row.modified.toISOString() : String(row.modified),
      alreadyBound: existsSync(join(targetDir, basename(row.path))),
    }));
    return c.json({
      project,
      oldPath,
      sessions,
      totalFiles: countJsonlFiles(oldDir),
    });
  }));

  // 导入重绑：逐会话按引擎 --rebind 语义移动（header cwd 重写 + sidecars 迁移）。
  // 逐会话容错：找不到/损坏/冲突 → skipped 结构化报告，不炸整批；合法输入恒 200
  // （导入结果以响应报告为准，部分失败不是 HTTP 错误）。
  app.post("/api/sessions/rebind", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = validateProjectInput(body.project);
    const oldPath = validateOldPathInput(body.oldPath);
    if (!Array.isArray(body.sessionIds) || body.sessionIds.length === 0 || !body.sessionIds.every((id) => typeof id === "string" && id.length > 0)) {
      throw new ApiError(400, "invalid_session_ids", "sessionIds 必须是非空字符串 id 的非空数组");
    }
    const sessionIds = body.sessionIds as string[];
    const oldDir = sessionsRoot(oldPath);
    const targetDir = sessionsRoot(project);

    if (!existsSync(oldDir)) {
      throw new ApiError(400, "old_store_not_found", `旧目录会话库不存在：${oldPath}`);
    }
    const rows = await SessionManager.list(oldPath, oldDir);
    const byId = new Map(rows.map((row) => [row.id, row]));

    const imported: Array<{ id: string; path: string; disposition: "moved" | "already_bound" }> = [];
    const skipped: Array<{ id: string; reason: "not_found" | "corrupt_header" | "rebind_conflict"; message: string }> = [];
    for (const id of sessionIds) {
      const row = byId.get(id);
      if (!row) {
        // 旧目录找不到：先查目标项目库（文件名带时间戳前缀，按 header id 找）——
        // 命中即重复导入（幂等 already_bound），未命中才是真 not_found
        const targetHit = SessionManager.findById(project, id, targetDir);
        if (targetHit) {
          imported.push({ id, path: targetHit, disposition: "already_bound" });
        } else {
          skipped.push({ id, reason: "not_found", message: "旧目录会话库中不存在（可能已移动或损坏）" });
        }
        continue;
      }
      const source = row.path;
      const target = join(targetDir, basename(source));
      try {
        const result = rebindSessionFile(source, target, project);
        imported.push({ id, path: target, disposition: result.disposition });
      } catch (err) {
        if (err instanceof ApiError && err.code === "rebind_conflict") {
          skipped.push({ id, reason: "rebind_conflict", message: err.message });
        } else {
          skipped.push({
            id,
            reason: "corrupt_header",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return c.json({ project, oldPath, imported, skipped });
  }));

  return app;
}
