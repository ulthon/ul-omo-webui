/**
 * 引擎回收历史只读面（engine-ux-visibility 任务 6）：GET /api/engines/reclaims。
 *
 * 数据源 = 有界内存环（默认最近 20 次），由组合根订阅 process-manager 既有
 * engine_reclaimed 发射点喂数（index.ts 内 onEvent 订阅，见接线注释）。
 *
 * 硬约束（计划 Must-NOT）：
 * - 纯读面：本文件零定时器、零回收路径改动——引擎被回收的行为与无本接口时完全
 *   一致，只多一条旁路记录。
 * - 不触发 ensure/spawn：环内容纯内存，路由处理器无任何引擎交互与磁盘读。
 * - 服务重启环即清空：回收历史是易失观测面（与 queueDepth 跟踪 Map 同档），
 *   不落库。
 */

import { Hono, type Context } from "hono";
import { route } from "./http";

/** 回收记录：at = 事件到达时刻（epoch ms）；reason 对齐 engine_reclaimed 事件枚举 */
export interface EngineReclaimRecord {
  at: number;
  sessionPath: string;
  reason: "idle_timeout" | "activity_window";
}

/** 环容量缺省：面板「最近 N 次回收」的 N 上界 */
export const RECLAIM_RING_CAPACITY = 20;

/** 有界 FIFO 内存环：push 追加（超容量掐头）；list 返回最新在前的浅拷贝 */
export class ReclaimRing {
  private readonly items: EngineReclaimRecord[] = [];

  constructor(readonly capacity: number = RECLAIM_RING_CAPACITY) {}

  push(rec: Omit<EngineReclaimRecord, "at">, at: number = Date.now()): void {
    this.items.push({ ...rec, at });
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  list(): EngineReclaimRecord[] {
    return [...this.items].reverse();
  }
}

export interface EngineReclaimsDeps {
  /** 环读取（listReclaims: () => ring.list() 接线） */
  listReclaims(): EngineReclaimRecord[];
}

export function createEngineReclaimsRoutes(deps: EngineReclaimsDeps): Hono {
  const app = new Hono();
  app.get("/api/engines/reclaims", route(async (c: Context) => {
    // 空环 = 暂无回收（200 + 空表），观测面不把缺席当错误（与 metrics 同语义）
    return c.json({ reclaims: deps.listReclaims() });
  }));
  return app;
}
