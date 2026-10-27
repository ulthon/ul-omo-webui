// 路径校验（todo 9 验收硬条件）：项目路径与项目内子路径。
// 规则（计划 185 行）：resolve 后必须仍在允许范围内；覆盖 ../ 逃逸、绝对路径注入、
// 符号链接逃逸（realpath 复核）。
// Windows 支持：绝对性判定用 node:path isAbsolute（平台正确——win32 接受 D:\ 与 \\\\UNC，
// posix 只认 / 开头，跨平台伪绝对形态在 Linux 上仍被拒）；包含性判定用平台分隔符，
// win32 下大小写不敏感（用户输入大小写与 realpath 规范形态不一致时不得误判逃逸）。
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

// ------------------------- 写路径四层守卫（builtin-file-management 任务 3） -------------------------

/** win32 文件名保留字符（NTFS/FAT 任意位置禁止）：validateAttachmentName 口径之上的显式扩展 */
export const WIN32_RESERVED_NAME_CHARS = '<>:"|?*';

/**
 * 最终段名白名单：口径同 attachments.validateAttachmentName（纯文件名——拒路径分隔符
 * 与含 ".."），另显式拒绝 win32 保留字符。win32 设备名（CON/NUL/COM1…）与结尾点/空格
 * 等平台规则未纳入本层（全量验收以 Windows e2e 为准，本仓 CI 只验 mock 级形态）。
 */
function assertFinalSegmentName(name: string): void {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new ApiError(400, "invalid_name", "name 只能是纯文件名（不得含路径分隔符或 ..）");
  }
  for (const ch of WIN32_RESERVED_NAME_CHARS) {
    if (name.includes(ch)) {
      throw new ApiError(400, "invalid_name", `name 含 win32 保留字符 ${ch}：${name}`);
    }
  }
}

/**
 * 写路径守卫：写操作（新建/上传/重命名/移动/删除）的项目内子路径四层防线。
 * 与读面 resolveInsideProject 的差别：写面按“从项目根逐级下钻”语义走查每个中间
 * 目录组件——Node 无 openat/*at 族，逐组件 lstat 是其最接近的纯 Node 等价物；
 * 并返回最深已存在祖先供新建类操作逐级补建。
 *
 * 第 0 层 输入形状：字符串、无 NUL、≤4096（对齐 routes-fs browse 口径）；按分隔符
 *   逐段拒 ".."——作为完整段出现即视为逃逸尝试，不做 resolve 中和放行；posix 仅
 *   "/" 为分隔符，win32 的 "/" 与 "\\" 都是（resolve 同样按两者切分），故 win32
 *   混合分隔符形态也必须按段拦下。
 * 第 1 层 词法包含：resolve(projectRoot, "./"+subPath) 后 insideBase 判定（复用读面
 *   口径，win32 大小写不敏感），出界 403 path_escape；"./" 前缀把绝对路径注入中和
 *   为项目内相对路径。
 * 第 2 层 逐组件 lstat 走查：项目根起每个中间目录组件——符号链接（含悬空）一律
 *   403 path_escape（链接目标可在校验后、写入前被替换，无法静态证明安全）；存在
 *   但非目录 → 400 not_a_directory；ENOENT → 停止下钻，记录最深已存在祖先
 *   existingAncestor。每次调用重新走查、不做任何缓存：目录符号链接可在两次请求
 *   之间被替换，缓存会把已劫持路径误判为安全。
 * 第 3 层 wx/O_EXCL 创建原语属路由层职责，本文件不涉及；不得向 open 传数值
 *   O_NOFOLLOW——win32 会静默丢弃不识别的 open 标志，防护形同虚设。
 * 第 4 层 事后回查 assertRealpathInside：调用方在写入完成后复核，失败即回滚。
 *
 * 错误以 ApiError 抛出（与本文件既有口径一致，路由层统一映射 HTTP）；最终段名白名单
 * 见 assertFinalSegmentName。
 */
