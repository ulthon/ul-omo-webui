// 引擎进程管理路由（2026-11-04 用户定版）：设置页「进程管理」分区后端面。
// GET /api/engines 全量引擎快照（项目/状态/pid/运行回合数/最后活动）；
// POST /api/engines/stop 手动停指定项目引擎（等价空闲回收的 stop 语义：
// 优雅停，运行中回合与后台任务会一并终止——前端在运行回合>0 时二次确认）。
// 与诊断导出的 engines 摘要同源（组合根共用同一 rows 构造器）。
import { Hono, type Context } from "hono";
import { ApiError, parseJsonBody, route } from "./http";

/** 进程管理行（与诊断 engines 摘要同形） */
export interface EngineAdminRow {
  projectPath: string;
  state: string;
  pid?: number;
  restarts: number;
  runningSessions: number;
  lastActivityAt: number | null;
}

export interface EngineAdminDeps {
  /** 全量引擎行（含从未拉起过的 inactive 项目） */
  listEngines(): EngineAdminRow[];
  /** 停指定项目引擎（projectPath 必须是已注册项目） */
  stopEngine(projectPath: string): Promise<void>;
  /** 已注册项目路径校验用（与 listEngines 同源即可） */
  isKnownProject(projectPath: string): boolean;
}

export function createEngineAdminRoutes(deps: EngineAdminDeps): Hono {
  const app = new Hono();

  app.get("/api/engines", route(async (c: Context) => {
    return c.json({ engines: deps.listEngines() });
  }));

  app.post("/api/engines/stop", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const project = typeof body.project === "string" ? body.project : "";
    if (!project.startsWith("/")) {
      throw new ApiError(400, "invalid_project", "project 必须是绝对路径");
    }
    if (!deps.isKnownProject(project)) {
      throw new ApiError(404, "unknown_project", "未注册的项目");
    }
    await deps.stopEngine(project);
    return c.json({ ok: true });
  }));

  return app;
}
