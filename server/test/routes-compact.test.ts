/**
 * docs08-r5 任务 8：POST /api/sessions/:id/compact 路由层测试。
 * 端点无参数（webui 只暴露裸 /compact）；回执形状 {sessionId, summary,
 * firstKeptEntryId, tokensBefore, tokensAfter?, usage}；网关可选面缺省 501；
 * 网关 ApiError 原样映射（409 already_processing / 404 session_not_found）。
 * docs08-r6 任务 18 ④：同步等待期限（COMPACT_HTTP_TIMEOUT_MS）内未完成 →
 * 504 compact_timeout（后台进行中文案）；期限内网关拒绝仍原样先到上抛
 * （fire_and_forget_regression 防线：同步 await 链零改动）。
 * 运行时层（真实 ProjectRuntime：流式守卫/引擎错误形态映射）由 runtime-compact.test.ts 覆盖。
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { createSessionRoutes } from "../src/api/routes-session"
import { openMetaDb } from "../src/db/meta"
import { openConfigStore } from "../src/conf/config-store"
import { createProjectConfigStores } from "../src/api/config-migration"
import type { EngineGateway } from "../src/api/engine-runtime"
import type {
  EngineCommandInfo,
  EngineCompactResult,
  EngineMessagesPage,
  EngineModelInfo,
  EnginePermissionReply,
  EnginePromptInput,
  EngineQueueSnapshot,
  EngineQuestionFrame,
  EngineSessionSummary,
  EngineThinkingLevel,
  EngineUsageStats,
} from "../src/adapter/engine-adapter"
import { ApiError } from "../src/api/http"
import { COMPACT_HTTP_TIMEOUT_MS } from "../src/api/routes-session"

const COMPACT_RESULT: EngineCompactResult = {
  summary: "压缩摘要",
  firstKeptEntryId: "entry-9",
  tokensBefore: 32881,
  estimatedTokensAfter: 9120,
}

const USAGE: EngineUsageStats = {
  sessionId: "s1",
  sessionFile: "/proj/s1.jsonl",
  userMessages: 3,
  assistantMessages: 3,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 6,
  tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
  cost: 0.01,
  contextUsage: { tokens: 9120, contextWindow: 1000000, percent: 0.912 },
}

/** 最小 FakeGateway：仅实现本测试触及的面；compact 可编程 */
class FakeGateway implements EngineGateway {
  compactError: unknown = null;
  async sessionsList(): Promise<EngineSessionSummary[]> {
    return []
  }
  async createSession(
    _project: string,
    _opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    throw new ApiError(500, "internal", "not expected")
  }
  async messages(_id: string, _cursor?: string): Promise<EngineMessagesPage> {
    return { entries: [], leafId: null, cursor: null }
  }
  // deno-lint-ignore require-await
  async prompt(
    _id: string,
    _input: {
      text: string;
      images?: EnginePromptInput["images"];
      model?: string;
      thinkingLevel?: EngineThinkingLevel;
      streamingBehavior?: EnginePromptInput["streamingBehavior"];
    },
  ): Promise<{ disposition: string }> {
    return { disposition: "started" }
  }
  async queueList(): Promise<EngineQueueSnapshot> {
    return { steering: [], followUp: [], ordered: [] }
  }
  async queueClear(): Promise<EngineQueueSnapshot> {
    return { steering: [], followUp: [], ordered: [] }
  }
  async abort(): Promise<void> {}
  async permissionRespond(_id: string, _requestId: string, _reply: EnginePermissionReply): Promise<void> {}
  async questionsList(_id: string): Promise<EngineQuestionFrame[]> {
    return []
  }
  async usage(): Promise<EngineUsageStats> {
    return USAGE
  }
  async compact(_id: string): Promise<{ result: EngineCompactResult; usage: EngineUsageStats }> {
    if (this.compactError) throw this.compactError
    return { result: COMPACT_RESULT, usage: USAGE }
  }
  async modelsList(): Promise<EngineModelInfo[]> {
    return []
  }
  async commandsList(): Promise<EngineCommandInfo[] | null> {
    return null
  }
  async deleteSession(): Promise<{ sessionPath: string; fileExisted: boolean }> {
    return { sessionPath: "/proj/s1.jsonl", fileExisted: false }
  }
  async exportSessionHtml(): Promise<{ html: string; row: EngineSessionSummary }> {
    throw new ApiError(409, "session_not_persisted", "not expected")
  }
  async forkSession(): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }> {
    throw new ApiError(500, "internal", "not expected")
  }
  peekActiveSessionPaths(): Promise<string[] | null> {
    return Promise.resolve([])
  }
  async restartProject(): Promise<void> {}
  async stopAll(): Promise<void> {}
}

