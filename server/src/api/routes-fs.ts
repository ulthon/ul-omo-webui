// 文件浏览只读路由（todo 9）：列目录/读文件。
// 路径逃逸校验（计划 184 行硬条件）：resolve 后必须仍在项目目录内；
// 符号链接目标经 realpath 复核（paths.ts resolveInsideProject）。
import { readdirSync, statSync } from "node:fs";
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

export function createFsRoutes(deps: ApiDeps): Hono {
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
      .map((d) => ({
        name: (d as unknown as { name: string }).name,
        type: d.isDirectory() ? "directory" : d.isFile() ? "file" : d.isSymbolicLink() ? "symlink" : "other",
      }))
      .sort((a, b) => {
        const dirDelta = Number(b.type === "directory") - Number(a.type === "directory");
        return dirDelta !== 0 ? dirDelta : a.name.localeCompare(b.name);
      });
    return c.json({ project, path, entries });
  }));

  // 读文件（文本；2MB 截断；NUL 字节探测二进制不回传内容）
  app.get("/api/fs/file", route(async (c: Context) => {
    const project = validateProjectInput(c.req.query("project"));
    const { path, real } = resolveInsideProject(project, c.req.query("path"));
    if (!real) throw new ApiError(404, "not_found", `路径不存在：${path}`);
    let stat;
    try {
      stat = statSync(real);
    } catch {
      throw new ApiError(404, "not_found", `路径不存在：${path}`);
    }
    if (!stat.isFile()) {
      throw new ApiError(400, "not_a_file", `路径不是常规文件：${path}`);
    }
    const truncated = stat.size > FILE_MAX_BYTES;
    const buf = Bun.file(real);
    const slice = truncated ? await buf.slice(0, FILE_MAX_BYTES).arrayBuffer() : await buf.arrayBuffer();
    const bytes = new Uint8Array(slice);
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
      size: stat.size,
      truncated,
      binary,
      content: binary ? null : new TextDecoder().decode(bytes),
    });
  }));

  return app;
}
