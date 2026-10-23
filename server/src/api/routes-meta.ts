// 元数据与能力面 REST 路由（todo 9）：模型枚举 / 输入历史 / 设置 kv。
// docs08-2026-10-22 批次任务 23 追加：模型发现（GET provider 清单 / POST 发现+导入）。
import { Hono, type Context } from "hono";
import { agentDir } from "../config";
import { ApiError, parseJsonBody, route } from "./http";
import { discoverProviderModels, listDiscoverableProviders } from "./models-discover";
import type { ApiDeps } from "./deps";

/** 输入历史/设置的 project 键规范化：与 /api/projects 的 realpath 键保持一致前缀形态。
 * 与 validateProjectInput 不同：目录可不存在（历史记录在目录删除后仍可读）。 */
function normalizeProjectKey(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || !raw.startsWith("/")) {
    throw new ApiError(400, "invalid_project", "project 必须是绝对路径");
  }
  const trimmed = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  return trimmed;
}

export function createMetaRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const modelsPath = (): string => deps.modelsPath ?? agentDir() + "/models.json";

  // 模型枚举：需引擎进程（get_available_models）。project 缺省取最近打开的项目。
  app.get("/api/models", route(async (c: Context) => {
    const raw = c.req.query("project");
    const project = raw
      ? normalizeProjectKey(raw)
      : deps.meta.listProjectMeta()[0]?.projectPath;
    if (!project) {
      throw new ApiError(400, "no_project", "尚无已知项目：请先 POST /api/projects 或传 project 参数");
    }
    const models = await deps.engines.modelsList(project);
    // CLI 收藏（settings.json favoriteModels 归一 "provider/model"）：引擎无关的
    // agent 级设置，测试 fake 未实现可选面时降级空数组。
    const favorites = deps.engines.favoriteModels?.() ?? [];
    // 引擎 native 默认模型（settings.json defaultProvider/defaultModel/defaultThinkingLevel，
    // docs08-r5 任务 2）：同为 agent 级设置，测试 fake 未实现可选面时降级 null——
    // 前端回退链跳过引擎默认档，与旧服务端未下发字段同口径。
    const defaults = deps.engines.defaultModel?.() ?? null;
    return c.json({ project, capabilities: { modelsList: true }, models, favorites, defaults });
  }));

  // 模型发现：provider 清单（GET）与发现/导入（POST，docs08-2026-10-22 批次任务 23）。
  // GET 返回 models.json 中各 provider 的 baseUrl/模型数（文件缺失返回空清单，
  // 首次配置 provider 前空态可用）；POST 缺省仅预览（不落盘），import 非空才合并写回。
  app.get("/api/models/discover", route(async (_c: Context) => {
    return _c.json({ providers: listDiscoverableProviders(modelsPath()) });
  }));

  app.post("/api/models/discover", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const provider = body.provider;
    if (typeof provider !== "string" || provider.trim() === "") {
      throw new ApiError(400, "invalid_provider", "provider 必填（models.json 中的 provider 名）");
    }
    const importIds = body.import as string[] | "all" | undefined;
    if (importIds !== undefined && importIds !== "all" && !Array.isArray(importIds)) {
      throw new ApiError(400, "invalid_import", "import 必须是 \"all\" 或模型 id 字符串数组");
    }
    const report = await discoverProviderModels({ modelsPath: modelsPath(), providerId: provider, importIds });
    return c.json(report);
  }));

  // 输入历史（去重上限 200 条由存储层保证）
  app.get("/api/input-history", route(async (c: Context) => {
    const project = normalizeProjectKey(c.req.query("project"));
    const limitRaw = c.req.query("limit");
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new ApiError(400, "invalid_limit", "limit 必须是 1-200 的整数");
      }
    }
    return c.json({ project, items: deps.meta.listInputHistory(project, limit) });
  }));

  app.post("/api/input-history", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = normalizeProjectKey(body.project);
    if (typeof body.content !== "string" || body.content.trim() === "") {
      throw new ApiError(400, "invalid_content", "content 必填且不能为空");
    }
    deps.meta.appendInputHistory(project, body.content);
    return c.json({ ok: true, items: deps.meta.listInputHistory(project) });
  }));

  // 设置 kv（外链地址、权限"总是允许"记忆等配置）
  app.get("/api/settings", route(async (c: Context) => {
    return c.json({ settings: deps.meta.listKv() });
  }));

  app.put("/api/settings", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const entries = Object.entries(body);
    if (entries.length === 0) {
      throw new ApiError(400, "invalid_settings", "请求体需为 {key: value} 形态且至少一项");
    }
    for (const [key, value] of entries) {
      if (typeof value !== "string") {
        throw new ApiError(400, "invalid_settings", `设置值必须是字符串：${key}`);
      }
    }
    for (const [key, value] of entries) {
      deps.meta.setKv(key, value as string);
    }
    return c.json({ ok: true, settings: deps.meta.listKv() });
  }));

  return app;
}