function buildApp(engines: EngineGateway): Hono {
  const app = new Hono();
  const configs = openConfigStore({ globalDir: join(mkdtempSync(join(tmpdir(), "routes-compact-cfg-")), "global") });
  const meta = openMetaDb({ path: join(mkdtempSync(join(tmpdir(), "routes-compact-meta-")), "meta.db") });
  app.route("/", createSessionRoutes({ meta, engines, configs, projectConfigs: createProjectConfigStores(configs) }));
  return app;
}

describe("POST /api/sessions/:id/compact（docs08-r5 任务 8）", () => {
  test("200 回执形状：sessionId/summary/firstKeptEntryId/tokensBefore/tokensAfter/usage", async () => {
    const app = buildApp(new FakeGateway());
    const res = await app.request("/api/sessions/s1/compact", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sessionId).toBe("s1");
    expect(body.summary).toBe("压缩摘要");
    expect(body.firstKeptEntryId).toBe("entry-9");
    expect(body.tokensBefore).toBe(32881);
    expect(body.tokensAfter).toBe(9120);
    expect((body.usage as EngineUsageStats).contextUsage?.tokens).toBe(9120);
  });

  test("网关未实现可选面 → 501 compact_unsupported", async () => {
    const gateway = new FakeGateway();
    (gateway as Partial<EngineGateway>).compact = undefined;
    const app = buildApp(gateway as EngineGateway);
    const res = await app.request("/api/sessions/s1/compact", { method: "POST" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("compact_unsupported");
  });

  test("网关 ApiError 原样映射：409 already_processing / 404 session_not_found", async () => {
    const gateway = new FakeGateway();
    gateway.compactError = new ApiError(409, "already_processing", "回合进行中");
    const app = buildApp(gateway);
    const res = await app.request("/api/sessions/s1/compact", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("already_processing");
    expect(body.error.message).toBe("回合进行中");

    const gateway2 = new FakeGateway();
    gateway2.compactError = new ApiError(404, "session_not_found", "会话不存在");
    const res2 = await buildApp(gateway2).request("/api/sessions/missing/compact", { method: "POST" });
    expect(res2.status).toBe(404);
  });

  test("estimatedTokensAfter 缺省时回执不带 tokensAfter 字段", async () => {
    const gateway = new FakeGateway();
    gateway.compactError = null;
    // 覆写 compact 返回无 estimatedTokensAfter 的结果
    (gateway as { compact: (id: string) => Promise<{ result: EngineCompactResult; usage: EngineUsageStats }> }).compact =
      async (_id: string) => ({ result: { summary: "s", firstKeptEntryId: "e", tokensBefore: 10 }, usage: USAGE });
    const res = await buildApp(gateway).request("/api/sessions/s1/compact", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect("tokensAfter" in body).toBe(false);
  });
});

describe("POST /api/sessions/:id/compact 超时映射（docs08-r6 任务 18 ④）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("网关挂起超 COMPACT_HTTP_TIMEOUT_MS → 504 compact_timeout（后台进行中文案，不裸断连接）", async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    // 引擎侧压缩慢于 HTTP 期限：永不 resolve（后台仍在进行的模拟）
    (gateway as unknown as { compact: (id: string) => Promise<never> }).compact = () => new Promise(() => {});
    const resPromise = buildApp(gateway).request("/api/sessions/s1/compact", { method: "POST" });
    // 让请求链微任务跑起来再推进期限时钟
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(COMPACT_HTTP_TIMEOUT_MS + 5);
    const res = await resPromise;
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("compact_timeout");
    expect(body.error.message).toBe("压缩仍在后台进行，完成后水位自动刷新");
  });

  test("期限内完成不走超时（fake timers 下同步回执 200，fire_and_forget_regression：仍是同步 await 链）", async () => {
    vi.useFakeTimers();
    const app = buildApp(new FakeGateway());
    const resPromise = app.request("/api/sessions/s1/compact", { method: "POST" });
    await vi.advanceTimersByTimeAsync(COMPACT_HTTP_TIMEOUT_MS - 1000);
    const res = await resPromise;
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.summary).toBe("压缩摘要");
    expect(body.tokensBefore).toBe(32881);
  });

  test("期限内网关 409 拒绝仍原样先到上抛（超时映射不改变 409 语义，conflict_409_semantics）", async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    gateway.compactError = new ApiError(409, "already_processing", "回合进行中");
    const resPromise = buildApp(gateway).request("/api/sessions/s1/compact", { method: "POST" });
    await vi.advanceTimersByTimeAsync(0);
    const res = await resPromise;
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("already_processing");
    expect(body.error.message).toBe("回合进行中");
  });
});

// 临时目录由各 buildApp 自建（mkdtempSync），vitest 结束后由 OS tmp 清理；meta/configs
// 打开句柄进程退出即释放（与 routes.test.ts 同口径）。
