// 项目 REST 路由（todo 9 + todo 6 + W2 todo 7）：注册/列表/偏好更新。
// todo 6 起项目偏好（preferredModel/permissionPreset；todo 7 增 preferredThinkingLevel）
// 以项目根 .ul-omo-webui.json 为权威源：PATCH 落文件（损坏 500 带路径，决策 10a）；
// GET/POST/PATCH 响应合并两源——过渡态
// （文件缺字段且库值未迁清）以库值为准；文件损坏时合并读按项目降级 null + configError
// 标志（决策 10b，单项目损坏不炸整页）。meta_kv permission-preset:<project> 为迁移前
// 存量来源，仅读（过渡态回退），不再写入；变更后需 POST /api/projects/restart 让引擎
// 按新 spawn 参数重建。
import { Hono, type Context } from "hono";
import { lstatSync, realpathSync } from "node:fs";
import { PERMISSION_PRESET_NAMES, BUILTIN_TOOL_CATALOG } from "./engine-runtime";
import { readProjectPreferences, type ProjectConfigStores, type ProjectPreferenceView } from "./config-migration";
import { ApiError, parseJsonBody, route } from "./http";
import { THINKING_LEVEL_VALUES, type PreferredThinkingLevel } from "../conf/config-store";
import type { ApiDeps } from "./deps";
import type { ProjectMeta } from "../db/meta";
import { validateProjectInput, createProjectInput } from "./paths";

/** meta 行 + 合并偏好响应（preferredModel/permissionPreset/preferredThinkingLevel/tools/excludedTools
 *  为合并值；损坏降级时附 configError；tools 显式空集附 degradedNoTools） */
