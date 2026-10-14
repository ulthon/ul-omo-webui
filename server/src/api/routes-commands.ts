// 斜杠命令枚举路由（docs08-r3 任务 19）：GET /api/commands 一次取数按 source
// 分成三段（extension=引擎命令 / skill=技能 / prompt=用户提示），前端下拉单请求消费。
// 通道实证（docs/verification/06）：三组同走 RPC get_commands，调用契约均为命令直发。
// 60s 按项目内存缓存（单次 RPC 11-29ms，缓存后成本可忽略）；引擎未就绪或无活跃
// 会话（missing_session_id 硬约束）时降级 available=false + 空三段，绝不触发 spawn、绝不崩。
import { Hono, type Context } from "hono";
import { ApiError, route } from "./http";
import type { ApiDeps } from "./deps";
import type { EngineCommandInfo } from "../adapter/engine-adapter";

/** 缓存 TTL：引擎命令面变化低频（技能/提示文件增删），60s 内 stale 可接受（记录行为） */
const CACHE_TTL_MS = 60_000;

export interface CommandGroups {
  extension: EngineCommandInfo[];
  skill: EngineCommandInfo[];
  prompt: EngineCommandInfo[];
}

interface CacheEntry {
  at: number;
  groups: CommandGroups;
}

/** 按项目键控的 60s 内存缓存；降级（null）不入缓存——引擎就绪后下一请求即可取到 */
const cache = new Map<string, CacheEntry>();

export function groupCommandsBySource(rows: EngineCommandInfo[]): CommandGroups {
  const groups: CommandGroups = { extension: [], skill: [], prompt: [] };
  for (const row of rows) {
    if (row.source === "skill") groups.skill.push(row);
    else if (row.source === "prompt") groups.prompt.push(row);
    // 未知 source（老引擎字段面差异）归引擎命令段兜底；段内按 name 排序稳定展示
    else groups.extension.push(row);
  }
  for (const list of [groups.extension, groups.skill, groups.prompt]) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups;
}

/** project 键规范化与 routes-meta 同口径（/api/models 先例）：缺省取最近打开的项目 */
export function createCommandsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/api/commands", route(async (c: Context) => {
    const raw = c.req.query("project");
    const project = raw
      ? normalizeProjectKey(raw)
      : deps.meta.listProjectMeta()[0]?.projectPath;
    if (!project) {
      throw new ApiError(400, "no_project", "尚无已知项目：请先 POST /api/projects 或传 project 参数");
    }
    const hit = cache.get(project);
    let groups: CommandGroups;
    let available: boolean;
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      groups = hit.groups;
      available = true;
    } else {
      let rows: EngineCommandInfo[] | null = null;
      try {
        rows = await deps.engines.commandsList(project);
      } catch {
        // 引擎 RPC 异常（进程崩溃等）同未就绪口径降级，端点不 5xx——前端下拉只是
        // 不渲染，打字主路径零关联
        rows = null;
      }
      if (rows === null) {
        groups = { extension: [], skill: [], prompt: [] };
        available = false;
      } else {
        groups = groupCommandsBySource(rows);
        available = true;
        cache.set(project, { at: Date.now(), groups });
      }
    }
    return c.json({ project, available, commands: groups });
  }));

  return app;
}

function normalizeProjectKey(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || !raw.startsWith("/")) {
    throw new ApiError(400, "invalid_project", "project 必须是绝对路径");
  }
  return raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
}
