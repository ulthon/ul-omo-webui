// 扩展资源面与 auth 凭证检查 REST 路由（docs08-2026-10-22 批次任务 24）：
// - GET  /api/extensions            资源清单（extensions/skills/prompts 三目录 + settings packages）
// - PUT  /api/extensions/:name      { enabled, kind? } 启停写入（服务端串行锁）
// - GET  /api/auth/status           凭证检查（spawnSync omo auth check，0/1/2 三态，10s 超时）
// - POST /api/extensions/install    { source } 非交互安装（async spawn 有界超时）
// - POST /api/extensions/remove     { source } 非交互移除
// - POST /api/extensions/update     非交互更新（omo update）
import { Hono, type Context } from "hono";
import { ApiError, parseJsonBody, route } from "./http";
import {
  checkAuthStatus,
  listExtensions,
  RESOURCE_KINDS,
  runExtensionAction,
  setResourceEnabled,
  type AuthStatus,
  type ExtensionAction,
  type ExtensionItem,
  type ResourceKind,
} from "./extensions-store";

export interface ExtensionsRouteDeps {
  agentDir: string;
  /** 引擎 CLI（node + omo.js）；null → install/remove/update 与 auth 检查降级 */
  engineCli: { nodeBin: string; cliJs: string } | null;
  /** 测试注入：auth 检查超时（缺省 10s） */
  authTimeoutMs?: number;
}

function parseKind(raw: unknown): ResourceKind {
  if (raw === undefined) throw new ApiError(400, "invalid_kind", "kind 必填（extension/skill/prompt/package）");
  if (typeof raw !== "string" || !RESOURCE_KINDS.includes(raw as ResourceKind)) {
    throw new ApiError(400, "invalid_kind", "kind 必须是 extension/skill/prompt/package 之一");
  }
  return raw as ResourceKind;
}

export function createExtensionsRoutes(deps: ExtensionsRouteDeps): Hono {
  const app = new Hono();

  app.get("/api/extensions", route(async (c: Context) => {
    const items: ExtensionItem[] = listExtensions(deps.agentDir);
    return c.json({ items, cliAvailable: deps.engineCli !== null });
  }));

  app.put("/api/extensions/:name", route(async (c: Context) => {
    const rawName = c.req.param("name");
    if (typeof rawName !== "string" || rawName.trim() === "") {
      throw new ApiError(400, "invalid_name", "name 必填");
    }
    const body = await parseJsonBody(c);
    if (typeof body.enabled !== "boolean") {
      throw new ApiError(400, "invalid_enabled", "enabled 必须是布尔值");
    }
    // name 允许 "kind/name" 复合形态；裸 name 时 kind 必填（跨目录可能同名）
    let kind: ResourceKind;
    let name = rawName;
    const slash = rawName.indexOf("/");
    if (slash > 0) {
      kind = parseKind(rawName.slice(0, slash));
      name = rawName.slice(slash + 1);
      if (body.kind !== undefined && body.kind !== kind) {
        throw new ApiError(400, "invalid_kind", "kind 与复合名前缀冲突");
      }
    } else {
      kind = parseKind(body.kind);
    }
    if (name.includes("/")) {
      throw new ApiError(400, "invalid_name", "name 不得包含额外的斜杠");
    }
    const result = await setResourceEnabled(deps.agentDir, kind, name, body.enabled);
    return c.json(result);
  }));

  app.get("/api/auth/status", route(async (c: Context) => {
    const status: AuthStatus = checkAuthStatus({
      agentDir: deps.agentDir,
      engineCli: deps.engineCli,
      timeoutMs: deps.authTimeoutMs,
    });
    return c.json(status);
  }));

  const action = (kind: ExtensionAction, needsSource: boolean) =>
    route(async (c: Context) => {
      const body = await parseJsonBody(c);
      const source = body.source;
      if (needsSource && (typeof source !== "string" || source.trim() === "")) {
        throw new ApiError(400, "invalid_source", "source 必填（如 npm:<package>）");
      }
      const result = await runExtensionAction({
        agentDir: deps.agentDir,
        engineCli: deps.engineCli,
        action: kind,
        source: typeof source === "string" ? source : undefined,
      });
      return c.json(result, result.ok ? 200 : 502);
    });

  app.post("/api/extensions/install", action("install", true));
  app.post("/api/extensions/remove", action("remove", true));
  app.post("/api/extensions/update", action("update", false));
  return app;
}
