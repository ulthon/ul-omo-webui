// 文件写操作路由（builtin-file-management 任务 4）：新建文件、建目录、重命名/移动、删除。
// 写域 = query project（validateProjectInput 归一后的项目根）：全部 path/from/to 经
// resolveInsideProjectForWrite 四层守卫（词法包含 / 逐组件 lstat 走查 / 最终段名白名单，
// 任务 3），成功路径事后 assertRealpathInside 回查，出界即回滚（TOCTOU 检测-回滚，
// 非物理归零）。
// 引擎并发护栏：peekActiveSessionPaths（null=引擎未就绪、[]=空闲、非空=回合进行中会话
// 路径，见 engine-runtime）——DELETE 为项目级粗护栏（非空即拒），PATCH 为 from 路径
// 命中护栏（精确或祖先目录，防回合中会话路径漂移）；每次请求重新 peek，不缓存。
// 删除为纯硬删（用户拍板，无回收站/trash 参数）；rename 前必先 lstat 目标（POSIX 与
// win32 都会静默替换已存在目标）；EXDEV 降级 fs.cp（dereference:false，符号链接按链接
// 复制，绝不用 copyFile——它跟随链接）+ 文件数/总字节对账，对账通过才删源，任一不符
// rm 目标 + 500 copy_failed。
import { cp, lstat, mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Hono, type Context } from "hono";
import { ApiError, parseJsonBody, route } from "./http";
import type { ApiDeps } from "./deps";
import { assertRealpathInside, resolveInsideProjectForWrite, validateProjectInput } from "./paths";

/** Node 错误码提取（非系统错误返回 undefined） */
function errnoOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** 写操作错误映射：ApiError 原样放行；ENOSPC → 507；其余交 route() 兜底 */
function toWriteError(err: unknown): unknown {
  if (err instanceof ApiError) return err;
  if (errnoOf(err) === "ENOSPC") {
    return new ApiError(507, "insufficient_storage", "存储空间不足");
  }
  return err;
}

type EntryKind = "file" | "dir" | "symlink" | "other";

function kindOf(st: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): EntryKind {
  if (st.isDirectory()) return "dir";
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFile()) return "file";
  return "other";
}

/**
 * 目录树对账快照：目录/文件/符号链接计数 + 非目录条目的 lstat 字节合计
 * （目录 inode 大小随文件系统而异，不参与对账；符号链接按 lstat 尺寸即目标串长度，
 * 复制前后一致）。单文件/单链接入参同样适用（EXDEV 对账的文件路径）。
 */
async function countTree(root: string): Promise<{
  dirs: number;
  files: number;
  symlinks: number;
  bytes: number;
}> {
  const st = await lstat(root);
  const kind = kindOf(st);
  if (kind === "symlink") return { dirs: 0, files: 0, symlinks: 1, bytes: Number(st.size) };
  if (kind !== "dir") return { dirs: 0, files: 1, symlinks: 0, bytes: Number(st.size) };
  const acc = { dirs: 1, files: 0, symlinks: 0, bytes: 0 };
  const walk = async (dir: string): Promise<void> => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      const s = await lstat(p);
      const k = kindOf(s);
      if (k === "dir") {
        acc.dirs++;
        await walk(p);
      } else if (k === "symlink") {
        acc.symlinks++;
        acc.bytes += Number(s.size);
      } else if (k === "file") {
        acc.files++;
        acc.bytes += Number(s.size);
      }
    }
  };
  await walk(root);
  return acc;
}

/** conflict:"rename" 候选名：basename 剥扩展 + " (n)" + 扩展（n 从 1 起，封顶 99） */
function renamedCandidate(toPath: string, n: number): string {
  const name = basename(toPath);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  return join(dirname(toPath), `${stem} (${n})${ext}`);
}

/** 首个空闲的重命名候选（lstat ENOENT 即空闲）；1-99 全占用 → 409 target_exists */
async function pickFreeTarget(toPath: string): Promise<string> {
  for (let n = 1; n <= 99; n++) {
    const cand = renamedCandidate(toPath, n);
    try {
      await lstat(cand);
    } catch (err) {
      if (errnoOf(err) === "ENOENT") return cand;
      throw err;
    }
  }
  throw new ApiError(409, "target_exists", `冲突重命名 1-99 序号均被占用：${toPath}`);
}

/** 写入/移动成功后回查：出界（或 realpath 失败——无法证明包含性）即回滚目标并 403 */
async function postCheckOrRollback(project: string, finalPath: string): Promise<void> {
  const check = assertRealpathInside(project, finalPath);
  if (!check.ok) {
    await rm(finalPath, { recursive: true, force: true });
    throw new ApiError(403, "path_escape", `写入后回查出界，已回滚：${finalPath}`);
  }
}

/**
 * EXDEV 降级复制：fs.cp（dereference:false——符号链接按链接复制，禁用 copyFile）→
 * 文件数/总字节对账 → 对账通过才 rm 源；任一不符 rm 目标 + 500 copy_failed。
 */
