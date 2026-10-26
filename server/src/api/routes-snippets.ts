// 常用语 REST 路由（todo 4）：两源读取（全局 snippets.json + 项目
// .ul-omo-webui.json）与按 scope 整替写入。读写行为全部下沉 config-store
// （todo 1：mtime 缓存、原子落盘、损坏显式报错），本层只做 HTTP 语义：
// 输入校验（空串/超限/形状）、已注册项目校验、整替后回显免前端二次 GET。
// 配置文件损坏按 Scope 决策 10a：显式写与管理端点严格 500（route 包装
// 默认行为，错误 message 含文件路径），不做静默降级。
import { createHash } from "node:crypto";
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

/** 两源聚合 revision：global+project 条目拼接后取 sha1 hex（兼容保留：任一源变更即
 * 变化）；乐观锁比对不用它——读写面同口径用下方组独立 revision（r9 BLOCKER-1 修复）。
 * 与 tagsRevision 同型取内容不取 mtime（mtime 时钟/写序噪声大）。 */
function snippetsRevision(globalSnippets: SnippetEntry[], projectSnippets: SnippetEntry[]): string {
  return createHash("sha1").update(JSON.stringify([globalSnippets, projectSnippets])).digest("hex");
}

/** 组独立 revision（r9 BLOCKER-1 修复）：该组条目内容单独取 sha1 hex。读写面统一口径——
 * GET 按组下发 globalRevision/projectRevision，PUT 按目标组比对同组 revision；不再用两源
 * 聚合做锁基线（活跃项目下 GET?project 下发 sha1([global, project]) 而 PUT global 比对
 * sha1([global, []])，两口径错位曾致 global 组保存恒 409 死锁）。 */
function groupRevision(entries: SnippetEntry[]): string {
  return createHash("sha1").update(JSON.stringify(entries)).digest("hex");
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
    const globalSnippets = deps.configs.readSnippets().snippets;
    const projectSnippets = project ? storeFor(project).readProjectConfig().snippets : [];
    return c.json({
      global: globalSnippets,
      project: projectSnippets,
      // 两源聚合 revision：兼容保留（任一源变更即变化），不作锁基线
      revision: snippetsRevision(globalSnippets, projectSnippets),
      // r9 BLOCKER-1 乐观锁：按组独立 revision，PUT 按目标组比对同组 revision（读写面同口径）
      globalRevision: groupRevision(globalSnippets),
      projectRevision: groupRevision(projectSnippets),
    });
  }));

  // 按 scope 整替（与 tags 同型整替；r9 F1-B1 补 revision 乐观锁：baseRevision 非空时
  // 先比当前 revision，不一致 409 不写入；未传/空串保持旧语义直写，老客户端兼容）：
  // scope 合法性 → project scope 必带且已注册 → 条目校验 → 锁比对 → 写。回显整替后
  // 该 scope 列表（store 读为同步、写 await 后缓存已更新）。
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
      // r9 BLOCKER-1 乐观锁：条目校验在后、写前仅比对 project 组自身 revision（组独立
      // 口径，与 GET projectRevision 同口径），不一致 409 不写入（部分写即覆盖丢失，
      // 绝不允许）；global 组变更不影响本组锁基线
      const baseRevision = typeof body.baseRevision === "string" ? body.baseRevision : "";
      if (baseRevision !== "" && groupRevision(store.readProjectConfig().snippets) !== baseRevision) {
        throw new ApiError(409, "snippet_conflict", "常用语已被其他端修改，请刷新后重试");
      }
      await store.updateProjectConfig({ snippets: entries });
      return c.json({ snippets: store.readProjectConfig().snippets });
    }
    const entries = parseSnippetEntries(body.snippets);
    // r9 BLOCKER-1 乐观锁：仅比对 global 组自身 revision（组独立口径，与 GET
    // globalRevision 同口径——写面不再受 project 源影响）；409 先于写盘
    const baseRevision = typeof body.baseRevision === "string" ? body.baseRevision : "";
    if (baseRevision !== "" && groupRevision(deps.configs.readSnippets().snippets) !== baseRevision) {
      throw new ApiError(409, "snippet_conflict", "常用语已被其他端修改，请刷新后重试");
    }
    await deps.configs.writeSnippets(entries);
    return c.json({ snippets: deps.configs.readSnippets().snippets });
  }));

  return app;
}
