// 更新面（2026-10-31 update 批）：
// - GET  /api/update/check    三态检测（webui + 引擎），单项失败静默降级不报错
// - POST /api/update/install  触发安装（服务端互斥）；成功响应 200 后 500ms 经注入的
//   shutdown 优雅关停（不直接 process.exit，组合根收口权在 index.ts）
// 认证：随既有 /api/* cookie 中间件（挂载顺序在 auth.middleware 之后）。
import { Hono, type Context } from "hono";
import { DATA_DIR } from "../config";
import { checkUpdates } from "../update/checker";
import { installUpdate } from "../update/installer";
import { ApiError, parseJsonBody, route } from "./http";

export interface UpdateRouteDeps {
  /** 优雅关停（组合根注入，index.ts 的 shutdown）：安装成功响应后延迟调用 */
  readonly shutdown: () => void;
}

/** 响应先行 → 延迟关停：给 HTTP 回程留窗口（客户端拿到 restarting:true 再断连） */
const SHUTDOWN_DELAY_MS = 500;

export function createUpdateRoutes(deps: UpdateRouteDeps): Hono {
  const app = new Hono();

  app.get("/api/update/check", route(async (c: Context) => c.json(await checkUpdates())));

  app.post(
    "/api/update/install",
    route(async (c: Context) => {
      const body = await parseJsonBody(c);
      if (body.target !== "webui" && body.target !== "engine") {
        throw new ApiError(400, "invalid_request", "target 必须是 webui 或 engine");
      }
      const target = body.target;
      const version = body.version;
      if (typeof version !== "string" || version.trim() === "") {
        throw new ApiError(400, "invalid_request", "version 必须是非空字符串");
      }
      const result = await installUpdate({ dataDir: DATA_DIR }, target, version.trim());
      if ("restarting" in result) {
        setTimeout(() => deps.shutdown(), SHUTDOWN_DELAY_MS);
        return c.json({ restarting: true, version: result.version });
      }
      return c.json(
        {
          error: {
            code: result.code,
            message: result.message,
            ...(result.logTail !== undefined ? { logTail: result.logTail } : {}),
          },
        },
        result.status as 400,
      );
    }),
  );

  return app;
}
