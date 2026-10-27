// 文件浏览只读路由（todo 9）：列目录/读文件。
// 路径逃逸校验（计划 184 行硬条件）：resolve 后必须仍在项目目录内；
// 符号链接目标经 realpath 复核（paths.ts resolveInsideProject）。
// todo 7 追加目录浏览（/api/fs/browse）：同一两步校验模式。
// W5 todo 14：base 从 realpath(home) 放开到文件系统根 /（可注入替换 base 供测试），
// 非根目录列表头部合成 ".." 父目录项供树上行导航。
import { readdirSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { ApiError, route } from "./http";
import type { ApiDeps } from "./deps";
import { resolveInsideProject, validateProjectInput } from "./paths";

const FILE_MAX_BYTES = 2 * 1024 * 1024;

type DirentLike = {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

/** win32 盘根形态：D:\ 或 D:/（realpath 归一后为反斜杠形态） */
const WIN_DRIVE_ROOT = /^[A-Za-z]:[\\/]$/;

/** 盘符探测的最小 stat 面（statSync 结构兼容；单测可注入伪造盘） */
type DriveStat = (path: string) => { isDirectory(): boolean };

/**
 * win32 盘符枚举（A:-Z: 逐个 statSync 探测，无更优纯 Node 手段）。
 * stat 可注入（单测伪造盘）；不存在/无介质（ENOENT、EIO 等）一律跳过。
 */
export function listWinDrives(stat: DriveStat = statSync): Array<{ name: string; path: string; hidden: boolean }> {
  const out: Array<{ name: string; path: string; hidden: boolean }> = [];
  for (let code = 65; code <= 90; code++) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      if (stat(drive).isDirectory()) out.push({ name: drive, path: drive, hidden: false });
    } catch {
      // 无此盘 / 无介质：跳过
    }
  }
  return out;
}

/** fs 错误 → EACCES 标注（目录不可读时端点返回 200 + error 字段而非 500） */
export function fsErrorCode(err: unknown): "eacces" | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    if ((err as { code: unknown }).code === "EACCES") return "eacces";
  }
  return null;
}

