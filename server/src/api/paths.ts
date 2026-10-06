// 路径校验（todo 9 验收硬条件）：项目路径与项目内子路径。
// 规则（计划 185 行）：resolve 后必须仍在允许范围内；覆盖 ../ 逃逸、绝对路径注入、
// 符号链接逃逸（realpath 复核）。
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ApiError } from "./http";

/**
 * 校验用户提供的项目目录：必须是存在的绝对路径目录，返回 realpath 规范形态。
 * POST /api/projects、全部 ?project= 参数共用。
 */
export function validateProjectInput(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiError(400, "invalid_project", "project 必须是绝对目录路径");
  }
  if (!raw.startsWith("/")) {
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
  if (target !== projectRoot && !target.startsWith(projectRoot + "/")) {
    throw new ApiError(403, "path_escape", `路径逃逸被拒绝：${subPath}`);
  }
  let real: string | null = null;
  try {
    real = realpathSync(target);
  } catch {
    return { path: target, real: null };
  }
  if (real !== projectRoot && !real.startsWith(projectRoot + "/")) {
    throw new ApiError(403, "path_escape", `符号链接逃逸被拒绝：${subPath}`);
  }
  return { path: target, real };
}
