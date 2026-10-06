// 项目 REST 路由（todo 9）：注册/列表（合并 meta_project 字段）/偏好更新。
import { Hono, type Context } from "hono";
import { ApiError, parseJsonBody, route } from "./http";
import type { ApiDeps } from "./deps";
import { validateProjectInput } from "./paths";

export function createProjectRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // 项目列表：元数据库为准（webui 的项目 universe = 显式注册的项目）
  app.get("/api/projects", route(async (c: Context) => {
    return c.json({ projects: deps.meta.listProjectMeta() });
  }));

  // 注册项目：路径校验（存在 + 目录 + realpath 规范化），幂等（重复注册刷新 last_opened_at）
  app.post("/api/projects", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = validateProjectInput(body.path);
    deps.meta.updateProjectMeta(project, { lastOpenedAt: new Date().toISOString() });
    return c.json({ ok: true, project: deps.meta.getProjectMeta(project) });
  }));

  // 项目偏好：preferred_agent/preferred_model/last_opened_at（部分更新）
  app.patch("/api/projects/meta", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = validateProjectInput(body.path);
    const patch: {
      preferredAgent?: string | null;
      preferredModel?: string | null;
      lastOpenedAt?: string | null;
    } = {};
    if (body.preferredAgent !== undefined) {
      if (body.preferredAgent !== null && typeof body.preferredAgent !== "string") {
        throw new ApiError(400, "invalid_preferred_agent", "preferredAgent 必须是字符串或 null");
      }
      patch.preferredAgent = body.preferredAgent as string | null;
    }
    if (body.preferredModel !== undefined) {
      if (body.preferredModel !== null && typeof body.preferredModel !== "string") {
        throw new ApiError(400, "invalid_preferred_model", "preferredModel 必须是字符串或 null");
      }
      patch.preferredModel = body.preferredModel as string | null;
    }
    if (body.lastOpenedAt !== undefined) {
      if (body.lastOpenedAt !== null && typeof body.lastOpenedAt !== "string") {
        throw new ApiError(400, "invalid_last_opened_at", "lastOpenedAt 必须是 ISO 字符串或 null");
      }
      patch.lastOpenedAt = body.lastOpenedAt as string | null;
    }
    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, "invalid_request", "需要 preferredAgent/preferredModel/lastOpenedAt 至少一项");
    }
    deps.meta.updateProjectMeta(project, patch);
    return c.json({ ok: true, project: deps.meta.getProjectMeta(project) });
  }));

  return app;
}