export function createFsRoutes(deps: ApiDeps, browseHome?: string): Hono {
  const app = new Hono();

  // 列目录（单层，非递归）：dirs 优先 + 名称排序
  app.get("/api/fs/tree", route(async (c: Context) => {
    const project = validateProjectInput(c.req.query("project"));
    const { path, real } = resolveInsideProject(project, c.req.query("path") ?? "/");
    if (!real) throw new ApiError(404, "not_found", `路径不存在：${path}`);
    let stat;
    try {
      stat = statSync(real);
    } catch {
      throw new ApiError(404, "not_found", `路径不可访问：${path}`);
    }
    if (!stat.isDirectory()) {
      throw new ApiError(400, "not_a_directory", `路径不是目录：${path}`);
    }
    const dirents = readdirSync(real, { withFileTypes: true }) as unknown as DirentLike[];
    const entries = dirents
      .map((d) => {
        const name = (d as unknown as { name: string }).name;
        // 逐项 stat 补 size/mtime（epoch 毫秒）；目录 size 为 null，stat 失败（如断链）两字段均 null
        let size: number | null = null;
        let mtime: number | null = null;
        try {
          const st = statSync(join(real, name));
          size = st.isFile() ? st.size : null;
          mtime = st.mtimeMs;
        } catch {
          // 保留 null
        }
        const type = d.isDirectory() ? "directory" : d.isFile() ? "file" : d.isSymbolicLink() ? "symlink" : "other";
        return { name, type, size, mtime };
      })
      .sort((a, b) => {
        const dirDelta = Number(b.type === "directory") - Number(a.type === "directory");
        return dirDelta !== 0 ? dirDelta : a.name.localeCompare(b.name);
      });
    return c.json({ project, path, entries });
  }));

  // 读文件（文本；2MB 截断；NUL 字节探测二进制不回传内容）。
  // 任务 9：响应新增 mtimeNs（bigint statSync 纳秒十进制字符串——Number 会丢结
  // 1.7e18 量级纳秒值的低 11 位，必须 bigint 取值；作为保存前置校验期望值源），
  // 纯增量字段，既有字段与行为不变。
  app.get("/api/fs/file", route(async (c: Context) => {
    const project = validateProjectInput(c.req.query("project"));
    const { path, real } = resolveInsideProject(project, c.req.query("path"));
    if (!real) throw new ApiError(404, "not_found", `路径不存在：${path}`);
    let stat;
    try {
      stat = statSync(real, { bigint: true });
    } catch {
      throw new ApiError(404, "not_found", `路径不存在：${path}`);
    }
    if (!stat.isFile()) {
      throw new ApiError(400, "not_a_file", `路径不是常规文件：${path}`);
    }
    const truncated = Number(stat.size) > FILE_MAX_BYTES;
    // 按需读（截断时只读前 FILE_MAX_BYTES 字节，不整载大文件）
    const readLen = truncated ? FILE_MAX_BYTES : Number(stat.size);
    const bytes = new Uint8Array(readLen);
    if (readLen > 0) {
      const fh = await open(real, "r");
      try {
        await fh.read(bytes, 0, readLen, 0);
      } finally {
        await fh.close();
      }
    }
    let binary = false;
    for (let i = 0; i < Math.min(bytes.length, 8000); i++) {
      if (bytes[i] === 0) {
        binary = true;
        break;
      }
    }
    return c.json({
      project,
      path,
      size: Number(stat.size),
      mtimeNs: stat.mtimeNs.toString(),
      truncated,
      binary,
      content: binary ? null : new TextDecoder().decode(bytes),
    });
  }));

  // 目录浏览（todo 7，W5 todo 14 放开）：目录树与路径补全共用。单层列出子目录（仅目录，不递归）。
  // path 缺省 = "/"（文件系统根）；base = realpath(注入值 ?? "/")（base 本身是符号链接时以 realpath 为 base，
  // 测试经工厂第二参注入替换 base）。安全边界照抄 paths.ts resolveInsideProject 两步模式：
  // 1. resolve 后必须 base 前缀包含（出界 → 403；与 fs/tree 的项目内语义不同，
  //    此处 path 接受绝对路径——补全回填的 entry.path 直接传回，不注入 "./" 中和前导 /）；
  //    base="/" 时前缀即 "/" 本身：直接写 base + "/" 会得到 "//" 使 startsWith 恒假（除根外全 403），
  //    故根特例 prefix = "/"。
  // 2. 单次 realpathSync 复核（一次调用解析全部符号链接，出界 → 403）。
  // win32 分支（见路由体首段）：缺省根为盘符列表，盘内不再做前缀越界检查（每个盘各自成根，
  // 与 POSIX base="/" 的"全文件系统即边界"语义等价）；盘根 ".." 回盘符列表。
  // 目录不可读（EACCES）→ 200 {entries:[], error:"eacces"} 而非 500；
  // 单 entry 失败跳过：仅按 dirent 类型收录目录，悬空/不可 stat 条目天然不入选；
  // 非根目录列表头部合成 ".."（path = 父目录），根目录列表不含。
  app.get("/api/fs/browse", route(async (c: Context) => {
    const raw = c.req.query("path") ?? "";
    if (raw.includes("\0")) throw new ApiError(400, "invalid_path", "path 不能包含 NUL 字节");
    if (raw.length > 4096) throw new ApiError(400, "invalid_path", "path 过长");

    // win32 缺省根（未注入 browseHome）：POSIX 单根 "/" 对应 win32 的"盘符列表"。
    // 越界检查跳过——POSIX base="/" 的前缀检查本就覆盖全文件系统，win32 语义等价
    // （每个盘各自成根，不存在统一 prefix；realpath 结果必然仍在某个盘内）。
    if (process.platform === "win32" && browseHome === undefined) {
      if (raw === "" || raw === "/") return c.json({ entries: listWinDrives() });
      const target = resolve(raw);
      let real: string;
      try {
        real = realpathSync(target);
      } catch (err) {
        if (fsErrorCode(err)) return c.json({ entries: [], error: "eacces" });
        throw new ApiError(404, "not_found", `路径不存在：${target}`);
      }
      let dirents: DirentLike[];
      try {
        if (!statSync(real).isDirectory()) {
          throw new ApiError(400, "not_a_directory", `路径不是目录：${target}`);
        }
        dirents = readdirSync(real, { withFileTypes: true }) as unknown as DirentLike[];
      } catch (err) {
        if (err instanceof ApiError) throw err;
        if (fsErrorCode(err)) return c.json({ entries: [], error: "eacces" });
        throw err;
      }
      const entries = dirents
        .filter((d) => d.isDirectory())
        .map((d) => {
          const name = (d as unknown as { name: string }).name;
          return { name, path: join(real, name), hidden: name.startsWith(".") };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      // 盘根的 ".." 回到盘符列表（"/"），盘内其余层级 ".." = 父目录
      entries.unshift({
        name: "..",
        path: WIN_DRIVE_ROOT.test(real) ? "/" : dirname(real),
        hidden: false,
      });
      return c.json({ entries });
    }

    const base = realpathSync(browseHome ?? "/");
    const prefix = base === "/" ? "/" : base + "/";
    const target = resolve(base, raw);
    if (target !== base && !target.startsWith(prefix)) {
      throw new ApiError(403, "path_escape", `路径逃逸被拒绝：${raw}`);
    }
    let real: string;
    try {
      real = realpathSync(target);
    } catch (err) {
      if (fsErrorCode(err)) return c.json({ entries: [], error: "eacces" });
      throw new ApiError(404, "not_found", `路径不存在：${target}`);
    }
    if (real !== base && !real.startsWith(prefix)) {
      throw new ApiError(403, "path_escape", `符号链接逃逸被拒绝：${raw}`);
    }
    try {
      if (!statSync(real).isDirectory()) {
        throw new ApiError(400, "not_a_directory", `路径不是目录：${target}`);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (fsErrorCode(err)) return c.json({ entries: [], error: "eacces" });
      throw new ApiError(404, "not_found", `路径不可访问：${target}`);
    }
    let dirents: DirentLike[];
    try {
      dirents = readdirSync(real, { withFileTypes: true }) as unknown as DirentLike[];
    } catch (err) {
      if (fsErrorCode(err)) return c.json({ entries: [], error: "eacces" });
      throw err;
    }
    const entries = dirents
      .filter((d) => d.isDirectory())
      .map((d) => {
        const name = (d as unknown as { name: string }).name;
        return { name, path: join(real, name), hidden: name.startsWith(".") };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    // 非根目录：头部合成 ".." 父目录项（join 规范化，real="/data" → path="/"），根目录无
    if (real !== base) {
      entries.unshift({ name: "..", path: join(real, ".."), hidden: false });
    }
    return c.json({ entries });
  }));

  return app;
}
