// 标签定义与挂载 REST 路由（todo 3）：定义两源在 config-store 文件
// （全局 tags.json + 项目 .ul-omo-webui.json tags 字段），挂载关系在
// meta_session_tag。挂载与定义解耦：自由挂载不要求定义已存在，孤儿关联
// （定义已删）在 GET 时如实返回，前端灰样式展示。
// 配置文件损坏按 Scope 决策 10a：显式写与管理端点严格 500（route 包装
// 默认行为，错误 message 含文件路径），不做静默降级。
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  openConfigStore,
  TAG_COLOR_RE,
  TAG_DISPLAY_MODES,
  type ConfigStore,
  type TagDisplayMode,
  type TagEntry,
} from "../conf/config-store";
import { ApiError, parseJsonBody, requireParam, route } from "./http";
import type { ApiDeps } from "./deps";
import { validateProjectInput } from "./paths";
import type { SessionTagRef } from "../db/meta";

/** 标签路由要求配置存储存在（ApiDeps.configs 为可选字段，工厂收紧） */
type TagsDeps = ApiDeps & { configs: ConfigStore };

/** project 键规范化：与 /api/projects 的 realpath 键一致前缀形态；目录可不存在 */
function normalizeProjectKey(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || !raw.startsWith("/")) {
    throw new ApiError(400, "invalid_project", "project 必须是绝对路径");
  }
  return raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
}

/** 定义条目边界解析：name 必填非空串，sort 可选有限数字（缺省 0）；
 * color 可选 #rrggbb（非法 400，todo 20）；display 可选 text|grid（非法 400） */
function parseTagEntries(raw: unknown): TagEntry[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "invalid_tags", "tags 必须是条目数组");
  }
  return raw.map((item): TagEntry => {
    const entry: Record<string, unknown> = typeof item === "object" && item !== null ? item : {};
    const name = entry.name;
    if (typeof name !== "string" || name === "") {
      throw new ApiError(400, "invalid_tags", "条目 name 必填且不能为空串");
    }
    const sort = entry.sort;
    if (sort !== undefined && (typeof sort !== "number" || !Number.isFinite(sort))) {
      throw new ApiError(400, "invalid_tags", "条目 sort 必须是数字");
    }
    const color = entry.color;
    if (color !== undefined && (typeof color !== "string" || !TAG_COLOR_RE.test(color))) {
      throw new ApiError(400, "invalid_tags", "条目 color 必须是 #rrggbb 六位十六进制色");
    }
    const display = entry.display;
    if (
      display !== undefined &&
      (typeof display !== "string" || !(TAG_DISPLAY_MODES as readonly string[]).includes(display))
    ) {
      throw new ApiError(400, "invalid_tags", "条目 display 仅支持 text|grid");
    }
    return {
      name,
      sort: sort ?? 0,
      ...(color !== undefined ? { color } : {}),
      ...(display !== undefined ? { display: display as TagDisplayMode } : {}),
    };
  });
}

/** 定义名去重校验：同名定义破坏前端按名索引（400 而非静默合并） */
function requireUniqueNames(entries: TagEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new ApiError(400, "invalid_tags", `重名标签：${entry.name}`);
    }
    seen.add(entry.name);
  }
}

/** 两源定义内容 revision（r9 乐观锁）：global+project 定义内容拼接后取 sha1 hex。
 * 取内容不取 mtime（mtime 时钟/写序噪声大）；两源均经 config-store 归一化读取，
 * JSON 序列化键序稳定。project 源仅在给定项目时参与——与 GET /api/tags
 * （?project 缺省 = 空数组）同口径，PUT 侧按 scope 同口径计算。 */
function tagsRevision(globalTags: TagEntry[], projectTags: TagEntry[]): string {
  return createHash("sha1").update(JSON.stringify([globalTags, projectTags])).digest("hex");
}

