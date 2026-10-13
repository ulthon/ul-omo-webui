// 项目 REST 路由（todo 9 + todo 6）：注册/列表/偏好更新。
// todo 6 起项目偏好（preferredModel/permissionPreset）以项目根 .senpi-webui.json 为权威源：
// PATCH 落文件（损坏 500 带路径，决策 10a）；GET/POST/PATCH 响应合并两源——过渡态
// （文件缺字段且库值未迁清）以库值为准；文件损坏时合并读按项目降级 null + configError
// 标志（决策 10b，单项目损坏不炸整页）。meta_kv permission-preset:<project> 为迁移前
// 存量来源，仅读（过渡态回退），不再写入；变更后需 POST /api/projects/restart 让引擎
// 按新 spawn 参数重建。
import { Hono, type Context } from "hono";
import { lstatSync, realpathSync } from "node:fs";
import { PERMISSION_PRESET_NAMES } from "./engine-runtime";
import { readProjectPreferences, type ProjectConfigStores, type ProjectPreferenceView } from "./config-migration";
import { ApiError, parseJsonBody, route } from "./http";
import type { ApiDeps } from "./deps";
import type { ProjectMeta } from "../db/meta";
import { validateProjectInput } from "./paths";

/** meta 行 + 合并偏好响应（preferredModel/permissionPreset 为合并值；损坏降级时附 configError） */
function projectResponse(meta: ProjectMeta, view: ProjectPreferenceView) {
  return {
    ...meta,
    preferredModel: view.preferredModel,
    permissionPreset: view.permissionPreset,
    ...(view.configError ? { configError: true } : {}),
  };
}

/**
 * 死项目守卫（W1 缺陷 #2）：realpathSync 解析失败（目录被删/悬空符号链接）或解析结果
 * 不是目录（被同名文件顶替）→ 标记 missing:true，web 端自动恢复静默跳过。
 * shape：仅缺失条目携带 missing:true，可解析条目省略该字段（与 configError 同惯例）。
 * 注册时即存 realpath（todo 14 惯例），此处 realpath 复核沿用同一身份约定。
 */
function pathMissing(projectPath: string): boolean {
  try {
    return !lstatSync(realpathSync(projectPath)).isDirectory();
  } catch {
    return true;
  }
}

