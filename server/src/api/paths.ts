// 路径校验（todo 9 验收硬条件）：项目路径与项目内子路径。
// 规则（计划 185 行）：resolve 后必须仍在允许范围内；覆盖 ../ 逃逸、绝对路径注入、
// 符号链接逃逸（realpath 复核）。
// Windows 支持：绝对性判定用 node:path isAbsolute（平台正确——win32 接受 D:\ 与 \\\\UNC，
// posix 只认 / 开头，跨平台伪绝对形态在 Linux 上仍被拒）；包含性判定用平台分隔符，
// win32 下大小写不敏感（用户输入大小写与 realpath 规范形态不一致时不得误判逃逸）。
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { ApiError } from "./http";

const IS_WIN = process.platform === "win32";

/**
 * 包含性判定：target 等于 base 或位于 base 之下（含盘根 base：D:\ 本身以分隔符结尾不再补）。
 * win32 大小写不敏感；posix 精确匹配。base="/" 与盘根 "D:\\" 均为天然前缀。
 */
export function insideBase(base: string, target: string): boolean {
  if (target === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return IS_WIN ? target.toLowerCase().startsWith(prefix.toLowerCase()) : target.startsWith(prefix);
}

/**
 * 校验用户提供的项目目录：必须是存在的绝对路径目录，返回 realpath 规范形态。
 * POST /api/projects、全部 ?project= 参数共用。
 */
export function validateProjectInput(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiError(400, "invalid_project", "project 必须是绝对目录路径");
  }
  if (!isAbsolute(raw)) {
    throw new ApiError(400, "invalid_project", `project 必须是绝对路径：${raw}`);
  }
  let real: string;
  try {
    real = realpathSync(raw);
  } catch {
    throw new ApiError(400, "project_not_found", `项目目录不存在：${raw}`);
  }
  if (!statSync(real).isDirectory()) {
    throw new ApiError(400, "invalid_project", `项目路径不是目录：${raw}`);
  }
  return real;
}

/**
 * create:true 分支（docs08-r3 任务 20"新建并添加"）：路径不存在时建目录再注册。
 * 安全口径（与 browse/validateProjectInput 同源，不做软链接解析放宽）：
 * 1. 形状校验（绝对路径、无 NUL、≤4096——对齐 routes-fs browse 口径）后 resolve 规范化；
 * 2. lstat 目标：存在（含悬空符号链接——lstat 不跟随，不算不存在）→ 交回
 *    validateProjectInput 走原口径（幂等注册/非目录/悬空链接 400）；
 * 3. 不存在 → 上溯最近存在祖先：必须是目录且可写（accessSync W_OK，不可写 403）；
 * 4. mkdirSync recursive（即 mkdir -p：从最近祖先起补建余下链），失败按错误码映射；
 * 5. 建成后 validateProjectInput 复核并注册（realpath 归一，绝不放宽）。
 */
export function createProjectInput(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiError(400, "invalid_project", "project 必须是绝对目录路径");
  }
  if (!isAbsolute(raw)) {
    throw new ApiError(400, "invalid_project", `project 必须是绝对路径：${raw}`);
  }
  if (raw.includes("\0")) {
    throw new ApiError(400, "invalid_project", "project 不能包含 NUL 字节");
  }
  if (raw.length > 4096) {
    throw new ApiError(400, "invalid_project", "project 过长");
  }
  const target = resolve(raw);
  let exists = true;
  try {
    lstatSync(target);
  } catch (err) {
    // ENOENT=不存在；ENOTDIR=中段是文件（目标同样不可达）——都走 mkdir 探测流程，
    // 由祖先探测给出更可操作的"父级不是目录"；其余 stat 错误交回原校验口径
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") exists = false;
  }
  if (exists) return validateProjectInput(target);

  let parent = dirname(target);
  for (;;) {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(parent);
    } catch (err) {
      // 上溯到 dirname 不再变化（POSIX 根 "/" 或 win32 盘根 "D:\"）仍不可达即放弃：
      // 原判据 parent !== "/" 在 win32 缺失盘符（如 E:\xx 而 E 盘不存在）下会死循环
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && dirname(parent) !== parent) {
        parent = dirname(parent);
        continue;
      }
      throw new ApiError(400, "mkdir_failed", `无法创建目录（父级探测失败）：${raw}`);
    }
    if (!stat.isDirectory()) {
      throw new ApiError(400, "mkdir_failed", `父级不是目录，无法创建：${raw}`);
    }
    break;
  }
  try {
    accessSync(parent, constants.W_OK);
  } catch {
    throw new ApiError(403, "mkdir_forbidden", `父级目录不可写：${parent}`);
  }
  try {
    mkdirSync(target, { recursive: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(400, "mkdir_failed", `创建目录失败：${raw}（${reason}）`);
  }
  return validateProjectInput(target);
}

/**
 * 校验项目内子路径（/api/fs 的 path 参数）：
 * 1. 以项目根为基准 resolve（前导 "/" 被中和成项目内路径，绝对路径注入无法逃出项目）；
 * 2. 规范化结果必须在项目根内，否则 403 path_escape（../ 逃逸）；
 * 3. 目标真实存在时再做 realpath 包含性复核（符号链接指向项目外 → 403）。
 * 返回 {path: 规范化路径, real: 真实路径（目标不存在时为 null）}。
 */
export function resolveInsideProject(
  projectRoot: string,
  subPath: unknown,
): { path: string; real: string | null } {
  if (typeof subPath !== "string") {
    throw new ApiError(400, "invalid_path", "path 必须是字符串");
  }
  // "./" 前缀把绝对路径注入（/etc/passwd）中和为项目内相对路径
  const target = resolve(projectRoot, `./${subPath}`);
  if (!insideBase(projectRoot, target)) {
    throw new ApiError(403, "path_escape", `路径逃逸被拒绝：${subPath}`);
  }
  let real: string | null = null;
  try {
    real = realpathSync(target);
  } catch {
    return { path: target, real: null };
  }
  if (!insideBase(projectRoot, real)) {
    throw new ApiError(403, "path_escape", `符号链接逃逸被拒绝：${subPath}`);
  }
  return { path: target, real };
}
