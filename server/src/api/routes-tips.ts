// tips 用法提示 REST 路由（docs08-2026-10-22 批次任务 25）：
// - GET /api/tips：spawnSync 引擎 CLI（resolveEnginePaths().cliPath，引擎缺失回落 PATH
//   上的 omo）`--list-tips`，输出契约 [{id, text, requiresCommand?}]（requiresCommand
//   实测为关联命令名字符串）。组合根创建路由即拉一次（启动缓存）；5min TTL 到期后下次
//   GET 重拉；拉取失败沿用旧缓存，无缓存失败返回 { tips: [] }——前端空态据此不渲染
//   tip 区（不硬编码清单、不报错）。全部 spawn 同步但有界（超时 10s）。
import { spawnSync } from "node:child_process";
import { Hono } from "hono";
import { route } from "./http";

export interface TipItem {
  id: string;
  text: string;
  /** 引擎契约：关联命令名（如 "efforts"）；无关联时缺省。webui 不按它过滤（对拍口径 GET=CLI） */
  requiresCommand?: string | boolean;
}

export interface TipsRouteDeps {
  /** 引擎 agent 目录（注入 OMO_CODING_AGENT_DIR / SENPI_CODING_AGENT_DIR，与引擎 spawn 同源） */
  agentDir: string;
  /** 引擎 CLI 本体（process.execPath + cliPath 运行）；缺省回落 PATH 上的 `omo` */
  cliPath?: string;
  /** 缓存 TTL（缺省 5min；测试注入短 TTL 配合 now 推进） */
  ttlMs?: number;
  /** spawn 超时（缺省 10s） */
  timeoutMs?: number;
  /** 时钟注入口（TTL 测试） */
  now?: () => number;
  /** spawnSync 注入口（测试替身；生产即 node:child_process.spawnSync） */
  spawn?: TipsSpawnSync;
}

export const TIPS_TTL_MS = 5 * 60_000;
export const TIPS_TIMEOUT_MS = 10_000;

/** spawnSync 最小结构面（真实 spawnSync 结构兼容；显式类型免逐字重载匹配） */
export type TipsSpawnSync = (
  file: string,
  args: readonly string[],
  opts: { encoding: string; timeout: number; env: NodeJS.ProcessEnv },
) => { error?: Error; status: number | null; stdout?: string | null; stderr?: string | null };

/** CLI stdout → 提示清单：仅收 {id, text} 双非空字符串的项（脏项剔除，多余字段不透传）；
 *  非 JSON / 非数组 / 解析异常一律 null（=拉取失败，调用方沿用旧缓存；合法空数组是
 *  成功语义，缓存空清单——TTL 内不重拉）。 */
export function parseTipsOutput(stdout: string): TipItem[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const out: TipItem[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { id, text, requiresCommand } = item as Record<string, unknown>;
    if (typeof id !== "string" || id === "" || typeof text !== "string" || text === "") continue;
    if (typeof requiresCommand === "string" && requiresCommand !== "") {
      out.push({ id, text, requiresCommand });
    } else if (requiresCommand === true) {
      out.push({ id, text, requiresCommand: true });
    } else {
      out.push({ id, text });
    }
  }
  return out;
}

export function createTipsRoutes(deps: TipsRouteDeps): Hono {
  const spawn: TipsSpawnSync = deps.spawn ?? (spawnSync as unknown as TipsSpawnSync);
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? TIPS_TTL_MS;
  const timeoutMs = deps.timeoutMs ?? TIPS_TIMEOUT_MS;
  let cache: { tips: TipItem[]; fetchedAt: number } | null = null;

  /** 拉一次并落缓存；任何失败（非零退出/超时/spawn 异常/契约不合规）缓存原样保留 */
  const refresh = (): void => {
    let parsed: TipItem[] | null = null;
    try {
      const [file, args] = deps.cliPath
        ? [process.execPath, [deps.cliPath, "--list-tips"]]
        : ["omo", ["--list-tips"]];
      const r = spawn(file, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        env: {
          ...process.env,
          OMO_CODING_AGENT_DIR: deps.agentDir,
          SENPI_CODING_AGENT_DIR: deps.agentDir,
        },
      });
      if (!r.error && r.status === 0) parsed = parseTipsOutput(r.stdout ?? "");
    } catch {
      // spawn 抛错（CLI 缺失等）按失败路径：不缓存、不崩
    }
    if (parsed !== null) cache = { tips: parsed, fetchedAt: now() };
  };

  const app = new Hono();

  // 启动缓存：组合根创建路由即拉一次（同步 spawnSync，成功通常亚秒；失败留空缓存不阻断启动）
  refresh();

  app.get(
    "/api/tips",
    route(async (c) => {
      if (cache === null || now() - cache.fetchedAt >= ttlMs) refresh();
      return c.json({ tips: cache?.tips ?? [] });
    }),
  );

  return app;
}
