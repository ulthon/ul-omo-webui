// 权限/提问应答路由单测（docs08-r7 任务 14：comment-only 落定对齐）：
// - comment-only：answers:{} + 非空 comment → 网关收到完整 reply（answers 键在场，
//   引擎 ConnectionQuestionBridge.respond 才进入 settledQuestionStatus 落定
//   comment-submitted；剥掉空 answers 是 r6 实录 question_incomplete 静默卡死根因）
// - 纯空对象 answers（无 comment）→ 400（引擎恒拒收，不放行死路径）
// - answers + comment 并存、纯 answers、cancelled、缺 requestId 各形态
import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createSessionRoutes } from "../src/api/routes-session";
import { openMetaDb } from "../src/db/meta";
import type { EngineGateway } from "../src/api/engine-runtime";
import type {
  EngineCommandInfo,
  EngineMessagesPage,
  EngineModelInfo,
  EnginePermissionReply,
  EngineQuestionFrame,
  EngineSessionSummary,
  EngineThinkingLevel,
  EngineUsageStats,
  EngineQueueSnapshot,
} from "../src/adapter/engine-adapter";

// ---------------------------------------------------------------- fake gateway

class FakeGateway implements EngineGateway {
  sessions = new Map<string, EngineSessionSummary>();
  replies: Array<{ sessionId: string; requestId: string; reply: EnginePermissionReply }> = [];

  async resolveSessionRow(sessionId: string): Promise<EngineSessionSummary | null> {
    return this.sessions.get(sessionId) ?? null;
  }
  async sessionsList(): Promise<EngineSessionSummary[]> {
    return [...this.sessions.values()];
  }
  async createSession(
    _project: string,
    _opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    throw new Error("not used");
  }
  async messages(_id: string, _cursor?: string): Promise<EngineMessagesPage> {
    return { entries: [], leafId: null, cursor: null };
  }
  async prompt(): Promise<{ disposition: string }> {
    return { disposition: "started" };
  }
  async abort(): Promise<void> {}
  async queueList(): Promise<EngineQueueSnapshot> {
    return { steering: [], followUp: [], ordered: [] };
  }
  async queueClear(): Promise<EngineQueueSnapshot> {
    return { steering: [], followUp: [], ordered: [] };
  }
  async commandsList(_project: string): Promise<EngineCommandInfo[] | null> {
    return null;
  }
  async permissionRespond(sessionId: string, requestId: string, reply: EnginePermissionReply): Promise<void> {
    this.replies.push({ sessionId, requestId, reply });
  }
  async questionsList(_id: string): Promise<EngineQuestionFrame[]> {
    return [];
  }
  async usage(): Promise<EngineUsageStats> {
    throw new Error("not used");
  }
  async modelsList(): Promise<EngineModelInfo[]> {
    return [];
  }
  async deleteSession(): Promise<{ sessionPath: string; fileExisted: boolean }> {
    return { sessionPath: "", fileExisted: false };
  }
  async exportSessionHtml(): Promise<{ html: string; row: EngineSessionSummary }> {
    throw new Error("not used");
  }
  async forkSession(): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }> {
    throw new Error("not used");
  }
  async peekActiveSessionPaths(): Promise<string[] | null> {
    return null;
  }
  async restartProject(): Promise<void> {}
  async stopAll(): Promise<void> {}
}

function buildApp(engines: FakeGateway) {
  const meta = openMetaDb({ path: join(mkdtempSync(join(tmpdir(), "perm-meta-")), "meta.db") });
  const app = new Hono();
  app.route("/", createSessionRoutes({ meta, engines }));
  return app;
}

const post = (app: Hono, body: unknown) =>
  app.request("/api/sessions/s1/permission", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/sessions/:id/permission（comment-only 落定对齐）", () => {
  test("comment-only：answers:{} + comment 原样透传（含空 answers 键，r6 回归钉死）", async () => {
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", {
      id: "s1",
      path: "/sessions/s1.jsonl",
      cwd: "/tmp/p",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
      firstMessage: "hi",
    });
    const app = buildApp(gateway);
    const res = await post(app, { requestId: "req-1", answers: {}, comment: "只补充说明" });
    expect(res.status).toBe(200);
    expect(gateway.replies).toHaveLength(1);
    expect(gateway.replies[0].requestId).toBe("req-1");
    expect(gateway.replies[0].reply).toEqual({ answers: {}, comment: "只补充说明" });
  });

  test("纯空对象 answers（无 comment）→ 400：引擎恒拒收，不放行死路径", async () => {
    const gateway = new FakeGateway();
    const app = buildApp(gateway);
    const res = await post(app, { requestId: "req-1", answers: {} });
    expect(res.status).toBe(400);
    expect(gateway.replies).toHaveLength(0);
  });

  test("answers + comment 并存、纯 answers、cancelled 正常透传", async () => {
    const gateway = new FakeGateway();
    const app = buildApp(gateway);
    const answers = { q1: { selected: ["a"], text: "x" } };
    expect((await post(app, { requestId: "r1", answers, comment: "备注" })).status).toBe(200);
    expect((await post(app, { requestId: "r2", answers })).status).toBe(200);
    expect((await post(app, { requestId: "r3", cancelled: true })).status).toBe(200);
    expect(gateway.replies.map((r) => r.reply)).toEqual([
      { answers, comment: "备注" },
      { answers },
      { cancelled: true },
    ]);
  });

  test("answers 条目异形（selected 非数组）不透传该字段", async () => {
    const gateway = new FakeGateway();
    const app = buildApp(gateway);
    const res = await post(app, { requestId: "r1", answers: { q1: { selected: "nope" } }, comment: "c" });
    expect(res.status).toBe(200);
    expect(gateway.replies[0].reply).toEqual({ comment: "c" });
  });

  test("requestId 缺失 400；全空 body 400", async () => {
    const gateway = new FakeGateway();
    const app = buildApp(gateway);
    expect((await post(app, { answers: {} })).status).toBe(400);
    expect((await post(app, { requestId: "r1" })).status).toBe(400);
    expect(gateway.replies).toHaveLength(0);
  });
});
