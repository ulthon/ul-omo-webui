// 项目 REST 路由（todo 9）：注册/列表（合并 meta_project 字段）/偏好更新。
// 权限预设（kv permission-preset:<project>，spawn 级）经本文件读写：列表回显 +
// PATCH 落 kv；变更后需 POST /api/projects/restart 让引擎按新 spawn 参数重建。
import { Hono, type Context } from "hono";
import { PERMISSION_PRESET_NAMES, permissionPresetKey } from "./engine-runtime";
import { ApiError, parseJsonBody, route } from "./http";
import type { ApiDeps } from "./deps";
import { validateProjectInput } from "./paths";

/** 项目行 + 权限预设 kv 合并（无预设为 null = 默认行为，spawn 不加 --permission-preset） */
function withPermissionPreset(
  meta: { projectPath: string; preferredAgent: string | null; preferredModel: string | null; lastOpenedAt: string | null },
  getKv: (key: string) => string | null,
) {
  return { ...meta, permissionPreset: getKv(permissionPresetKey(meta.projectPath)) ?? null };
}

export function createProjectRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // 项目列表：元数据库为准（webui 的项目 universe = 显式注册的项目）
  app.get("/api/projects", route(async (c: Context) => {
    return c.json({ projects: deps.meta.listProjectMeta().map((p) => withPermissionPreset(p, (k) => deps.meta.getKv(k))) });
  }));

  // 注册项目：路径校验（存在 + 目录 + realpath 规范化），幂等（重复注册刷新 last_opened_at）
  app.post("/api/projects", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = validateProjectInput(body.path);
    deps.meta.updateProjectMeta(project, { lastOpenedAt: new Date().toISOString() });
    const meta = deps.meta.getProjectMeta(project);
    return c.json({ ok: true, project: meta ? withPermissionPreset(meta, (k) => deps.meta.getKv(k)) : null });
  }));

  // 项目偏好：preferred_agent/preferred_model/last_opened_at + 权限预设（部分更新）。
  // 预设 null = 清除 = 默认行为；合法档位以引擎 PERMISSION_PRESET_NAMES 为准。
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
    let preset: string | null | undefined;
    if (body.permissionPreset !== undefined) {
      if (body.permissionPreset !== null && typeof body.permissionPreset !== "string") {
        throw new ApiError(400, "invalid_permission_preset", "permissionPreset 必须是字符串或 null");
      }
      if (body.permissionPreset !== null && !PERMISSION_PRESET_NAMES.includes(body.permissionPreset)) {
        throw new ApiError(
          400,
          "invalid_permission_preset",
          `permissionPreset 仅支持：${PERMISSION_PRESET_NAMES.join("、")}（null 为默认行为）`,
        );
      }
      preset = body.permissionPreset as string | null;
    }
    if (Object.keys(patch).length === 0 && preset === undefined) {
      throw new ApiError(400, "invalid_request", "需要 preferredAgent/preferredModel/lastOpenedAt/permissionPreset 至少一项");
    }
    if (Object.keys(patch).length > 0) {
      deps.meta.updateProjectMeta(project, patch);
    }
    if (preset !== undefined) {
      if (preset === null) {
        deps.meta.deleteKv(permissionPresetKey(project));
      } else {
        deps.meta.setKv(permissionPresetKey(project), preset);
      }
    }
    const meta = deps.meta.getProjectMeta(project);
    return c.json({ ok: true, project: meta ? withPermissionPreset(meta, (k) => deps.meta.getKv(k)) : null });
  }));

  // 重建项目引擎进程：spawn 参数级配置（权限预设 permission-preset:<project> 等）
  // 变更后的生效口。会话态失效属预期（下次访问懒加载重建）。
  app.post("/api/projects/restart", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = validateProjectInput(body.project);
    await deps.engines.restartProject(project);
    return c.json({ ok: true, project });
  }));

  return app;
}
