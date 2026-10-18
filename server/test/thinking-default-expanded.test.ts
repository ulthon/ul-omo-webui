// 设置 kv 落库断言（docs08-r5 任务 13）：PUT /api/settings 写 chat.thinkingDefaultExpanded
// 进 meta_kv（跨设备口径：任何设备 GET /api/settings 回读同值），覆盖翻转与非字符串值
// 400 一并锁定。settings 路由不触引擎（FakeGateway 误用以异常暴露）。全部 mkdtemp 隔离，
// 绝不触碰真实元数据库。
import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { EngineGateway } from "../src/api/engine-runtime";
import type {
  EngineMessagesPage,
  EngineModelInfo,
  EnginePermissionReply,
  EngineQuestionFrame,
  EnginePromptInput,
  EngineQueueSnapshot,
  EngineSessionSummary,
  EngineThinkingLevel,
  EngineUsageStats,
} from "../src/adapter/engine-adapter";
import { openMetaDb } from "../src/db/meta";
import { createMetaRoutes } from "../src/api/routes-meta";

// web 端常量（web/src/stores/ui.ts THINKING_EXPANDED_KV）的镜像：服务端 kv 不感知键语义
const THINKING_EXPANDED_KV = "chat.thinkingDefaultExpanded";

/** settings 路由自身不触引擎（误用以异常暴露）。 */
class FakeGateway implements EngineGateway {
  listProjectPaths(): string[] {
    return [];
  }
  async sessionsList(): Promise<EngineSessionSummary[]> {
    throw new Error("settings routes must not list sessions");
  }
  async peekActiveSessionPaths(): Promise<string[] | null> {
    return null;
  }
  async createSession(): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    throw new Error("settings routes must not create sessions");
  }
  async messages(): Promise<EngineMessagesPage> {
    throw new Error("settings routes must not read messages");
  }
  async prompt(): Promise<{ disposition: string }> {
    throw new Error("settings routes must not prompt");
  }
  async abort(): Promise<void> {}
  async queueList(): Promise<EngineQueueSnapshot> {
    throw new Error("settings routes must not touch queue");
  }
  async queueClear(): Promise<EngineQueueSnapshot> {
    throw new Error("settings routes must not touch queue");
  }
  async permissionRespond(): Promise<void> {}
  async questionsList(): Promise<EngineQuestionFrame[]> {
    return [];
  }
  async usage(): Promise<EngineUsageStats> {
    throw new Error("settings routes must not read usage");
  }
  async modelsList(): Promise<EngineModelInfo[]> {
    throw new Error("settings routes must not list models");
  }
  async deleteSession(): Promise<{ sessionPath: string; fileExisted: boolean }> {
    throw new Error("settings routes must not delete sessions");
  }
  async exportSessionHtml(): Promise<{ html: string; row: EngineSessionSummary }> {
    throw new Error("settings routes must not export");
  }
  async forkSession(): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }> {
    throw new Error("settings routes must not fork");
  }
  async restartProject(): Promise<void> {}
  async stopAll(): Promise<void> {}
}

const tmp = mkdtempSync(join(tmpdir(), "senpi-thinking-kv-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function setup() {
  const caseDir = mkdtempSync(join(tmp, "case-"));
  const meta = openMetaDb({ path: join(caseDir, "meta.db") });
  const app = new Hono();
  app.route("/", createMetaRoutes({ meta, engines: new FakeGateway() }));
  return { app, meta };
}

const putSettings = (app: Hono, body: unknown) =>
  app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("思考块默认展开设置 meta_kv 落库", () => {
  test("PUT 写入 meta_kv 且 GET 回读一致（跨设备口径）；翻转覆盖；非字符串 400", async () => {
    const { app, meta } = setup();
    expect(meta.getKv(THINKING_EXPANDED_KV)).toBeNull();

    // 开启：PUT → meta_kv 落库 → GET 回读
    const putOn = await putSettings(app, { [THINKING_EXPANDED_KV]: "true" });
    expect(putOn.status).toBe(200);
    expect(meta.getKv(THINKING_EXPANDED_KV)).toBe("true");
    const getOn = await app.request("/api/settings");
    expect(((await getOn.json()) as { settings: Record<string, string> }).settings[THINKING_EXPANDED_KV]).toBe("true");

    // 关闭：覆盖写
    const putOff = await putSettings(app, { [THINKING_EXPANDED_KV]: "false" });
    expect(putOff.status).toBe(200);
    expect(meta.getKv(THINKING_EXPANDED_KV)).toBe("false");
    const getOff = await app.request("/api/settings");
    expect(((await getOff.json()) as { settings: Record<string, string> }).settings[THINKING_EXPANDED_KV]).toBe("false");

    // 非字符串值拒绝（设置值必须是字符串）
    const bad = await putSettings(app, { [THINKING_EXPANDED_KV]: true });
    expect(bad.status).toBe(400);

    meta.close();
  });

  test("其他键共存：PUT 只写目标键，sidebar 等既有 kv 不受影响", async () => {
    const { app, meta } = setup();
    meta.setKv("sidebar.projectSort", "manual");
    const res = await putSettings(app, { [THINKING_EXPANDED_KV]: "true" });
    expect(res.status).toBe(200);
    expect(meta.getKv(THINKING_EXPANDED_KV)).toBe("true");
    expect(meta.getKv("sidebar.projectSort")).toBe("manual");
    meta.close();
  });
});
