import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";

/**
 * 运行形态锚点（W6 todo 29 实测复核）。
 *
 * bun compile 产物中 import.meta.dir 是嵌入虚拟 FS 根（"/$bunfs/root"），
 * 并非 W0 记录的"可执行文件所在目录"——路径锚点一律经本模块换算：
 * - 源码形态：releaseRoot() = 仓库根（server/src 上两级，realpath 解析符号链接）
 * - 编译形态：releaseRoot() = 可执行文件所在目录（发行包根，含 engine/ 与 data/）
 */

/** 当前是否运行在 bun compile 单二进制产物中。 */
export function isCompiledBinary(): boolean {
  return import.meta.dir.startsWith("/$bunfs/");
}

/** 发行包锚点目录：编译态 = 可执行文件所在目录；源码态 = 仓库根。 */
export function releaseRoot(): string {
  if (isCompiledBinary()) return dirname(process.execPath);
  return realpathSync(resolve(import.meta.dir, "..", ".."));
}