export function resolveInsideProjectForWrite(
  projectRoot: string,
  subPath: unknown,
): { path: string; existingAncestor: string } {
  // ---- 第 0 层：输入形状 ----
  if (typeof subPath !== "string") {
    throw new ApiError(400, "invalid_path", "path 必须是字符串");
  }
  if (subPath.includes("\0")) {
    throw new ApiError(400, "invalid_path", "path 不能包含 NUL 字节");
  }
  if (subPath.length > 4096) {
    throw new ApiError(400, "invalid_path", "path 过长");
  }
  const rawSegments = IS_WIN ? subPath.split(/[\\/]+/) : subPath.split(sep);
  if (rawSegments.includes("..")) {
    throw new ApiError(403, "path_escape", `路径逃逸被拒绝：${subPath}`);
  }

  // ---- 第 1 层：词法包含（"./" 前缀中和绝对路径注入，同读面） ----
  const target = resolve(projectRoot, `./${subPath}`);
  if (!insideBase(projectRoot, target)) {
    throw new ApiError(403, "path_escape", `路径逃逸被拒绝：${subPath}`);
  }
  // 写守卫只面向具体条目：目标退化为项目根本身（subPath 为 ""/"."/"./" 等）即拒绝
  const relativePath = relative(projectRoot, target);
  if (relativePath.length === 0) {
    throw new ApiError(400, "invalid_path", "path 不能指向项目根本身");
  }
  const components = relativePath.split(sep);
  // 最终段名取 resolve 归一后的实际条目名（"." 段已被中和，不存在绕过白名单的形态）
  assertFinalSegmentName(components[components.length - 1]);

  // ---- 第 2 层：逐组件 lstat 走查（仅中间目录组件；最终段由第 3 层创建原语
  // 与第 4 层回查负责，本层不 lstat 它） ----
  let existingAncestor = projectRoot;
  let cur = projectRoot;
  for (let i = 0; i < components.length - 1; i++) {
    cur = join(cur, components[i]);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(cur);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT=组件缺失：下钻停止，existingAncestor 停留在上一层（新建类操作
      // 在其下逐级补建）；后续组件在缺失目录之下必然也不存在，无需再查
      if (code === "ENOENT") break;
      // ENOTDIR=祖先链中段是非目录（并发删除等竞态下 lstat 子路径的直接产物）
      if (code === "ENOTDIR") {
        throw new ApiError(400, "not_a_directory", `中间路径不是目录：${cur}`);
      }
      // 其余（EACCES 等）：包含性无法证明，宁拒勿放
      throw new ApiError(403, "path_escape", `路径包含性无法验证：${cur}`);
    }
    if (st.isSymbolicLink()) {
      // lstat 不跟随，悬空链接同样命中；不放宽到“链接目标仍在项目内”——
      // 目标可在本调用返回后、真正写入前被替换
      throw new ApiError(403, "path_escape", `中间目录符号链接被拒绝：${cur}`);
    }
    if (!st.isDirectory()) {
      throw new ApiError(400, "not_a_directory", `中间路径不是目录：${cur}`);
    }
    existingAncestor = cur;
  }
  return { path: target, existingAncestor };
}

/**
 * 第 4 层事后回查（TOCTOU 收口）：写入/移动完成后复核最终路径的 realpath 仍在
 * 项目内。返回纯数据信号（不含 HTTP 层）：ok:false 时调用方负责回滚（unlink/rm）
 * 并映射 403。realpath 失败（条目已被并发删除/替换）同样不放行——无法证明包含性
 * 即视为失败；项目内符号链接指向项目外时 realpath 归一后出界，同样失败。
 */
export function assertRealpathInside(
  projectRoot: string,
  finalPath: string,
): { ok: true; real: string } | { ok: false; reason: "realpath_failed" | "outside_project" } {
  let real: string;
  try {
    real = realpathSync(finalPath);
  } catch {
    return { ok: false, reason: "realpath_failed" };
  }
  if (!insideBase(projectRoot, real)) {
    return { ok: false, reason: "outside_project" };
  }
  return { ok: true, real };
}
