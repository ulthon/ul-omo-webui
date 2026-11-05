// 引擎进程管理路由（2026-11-04 用户定版；2026-11-05 multi-session-parallel T5 行会话化）：
// GET /api/engines 全量引擎快照：每会话引擎一行（projectPath+sessionPath+pid+state+
// 运行回合数+最后活动），无引擎的已知项目保留 inactive 行（sessionPath=null）。
// POST /api/engines/stop 手动停：body 带 sessionPath 定向停单会话引擎；带 project
// 停该项目全部会话引擎（项目级停止保留；两者同传时 sessionPath 优先）。
// stop 语义等价空闲回收的 stop（优雅停，运行中回合与后台任务会一并终止——
// 前端在运行回合>0 时二次确认）。
// 与诊断导出的 engines 摘要同源（组合根共用 buildEngineAdminRows 同一构造器）。
// 列表端点不做已注册项目门（无引擎项目的 inactive 行必须透出），仅 stop 校验。
import { Hono, type Context } from "hono";
import { ApiError, parseJsonBody, route } from "./http";
import type { EngineStatusSnapshot } from "../engine/process-manager";

/** 进程管理行（每会话引擎一行；与诊断 engines 摘要同形）。
 * 用 type 而非 interface：组合根要把同一行数组直接注入诊断面
 * Array<Record<string, unknown>>，对象字面量类型才有隐式索引签名。 */
export type EngineAdminRow = {
  projectPath: string;
  /** 引擎键=会话文件路径；无引擎已知项目的 inactive 行为 null */
  sessionPath: string | null;
  state: string;
  pid?: number;
  restarts: number;
  runningSessions: number;
  lastActivityAt: number | null;
};

/** 行源字段（EngineStatusSnapshot 的投影面，结构化解耦便于测试） */
type EngineStatusRowSource = Pick<
  EngineStatusSnapshot,
  "projectPath" | "sessionPath" | "state" | "pid" | "consecutiveRestarts" | "runningSessions" | "lastActivityAt"
>;

/** 管理行构造器（诊断 engines 摘要与进程管理列表同源；T5 从组合根抽出可测）：
 * 每会话引擎一行；无引擎的已知项目补 inactive 行（sessionPath=null、
 * state 固定 "inactive"，不误报 ready）。 */
export function buildEngineAdminRows(
  statuses: readonly EngineStatusRowSource[],
  knownProjects: ReadonlyArray<{ projectPath: string }>,
): EngineAdminRow[] {
  const rows: EngineAdminRow[] = statuses.map((st) => ({
    projectPath: st.projectPath,
    sessionPath: st.sessionPath,
    state: st.state,
    pid: st.pid,
    restarts: st.consecutiveRestarts,
    runningSessions: st.runningSessions.length,
    lastActivityAt: st.lastActivityAt,
  }));
  const withEngine = new Set(statuses.map((s) => s.projectPath));
  for (const p of knownProjects) {
    if (!withEngine.has(p.projectPath)) {
      rows.push({
        projectPath: p.projectPath,
        sessionPath: null,
        state: "inactive",
        pid: undefined,
        restarts: 0,
        runningSessions: 0,
        lastActivityAt: null,
      });
    }
  }
  return rows;
}

export interface EngineAdminDeps {
  /** 全量引擎行（每会话引擎一行 + 无引擎已知项目 inactive 行） */
  listEngines(): EngineAdminRow[];
  /** 定向停：停指定会话引擎（sessionPath 须有引擎行） */
  stopEngine(sessionPath: string): Promise<void>;
  /** 项目级停：停该项目全部会话引擎（projectPath 须为已注册项目） */
  stopProject(projectPath: string): Promise<void>;
  /** 已注册项目路径校验（仅项目级 stop 用；列表不做此门） */
  isKnownProject(projectPath: string): boolean;
}

export function createEngineAdminRoutes(deps: EngineAdminDeps): Hono {
  const app = new Hono();

  app.get("/api/engines", route(async (c: Context) => {
    return c.json({ engines: deps.listEngines() });
  }));

  app.post("/api/engines/stop", route(async (c: Context) => {
    const body = await parseJsonBody(c);
    const sessionPath = typeof body.sessionPath === "string" ? body.sessionPath : "";
    const project = typeof body.project === "string" ? body.project : "";
    if (sessionPath !== "") {
      // 定向停单会话引擎（T5）：行内校验——无引擎行的会话=从未拉起/未知
      if (!sessionPath.startsWith("/")) {
        throw new ApiError(400, "invalid_session", "sessionPath 必须是绝对路径");
      }
      if (!deps.listEngines().some((r) => r.sessionPath === sessionPath)) {
        throw new ApiError(404, "unknown_session", "无该会话的引擎行");
      }
      await deps.stopEngine(sessionPath);
      return c.json({ ok: true });
    }
    if (project !== "") {
      // 项目级停止保留：停该项目全部会话引擎
      if (!project.startsWith("/")) {
        throw new ApiError(400, "invalid_project", "project 必须是绝对路径");
      }
      if (!deps.isKnownProject(project)) {
        throw new ApiError(404, "unknown_project", "未注册的项目");
      }
      await deps.stopProject(project);
      return c.json({ ok: true });
    }
    throw new ApiError(400, "invalid_request", "需要 sessionPath（定向停单会话引擎）或 project（停该项目全部引擎）");
  }));

  return app;
}
