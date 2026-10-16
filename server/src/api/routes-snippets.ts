// 常用语 REST 路由（todo 4）：两源读取（全局 snippets.json + 项目
// .ul-omo-webui.json）与按 scope 整替写入。读写行为全部下沉 config-store
// （todo 1：mtime 缓存、原子落盘、损坏显式报错），本层只做 HTTP 语义：
// 输入校验（空串/超限/形状）、已注册项目校验、整替后回显免前端二次 GET。
// 配置文件损坏按 Scope 决策 10a：显式写与管理端点严格 500（route 包装
// 默认行为，错误 message 含文件路径），不做静默降级。
import { Hono, type Context } from "hono";
import { openConfigStore, type ConfigStore, type SnippetEntry } from "../conf/config-store";
import { ApiError, parseJsonBody, route } from "./http";
import type { ApiDeps } from "./deps";
import { validateProjectInput } from "./paths";

/** 单条 content 上限 4KB（UTF-8 字节数） */
const SNIPPET_MAX_BYTES = 4 * 1024;

/** 常用语路由要求配置存储存在（ApiDeps.configs 为可选字段，工厂收紧） */
type SnippetsDeps = ApiDeps & { configs: ConfigStore };

/** project 键规范化：与 /api/projects 的 realpath 键一致前缀形态；目录可不存在 */
function normalizeProjectKey(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || !raw.startsWith("/")) {
    throw new ApiError(400, "invalid_project", "project 必须是绝对路径");
  }
  return raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
}

/** 条目数组边界解析：content 必填非空串且 ≤4KB，sort 可选有限数字（缺省 0） */
function parseSnippetEntries(raw: unknown): SnippetEntry[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "invalid_snippets", "snippets 必须是条目数组");
  }
  return raw.map((item): SnippetEntry => {
    const entry: Record<string, unknown> = typeof item === "object" && item !== null ? item : {};
    const content = entry.content;
    if (typeof content !== "string" || content === "") {
      throw new ApiError(400, "invalid_snippets", "条目 content 必填且不能为空串");
    }
    if (Buffer.byteLength(content, "utf8") > SNIPPET_MAX_BYTES) {
      throw new ApiError(400, "invalid_snippets", `单条 content 超过 ${SNIPPET_MAX_BYTES} 字节上限`);
    }
    const sort = entry.sort;
    if (sort !== undefined && (typeof sort !== "number" || !Number.isFinite(sort))) {
      throw new ApiError(400, "invalid_snippets", "条目 sort 必须是数字");
    }
    return { content, sort: sort ?? 0 };
  });
}

export function createSnippetsRoutes(deps: SnippetsDeps): Hono {
  const app = new Hono();
  // 项目 scope 的派生存储按 realpath 缓存：同一项目的写共用一条进程内
  // promise 链（config-store 串行化是 per-instance 的）；全局 scope 始终
  // 走注入实例，两 scope 各文件仅一个属主实例，无跨实例写竞争。
  const projectStores = new Map<string, ConfigStore>();

  function storeFor(project: string): ConfigStore {
    let store = projectStores.get(project);
    if (!store) {
      store = openConfigStore({ globalDir: deps.configs.globalDir, projectRoot: project });
      projectStores.set(project, store);
    }
    return store;
  }

  // 两源读取：project 可选（缺省 project 源为空数组；读不要求已注册，
  // 与 routes-meta 同理：目录删除后已落盘配置仍可读）
  app.get("/api/snippets", route(async (c: Context) => {
    const raw = c.req.query("project");
    const project = raw ? normalizeProjectKey(raw) : null;
    return c.json({
      global: deps.configs.readSnippets().snippets,
      project: project ? storeFor(project).readProjectConfig().snippets : [],
    });
  }));

  // 按 scope 整替：scope 合法性 → project scope 必带且已注册 → 条目校验 → 写。
  // 回显整替后该 scope 列表（store 读为同步、写 await 后缓存已更新）。
  app.put("/api/snippets", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const scope = body.scope;
    if (scope !== "global" && scope !== "project") {
      throw new ApiError(400, "invalid_scope", "scope 仅支持 global|project");
    }
    if (scope === "project") {
      const project = validateProjectInput(body.project);
      if (!deps.meta.getProjectMeta(project)) {
        throw new ApiError(400, "project_not_found", `项目未注册：${project}`);
      }
      const entries = parseSnippetEntries(body.snippets);
      const store = storeFor(project);
      await store.updateProjectConfig({ snippets: entries });
      return c.json({ snippets: store.readProjectConfig().snippets });
    }
    const entries = parseSnippetEntries(body.snippets);
    await deps.configs.writeSnippets(entries);
    return c.json({ snippets: deps.configs.readSnippets().snippets });
  }));

  return app;
}