export function createProjectRoutes(deps: ApiDeps & { projectConfigs: ProjectConfigStores }): Hono {
  const app = new Hono();
  const viewOf = (projectPath: string) => readProjectPreferences(deps.projectConfigs, deps.meta, projectPath);

  // 项目列表：元数据库为准（webui 的项目 universe = 显式注册的项目）；
  // 偏好字段合并项目文件源，单项目文件损坏降级 null + configError（不炸整页）；
  // 每条路径做一次 cheap 探测（realpathSync+lstat），已不存在/不再是目录标 missing:true
  app.get("/api/projects", route(async (c: Context) => {
    return c.json({
      projects: deps.meta.listProjectMeta().map((p) => {
        const item = projectResponse(p, viewOf(p.projectPath));
        return pathMissing(p.projectPath) ? { ...item, missing: true } : item;
      }),
    });
  }));

  // 注册项目：路径校验（存在 + 目录 + realpath 规范化），幂等（重复注册刷新 last_opened_at）
  app.post("/api/projects", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = validateProjectInput(body.path);
    deps.meta.updateProjectMeta(project, { lastOpenedAt: new Date().toISOString() });
    const meta = deps.meta.getProjectMeta(project);
    return c.json({ ok: true, project: meta ? projectResponse(meta, viewOf(project)) : null });
  }));

  // 项目偏好（部分更新）：preferredAgent/lastOpenedAt 写库；preferredModel/permissionPreset
  // 写项目文件（todo 6）。预设 null = 清除 = 默认行为；合法档位以引擎 PERMISSION_PRESET_NAMES
  // 为准。文件写 await（损坏在此抛 500 带路径，库未被触碰）、库写同步；响应合并两源——
  // 仅写库字段的 PATCH 在文件损坏时仍 200（响应带 configError，库写已成功不误报失败）。
  app.patch("/api/projects/meta", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = validateProjectInput(body.path);
    const dbPatch: {
      preferredAgent?: string | null;
      lastOpenedAt?: string | null;
    } = {};
    let preferredModel: string | null | undefined;
    if (body.preferredAgent !== undefined) {
      if (body.preferredAgent !== null && typeof body.preferredAgent !== "string") {
        throw new ApiError(400, "invalid_preferred_agent", "preferredAgent 必须是字符串或 null");
      }
      dbPatch.preferredAgent = body.preferredAgent as string | null;
    }
    if (body.preferredModel !== undefined) {
      if (body.preferredModel !== null && typeof body.preferredModel !== "string") {
        throw new ApiError(400, "invalid_preferred_model", "preferredModel 必须是字符串或 null");
      }
      preferredModel = body.preferredModel as string | null;
    }
    if (body.lastOpenedAt !== undefined) {
      if (body.lastOpenedAt !== null && typeof body.lastOpenedAt !== "string") {
        throw new ApiError(400, "invalid_last_opened_at", "lastOpenedAt 必须是 ISO 字符串或 null");
      }
      dbPatch.lastOpenedAt = body.lastOpenedAt as string | null;
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
    if (Object.keys(dbPatch).length === 0 && preferredModel === undefined && preset === undefined) {
      throw new ApiError(400, "invalid_request", "需要 preferredAgent/preferredModel/lastOpenedAt/permissionPreset 至少一项");
    }
    if (preferredModel !== undefined || preset !== undefined) {
      await deps.projectConfigs(project).updateProjectConfig({
        ...(preferredModel !== undefined ? { preferredModel } : {}),
        ...(preset !== undefined ? { permissionPreset: preset } : {}),
      });
    }
    if (Object.keys(dbPatch).length > 0) {
      deps.meta.updateProjectMeta(project, dbPatch);
    }
    const meta = deps.meta.getProjectMeta(project);
    return c.json({ ok: true, project: meta ? projectResponse(meta, viewOf(project)) : null });
  }));

  // 项目注销（W1 缺陷 #1）：删 meta_project 注册行，meta_session 原样保留——重新注册
  // 同一路径即恢复置顶/改名/标签（设置面板确认文案的产品承诺）。引擎进程不杀：自托管
  // 单用户语义下，注销的注册关系只影响列表 universe 与自动恢复，残留的项目引擎进程
  // 闲置无害，引擎重建由既有 restart 通道按需发生。
  // path 仅做形状校验（非空绝对路径），不做存在性校验——移除死项目（GET 列表 missing 项）
  // 是本能力主场景之一；已注册路径即注册时落库的 realpath 规范形态（web 一律从 GET 列表
  // 取 projectPath 回传），按注册键精确匹配。幂等语义：重复注销按未注册处理（404
  // not_registered），不做静默 200——第二次调用给出与首次不同的确定性结果。
  app.delete("/api/projects", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    if (typeof body.path !== "string" || body.path.length === 0 || !body.path.startsWith("/")) {
      throw new ApiError(400, "invalid_project", "path 必须是绝对路径");
    }
    if (!deps.meta.getProjectMeta(body.path)) {
      throw new ApiError(404, "not_registered", "项目未注册");
    }
    deps.meta.deleteProjectMeta(body.path);
    return c.json({ path: body.path, removed: true });
  }));

  // 重建项目引擎进程：spawn 参数级配置（权限预设 permissionPreset 等）
  // 变更后的生效口。会话态失效属预期（下次访问懒加载重建）。
  app.post("/api/projects/restart", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = validateProjectInput(body.project);
    await deps.engines.restartProject(project);
    return c.json({ ok: true, project });
  }));

  return app;
}
