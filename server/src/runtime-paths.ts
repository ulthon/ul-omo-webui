import { basename, dirname, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 运行形态锚点（W6 todo 29 实测复核；2026-10-16 去 bun 化改写）。
 *
 * 三种运行形态：
 * - 源码形态：仓库内直接运行（开发/测试），锚点 = 各文件自身位置向上推导
 * - npm 安装形态：esbuild 单文件 dist/index.js 装进 node_modules，数据目录走平台惯例
 * - bun compile 编译形态（历史单二进制发行包，已退役但保持兼容）：
 *   import.meta.url 是嵌入虚拟 FS（/$bunfs/root），不可用作路径锚点
 */

/** 当前模块所在目录（跨运行时安全：node / bun / esbuild bundle 均为真实文件 URL） */
export function selfDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** 当前是否运行在 bun compile 单二进制产物中（历史发行形态，已退役）。 */
export function isCompiledBinary(): boolean {
  return import.meta.url.startsWith("file:///$bunfs/");
}

/**
 * 当前是否运行在 npm 安装形态（esbuild 打包的 dist/index.js 位于 node_modules 内的包目录下）。
 * 判定：从本文件向上找最近的 package.json，name 为 ul-omo-webui 且其父目录是 node_modules
 * （仓库源码形态的根 package.json 同名，但父目录是普通目录，不会误判）。
 */
export function isInstalledPackage(): boolean {
  if (isCompiledBinary()) return false;
  try {
    let dir = selfDir();
    for (;;) {
      const pkgJson = resolve(dir, "package.json");
      if (existsSync(pkgJson)) {
        const name = (JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: string }).name;
        return name === "ul-omo-webui" && basename(dirname(dir)) === "node_modules";
      }
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  } catch {
    return false;
  }
}

/** 发行包锚点目录：编译态 = 可执行文件所在目录；源码态 = 仓库根。 */
export function releaseRoot(): string {
  if (isCompiledBinary()) return dirname(process.execPath);
  return realpathSync(resolve(selfDir(), "..", ".."));
}