function projectResponse(meta: ProjectMeta, view: ProjectPreferenceView) {
  return {
    ...meta,
    preferredModel: view.preferredModel,
    permissionPreset: view.permissionPreset,
    preferredThinkingLevel: view.preferredThinkingLevel,
    tools: view.tools,
    excludedTools: view.excludedTools,
    ...(view.degradedNoTools ? { degradedNoTools: true } : {}),
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

  // 注册项目：路径校验（存在 + 目录 + realpath 规范化），幂等（重复注册刷新 last_opened_at）。
  // create:true（docs08-r3 任务 20"新建并添加"）：路径不存在时由 createProjectInput
  // 先按安全口径建目录（最近存在祖先是目录且可写才 mkdir -p）再走同一校验注册。
  app.post("/api/projects", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project =
      body.create === true
        ? createProjectInput(body.path)
        : validateProjectInput(body.path);
    deps.meta.updateProjectMeta(project, { lastOpenedAt: new Date().toISOString() });
    const meta = deps.meta.getProjectMeta(project);
    return c.json({ ok: true, project: meta ? projectResponse(meta, viewOf(project)) : null });
  }));

  // 项目偏好（部分更新）：lastOpenedAt 写库；preferredModel/permissionPreset/
  // preferredThinkingLevel 写项目文件（todo 6/7）。预设 null = 清除 = 默认行为；
  // 合法档位以引擎 PERMISSION_PRESET_NAMES 与 THINKING_LEVEL_VALUES 为准。文件写 await
  // （损坏在此抛 500 带路径，库未被触碰）、库写同步；响应合并两源——
  // 仅写库字段的 PATCH 在文件损坏时仍 200（响应带 configError，库写已成功不误报失败）。
  app.patch("/api/projects/meta", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = validateProjectInput(body.path);
    const dbPatch: {
      lastOpenedAt?: string | null;
    } = {};
    let preferredModel: string | null | undefined;
    if (body.preferredModel !== undefined) {
      if (body.preferredModel !== null && typeof body.preferredModel !== "string") {
        throw new ApiError(400, "invalid_preferred_model", "preferredModel 必须是字符串或 null");
      }
      preferredModel = body.preferredModel as string | null;
    }
    let preferredThinkingLevel: PreferredThinkingLevel | null | undefined;
    if (body.preferredThinkingLevel !== undefined) {
      if (
        body.preferredThinkingLevel !== null &&
        !THINKING_LEVEL_VALUES.includes(body.preferredThinkingLevel as PreferredThinkingLevel)
      ) {
        throw new ApiError(
          400,
          "invalid_preferred_thinking_level",
          `preferredThinkingLevel 仅支持：${THINKING_LEVEL_VALUES.join("、")}（null 为清除）`,
        );
      }
      preferredThinkingLevel = body.preferredThinkingLevel as PreferredThinkingLevel | null;
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
    // 工具启停（r10 todo 17）：tools/excludedTools 字符串数组或 null（null = 恢复引擎默认）。
    // 元素去两端空白、丢空串、去重（保序）；空数组合法 = 显式空集（tools → --no-tools 降级）。
    const normalizeToolList = (raw: unknown, field: string): string[] | null => {
      if (raw === null) return null;
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
        throw new ApiError(400, `invalid_${field}`, `${field} 必须是字符串数组或 null`);
      }
      return [...new Set((raw as string[]).map((v) => v.trim()).filter((v) => v !== ""))];
    };
    let tools: string[] | null | undefined;
    if (body.tools !== undefined) tools = normalizeToolList(body.tools, "tools");
    let excludedTools: string[] | null | undefined;
    if (body.excludedTools !== undefined) excludedTools = normalizeToolList(body.excludedTools, "excluded_tools");
    if (
      Object.keys(dbPatch).length === 0 &&
      preferredModel === undefined &&
      preset === undefined &&
      preferredThinkingLevel === undefined &&
      tools === undefined &&
      excludedTools === undefined
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "需要 preferredModel/lastOpenedAt/permissionPreset/preferredThinkingLevel/tools/excludedTools 至少一项",
      );
    }
    if (
      preferredModel !== undefined ||
      preset !== undefined ||
      preferredThinkingLevel !== undefined ||
      tools !== undefined ||
      excludedTools !== undefined
    ) {
      await deps.projectConfigs(project).updateProjectConfig({
        ...(preferredModel !== undefined ? { preferredModel } : {}),
        ...(preset !== undefined ? { permissionPreset: preset } : {}),
        ...(preferredThinkingLevel !== undefined ? { preferredThinkingLevel } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(excludedTools !== undefined ? { excludedTools } : {}),
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

  // 项目隐藏软标记（A2 docs08-r3 todo 10）：hidden 只改 meta_project.hidden 列——
  // 注册行、会话数据与会话 meta 原样保留，GET /api/sessions 聚合模式据此过滤分组，
  // 设置面板"已隐藏"筛选可见可恢复。path 校验与注销同口径（形状校验 + 注册键精确匹配，
  // 支持 hidden 死项目）；hidden 必须是布尔（不做真值宽容，防误传字符串静默生效）。
  // 幂等：重复 PUT 同值不崩不变形（二次隐藏为确定性同结果）。
  app.put("/api/projects/hidden", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    if (typeof body.path !== "string" || body.path.length === 0 || !body.path.startsWith("/")) {
      throw new ApiError(400, "invalid_project", "path 必须是绝对路径");
    }
    if (typeof body.hidden !== "boolean") {
      throw new ApiError(400, "invalid_hidden", "hidden 必须是布尔值");
    }
    if (!deps.meta.getProjectMeta(body.path)) {
      throw new ApiError(404, "not_registered", "项目未注册");
    }
    deps.meta.updateProjectMeta(body.path, { hidden: body.hidden });
    const meta = deps.meta.getProjectMeta(body.path);
    return c.json({ ok: true, project: meta ? projectResponse(meta, viewOf(body.path)) : null });
  }));

  // 工具目录（r10 todo 17）：内置工具静态清单（与引擎 CLI help "Built-in Tool Names"
  // 同源，spike-16 实证引擎无工具列表 RPC）。设置页逐工具开关的枚举源。
  app.get("/api/projects/tools", (c: Context) => c.json({ tools: BUILTIN_TOOL_CATALOG }));

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
