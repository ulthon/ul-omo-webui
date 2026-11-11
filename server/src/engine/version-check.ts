// 引擎版本分叉启动断言（engine-upgrade-5169 批 4b）：
// - 宿主 require.resolve('@code-yeongyu/senpi/package.json') 的版本（代码编译/引用侧）
//   与 resolveEnginePaths().cliPath 上溯 package.json 的版本（spawn 侧）比对；
// - 不一致或任一侧不可解析 → engine-version-mismatch 告警日志，不阻断启动
//   （半装/分叉是历史事故层：静默最危险，先看见再处置）。
// 源码形态与发行形态都能跑：宿主侧 createRequire(import.meta.url)（bundle 下锚定
// 发行包 node_modules），spawn 侧锚定 resolveEnginePaths 既有布局探测。
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnginePaths } from "./process-manager";

function readPkgVersion(pkgPath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown; version?: unknown };
    return pkg.name === "@code-yeongyu/senpi" && typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 宿主侧 senpi package.json 路径：优先 require.resolve（exports 允许时）；
 *  senpi 的 package.json 子路径常未导出（ERR_PACKAGE_PATH_NOT_EXPORTED，dist 形态实测），
 *  回退链：omo-ai 锚点（process-manager 同款 nested/sibling/plain 候选）→ 本模块上溯
 *  node_modules（源码形态 server/src 与 dist 形态 server/dist 都能走到）。找不到返回 null。 */
export function hostSenpiPkgPath(): string | null {
  const req = createRequire(import.meta.url);
  try {
    return req.resolve("@code-yeongyu/senpi/package.json");
  } catch {
    // exports 未导出：走回退链
  }
  const candidates: string[] = [];
  try {
    const omoRoot = dirname(req.resolve("omo-ai/package.json"));
    try {
      const omoReal = realpathSync(omoRoot);
      candidates.push(join(omoReal, "node_modules", "@code-yeongyu", "senpi", "package.json"));
      candidates.push(join(omoReal, "..", "@code-yeongyu", "senpi", "package.json"));
    } catch {
      // 符号链接不可解析时退回常规布局
    }
    candidates.push(join(omoRoot, "node_modules", "@code-yeongyu", "senpi", "package.json"));
  } catch {
    // omo-ai 也不可解析：仅剩本模块上溯
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    candidates.push(join(dir, "node_modules", "@code-yeongyu", "senpi", "package.json"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** 从引擎 cli.js 路径上溯找 @code-yeongyu/senpi 的 package.json，返回其 version。
 *  npm 提升布局（senpi 在 cliPath 上数级 node_modules 内）与 bun 旁路布局均可命中；
 *  找不到或解析失败返回 null（由比对函数统一出告警文案）。 */
export function enginePkgVersionFromCliPath(cliPath: string): string | null {
  let dir = dirname(cliPath);
  const root = parse(dir).root;
  while (true) {
    const hit = readPkgVersion(join(dir, "package.json"));
    if (hit !== null) return hit;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/** 纯比对：不一致/不可解析时返回告警文案，一致返回 null。 */
export function engineVersionMismatch(hostVersion: string | null, engineVersion: string | null): string | null {
  const host = hostVersion ?? "unknown";
  const engine = engineVersion ?? "unknown";
  if (hostVersion === null || engineVersion === null) {
    return `engine-version-mismatch：引擎版本不可解析（宿主=${host} 运行时=${engine}），可能半装，请重装 webui`;
  }
  if (hostVersion !== engineVersion) {
    return `engine-version-mismatch：宿主 senpi ${hostVersion} 与引擎运行时 ${engineVersion} 不一致，可能半装/分叉，请重装 webui`;
  }
  return null;
}

export interface EngineVersionCheckDeps {
  readonly hostVersion: () => string | null;
  readonly engineVersion: () => string | null;
  readonly warn: (message: string) => void;
}

/** 组合根入口：默认双解析 + console.warn；任一解析抛错按不可解析出告警，不阻断。 */
export function runEngineVersionCheck(deps?: Partial<EngineVersionCheckDeps>): void {
  const warn = deps?.warn ?? ((m: string) => console.warn(m));
  const hostResolve =
    deps?.hostVersion ??
    (() => {
      try {
        const pkgPath = hostSenpiPkgPath();
        return pkgPath === null ? null : readPkgVersion(pkgPath);
      } catch {
        return null;
      }
    });
  const engineResolve =
    deps?.engineVersion ??
    (() => {
      try {
        return enginePkgVersionFromCliPath(resolveEnginePaths().cliPath);
      } catch {
        return null;
      }
    });
  const hostVersion = hostResolve();
  const engineVersion = engineResolve();
  const mismatch = engineVersionMismatch(hostVersion, engineVersion);
  if (mismatch !== null) warn(mismatch);
}