export function createTagsRoutes(deps: TagsDeps): Hono {
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
  // 与 routes-snippets 同理：目录删除后已落盘配置仍可读）
  app.get("/api/tags", route(async (c: Context) => {
    const raw = c.req.query("project");
    const project = raw ? normalizeProjectKey(raw) : null;
    const globalTags = deps.configs.readTags().tags;
    const projectTags = project ? storeFor(project).readProjectConfig().tags : [];
    return c.json({
      global: globalTags,
      project: projectTags,
      // r9 乐观锁：前端整替提交时回传 baseRevision 比对
      revision: tagsRevision(globalTags, projectTags),
    });
  }));

  // 按 scope 整替：scope 合法性 → project scope 必带且已注册 → 条目校验
  //（含定义名去重）→ 写。回显整替后该 scope 列表（store 读为同步、写
  // await 后缓存已更新）。
  app.put("/api/tags", route(async (c: Context) => {
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
      const entries = parseTagEntries(body.tags);
      requireUniqueNames(entries);
      const store = storeFor(project);
      // r9 乐观锁：baseRevision 非空时先比当前 revision（条目校验在后写前比对，
      // 不一致 409 不写入）；未传/空串保持旧语义直写（老客户端兼容）
      const baseRevision = typeof body.baseRevision === "string" ? body.baseRevision : "";
      if (
        baseRevision !== "" &&
        tagsRevision(deps.configs.readTags().tags, store.readProjectConfig().tags) !== baseRevision
      ) {
        throw new ApiError(409, "tag_conflict", "标签定义已被其他端修改，请刷新后重试");
      }
      await store.updateProjectConfig({ tags: entries });
      return c.json({ tags: store.readProjectConfig().tags });
    }
    const entries = parseTagEntries(body.tags);
    requireUniqueNames(entries);
    const baseRevision = typeof body.baseRevision === "string" ? body.baseRevision : "";
    if (baseRevision !== "" && tagsRevision(deps.configs.readTags().tags, []) !== baseRevision) {
      throw new ApiError(409, "tag_conflict", "标签定义已被其他端修改，请刷新后重试");
    }
    await deps.configs.writeTags(entries);
    return c.json({ tags: deps.configs.readTags().tags });
  }));

  // 会话标签挂载整替（与 tags 同型整替，r9 盘点记录）：挂载 revision 无低成本同型
  // 修复——读取面在 GET /api/sessions 行内嵌 tags（routes-session，本次范围外），
  // 同一套 revision 模式需跨文件暴露逐会话 revision，成本不同型 → 仅注释不改语义。
  // 对任意 id 直接写入，不做会话存在性校验——
  // meta_session_tag 无外键，挂载事实独立于会话与定义（挂载-定义解耦的
  // 同款取舍：计划只要求"自由挂载不要求定义已存在"，未要求会话校验）。
  // 新建会话在用户打开前没有 meta_session 行（行只在 markRead/
  // updateSessionMeta 时创建），校验会堵死"列表行直接打标"主流程；
  // 单用户产品、UI 驱动，误写垃圾 id 的代价只是不可见行，可接受。
  // 无需校验会话属于某项目。数组内重复项先去重再写（库层 PK 冲突由
  // REST 层消化）。
  // 挂载删除审计（docs08 2026-10-23/24 批次任务 10）：本端点是挂载写入的唯一缝隙，
  // 整替前后做差，被移除的挂载逐条写 meta_tag_mount_audit（会话 id、tag、时间、
  // source=触发删除的 UI 动作标识，缺省 "api"）；新增/保留不产生审计行。
  app.put("/api/sessions/:id/tags", route(async (c: Context) => {
    const id = requireParam(c, "id");
    const body = await parseJsonBody(c);
    if (!Array.isArray(body.tags)) {
      throw new ApiError(400, "invalid_tags", "tags 必须是条目数组");
    }
    const rawSource = (body as { source?: unknown }).source;
    const source =
      typeof rawSource === "string" && rawSource.trim() !== "" ? rawSource.trim().slice(0, 64) : "api";
    const seen = new Set<string>();
    const refs: SessionTagRef[] = [];
    for (const item of body.tags) {
      const entry: Record<string, unknown> = typeof item === "object" && item !== null ? item : {};
      const scope = entry.scope;
      if (scope !== "global" && scope !== "project") {
        throw new ApiError(400, "invalid_tags", "条目 scope 仅支持 global|project");
      }
      const name = entry.name;
      if (typeof name !== "string" || name === "") {
        throw new ApiError(400, "invalid_tags", "条目 name 必填且不能为空串");
      }
      const key = `${scope}\u0000${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ scope, name });
    }
    const before = deps.meta.listSessionTags(id);
    deps.meta.setSessionTags(id, refs);
    const removed = before.filter(
      (tag) => !refs.some((ref) => ref.scope === tag.scope && ref.name === tag.name),
    );
    deps.meta.appendTagMountAudit(
      removed.map((tag) => ({ sessionId: id, scope: tag.scope, name: tag.name, source })),
    );
    return c.json({ tags: deps.meta.listSessionTags(id).map(({ scope, name }) => ({ scope, name })) });
  }));

  return app;
}