async function copyAcrossDevices(src: string, dst: string): Promise<void> {
  try {
    await cp(src, dst, { recursive: true, dereference: false });
  } catch (err) {
    throw toWriteError(err);
  }
  const before = await countTree(src);
  const after = await countTree(dst);
  if (
    before.dirs !== after.dirs ||
    before.files !== after.files ||
    before.symlinks !== after.symlinks ||
    before.bytes !== after.bytes
  ) {
    await rm(dst, { recursive: true, force: true });
    throw new ApiError(
      500,
      "copy_failed",
      `跨设备复制对账失败（源 ${before.files} 文件/${before.bytes} 字节，` +
        `目标 ${after.files} 文件/${after.bytes} 字节），已回滚目标`,
    );
  }
  await rm(src, { recursive: true, force: true });
}

export function createFsWriteRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // 新建文件：父目录走查 + 最终段名白名单（守卫内）+ open(wx) 内核级拒预置/悬空链接；
  // EEXIST → 409 exists；成功 201 {path,size,mtimeNs}（bigint 纳秒字符串化）。
  app.post("/api/fs/file", route(async (c: Context) => {
    const project = validateProjectInput(c.req.query("project"));
    const body = await parseJsonBody(c);
    const content = body.content;
    if (content !== undefined && typeof content !== "string") {
      throw new ApiError(400, "invalid_request", "content 必须是字符串");
    }
    const { path: target, existingAncestor } = resolveInsideProjectForWrite(project, body.path);
    if (existingAncestor !== dirname(target)) {
      throw new ApiError(404, "not_found", `父目录不存在：${dirname(target)}`);
    }
    let fh: FileHandle | null = null;
    try {
      fh = await open(target, "wx");
      if (content) await fh.writeFile(content, { encoding: "utf8" });
    } catch (err) {
      if (errnoOf(err) === "EEXIST") throw new ApiError(409, "exists", `目标已存在：${target}`);
      // 写入中途失败（ENOSPC 等）：清理半成品再映射
      await rm(target, { force: true }).catch(() => {});
      throw toWriteError(err);
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    await postCheckOrRollback(project, target);
    const st = await stat(target, { bigint: true });
    return c.json(
      { path: target, size: Number(st.size), mtimeNs: st.mtimeNs.toString() },
      201,
    );
  }));

  // 建目录：parents 逐层走查后逐层补建（并发下别处已建的中间层为目录则续走）；
  // 最终层 EEXIST → 409 exists（不做 mkdir -p 幂等放行）。
  app.post("/api/fs/dir", route(async (c: Context) => {
    const project = validateProjectInput(c.req.query("project"));
    const body = await parseJsonBody(c);
    const parents = body.parents;
    if (parents !== undefined && typeof parents !== "boolean") {
      throw new ApiError(400, "invalid_request", "parents 必须是布尔值");
    }
    const { path: target, existingAncestor } = resolveInsideProjectForWrite(project, body.path);
    const comps = relative(project, target).split(sep);
    const ancDepth = existingAncestor === project ? 0 : relative(project, existingAncestor).split(sep).length;
    if (!parents && ancDepth < comps.length - 1) {
      throw new ApiError(404, "not_found", `父目录不存在：${dirname(target)}（需 parents:true 逐层补建）`);
    }
    let cur = existingAncestor;
    for (let i = ancDepth; i < comps.length - 1; i++) {
      cur = join(cur, comps[i]);
      try {
        await mkdir(cur);
      } catch (err) {
        if (errnoOf(err) !== "EEXIST") throw toWriteError(err);
        const st = await lstat(cur);
        if (!st.isDirectory()) {
          throw new ApiError(400, "not_a_directory", `中间路径不是目录：${cur}`);
        }
      }
    }
    try {
      await mkdir(target);
    } catch (err) {
      if (errnoOf(err) === "EEXIST") throw new ApiError(409, "exists", `目录已存在：${target}`);
      throw toWriteError(err);
    }
    await postCheckOrRollback(project, target);
    return c.json({ path: target }, 201);
  }));

  // 重命名/移动：from/to 双走写守卫；from 命中进行中会话路径（精确或祖先目录）→
  // 409 engine_busy；目标存在默认 409 target_exists，overwrite:true 仅 file→file /
  // dir→dir 同型（否则 400 kind_mismatch），conflict:"rename" 生成 " (n)" 序列名封顶
  // 99；rename 前必 lstat 目标（绝不裸 rename 到已存在目标）；EXDEV 降级 cp+对账。
  app.patch("/api/fs/entry", route(async (c: Context) => {
    const project = validateProjectInput(c.req.query("project"));
    const body = await parseJsonBody(c);
    const overwrite = body.overwrite;
    const conflict = body.conflict;
    if (overwrite !== undefined && typeof overwrite !== "boolean") {
      throw new ApiError(400, "invalid_request", "overwrite 必须是布尔值");
    }
    if (conflict !== undefined && conflict !== "rename") {
      throw new ApiError(400, "invalid_request", 'conflict 仅支持 "rename"');
    }
    if (overwrite === true && conflict !== undefined) {
      throw new ApiError(400, "invalid_request", "overwrite 与 conflict 不能同时指定");
    }

    const fromR = resolveInsideProjectForWrite(project, body.from);
    const toR = resolveInsideProjectForWrite(project, body.to);
    if (toR.existingAncestor !== dirname(toR.path)) {
      throw new ApiError(404, "not_found", `目标父目录不存在：${dirname(toR.path)}`);
    }
    if (overwrite === true && fromR.path === toR.path) {
      // 自覆盖先删后挪会把源一并删掉再 rename 落空，属数据毁损陷阱，显式拒之
      throw new ApiError(400, "invalid_request", "源与目标相同，无需移动");
    }
    let fromSt;
    try {
      fromSt = await lstat(fromR.path);
    } catch {
      throw new ApiError(404, "not_found", `源不存在：${fromR.path}`);
    }
    const fromKind = kindOf(fromSt);

    // 引擎并发护栏（逐请求重查）：from 命中进行中会话路径（精确或祖先目录）即拒
    const active = await deps.engines.peekActiveSessionPaths(project);
    if (active) {
      for (const sessionPath of active) {
        if (sessionPath === fromR.path || sessionPath.startsWith(fromR.path + sep)) {
          throw new ApiError(409, "engine_busy", "引擎回合进行中，该路径受保护，稍后再试");
        }
      }
    }

    let finalTo = toR.path;
    let toKind: EntryKind | null = null;
    try {
      toKind = kindOf(await lstat(toR.path));
    } catch (err) {
      if (errnoOf(err) !== "ENOENT") throw toWriteError(err);
      toKind = null;
    }

    if (toKind !== null) {
      if (conflict === "rename") {
        finalTo = await pickFreeTarget(toR.path);
      } else if (overwrite === true) {
        if (
          !((fromKind === "file" && toKind === "file") || (fromKind === "dir" && toKind === "dir"))
        ) {
          throw new ApiError(
            400,
            "kind_mismatch",
            `overwrite 仅支持同型覆盖（file→file / dir→dir）：${fromKind}→${toKind}`,
          );
        }
        // 先删后挪：rename 对已存在目标的静默替换在 POSIX/win32 都不可信
        if (toKind === "dir") await rm(toR.path, { recursive: true, force: true });
        else await unlink(toR.path);
      } else {
        throw new ApiError(
          409,
          "target_exists",
          `目标已存在：${toR.path}（overwrite 覆盖 / conflict:"rename" 保留两者）`,
        );
      }
    }

    try {
      await rename(fromR.path, finalTo);
    } catch (err) {
      if (errnoOf(err) === "EXDEV") {
        await copyAcrossDevices(fromR.path, finalTo);
      } else if (errnoOf(err) === "EINVAL") {
        // POSIX rename(2)：目录移入自身子目录
        throw new ApiError(400, "invalid_request", "不能把目录移动到自身内部");
      } else {
        throw toWriteError(err);
      }
    }
    await postCheckOrRollback(project, finalTo);
    return c.json({ ok: true, path: finalTo });
  }));

  // 删除：纯硬删（无 trash 参数，用户拍板）。引擎忙粗护栏（peek 非空即拒，防回合中
  // 会话路径漂移）；项目根本身不可删；lstat 定型——目录 rm 递归（不穿越链接），
  // 文件/符号链接 unlink（只删条目本体）。
  app.delete("/api/fs/entry", route(async (c: Context) => {
    const project = validateProjectInput(c.req.query("project"));
    const raw = c.req.query("path");
    if (raw === undefined) {
      throw new ApiError(400, "invalid_path", "path 必填");
    }
    const active = await deps.engines.peekActiveSessionPaths(project);
    if (active && active.length > 0) {
      throw new ApiError(409, "engine_busy", "引擎正在此项目工作，稍后再试");
    }
    // 根不可删先于守卫的退化输入拦截：""/"." 等直指项目根的形态归本错误码
    // （守卫对同输入给 invalid_path，根语义由路由层把守——任务 3 契约）
    if (resolve(project, `./${raw}`) === project) {
      throw new ApiError(400, "root_not_deletable", "项目根本身不可删除");
    }
    const { path: target } = resolveInsideProjectForWrite(project, raw);
    let st;
    try {
      st = await lstat(target);
    } catch {
      throw new ApiError(404, "not_found", `路径不存在：${target}`);
    }
    if (st.isDirectory()) {
      await rm(target, { recursive: true, force: true });
    } else {
      await unlink(target);
    }
    return c.json({ ok: true });
  }));

  return app;
}
