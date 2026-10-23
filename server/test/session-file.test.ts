// 任务 16（docs08-2026-10-22-batch）：首载尾窗直读与向上翻页
// - session-file.ts 反向分块直读：尾窗形状 / 短会话 / 空会话 / 恰窗 / 残行丢弃
//   / 跨块长行 / before 翻页拼缝零重复零丢失 / cursor_invalid
// - 路由：无 cursor 走直读、?before= 409、?cursor= 与 ?full=1 走引擎、
//   fake 网关（无 sessionPath）回退引擎
import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  OVERLAP,
  PAGE_LIMIT,
  TAIL_WINDOW,
  CursorInvalidError,
  readEntriesBefore,
  readTailEntries,
} from "../src/adapter/session-file";
import type { EngineMessagesPage, EngineSessionSummary } from "../src/adapter/engine-adapter";
import type { EngineGateway } from "../src/api/engine-runtime";
import { createSessionRoutes } from "../src/api/routes-session";
import { openMetaDb } from "../src/db/meta";
import { openConfigStore } from "../src/conf/config-store";
import { createProjectConfigStores } from "../src/api/config-migration";

// 临时目录登记与统一清理（终验微修）：测试结束后 /tmp 零 t16-* 残留
const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function line(i: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "message",
    id: `e${String(i).padStart(5, "0")}`,
    parentId: i === 0 ? null : `e${String(i - 1).padStart(5, "0")}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
    message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `m${i}` }] },
    ...extra,
  });
}

function header(id: string): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/p" });
}

function makeSessionFile(n: number, opts?: { trailingPartial?: boolean; id?: string }): string {
  const dir = mkTemp("t16-session-");
  const path = join(dir, "s.jsonl");
  const lines = [header(opts?.id ?? "hdr-1")];
  for (let i = 0; i < n; i++) lines.push(line(i));
  let content = lines.join("\n") + "\n";
  if (opts?.trailingPartial) content += '{"type":"message","id":"partial';
  writeFileSync(path, content);
  return path;
}

// ---------------------------------------------------------------- session-file

describe("readTailEntries 尾窗直读", () => {
  test("大会话：返回最新 PAGE_LIMIT 条，文件序，hasMore=true，oldestId/leafId 正确", async () => {
    const path = makeSessionFile(2000);
    const page = await readTailEntries(path);
    expect(page.entries).toHaveLength(PAGE_LIMIT);
    expect(page.entries[0]!.id).toBe("e01784"); // 2000-216
    expect(page.entries.at(-1)!.id).toBe("e01999");
    expect(page.hasMore).toBe(true);
    expect(page.oldestId).toBe("e01784");
    expect(page.leafId).toBe("e01999");
    // 文件序（旧→新）
    expect(page.entries.map((e) => e.id)).toEqual(
      [...page.entries].sort((a, b) => a.id.localeCompare(b.id)).map((e) => e.id),
    );
  });

  test("短会话（< 窗口）：全量返回，hasMore=false", async () => {
    const path = makeSessionFile(50);
    const page = await readTailEntries(path);
    expect(page.entries).toHaveLength(50);
    expect(page.entries[0].id).toBe("e00000");
    expect(page.hasMore).toBe(false);
    expect(page.leafId).toBe("e00049");
  });

  test("恰好窗口大小：hasMore=false（不多报翻页游标）", async () => {
    const path = makeSessionFile(PAGE_LIMIT);
    const page = await readTailEntries(path);
    expect(page.entries).toHaveLength(PAGE_LIMIT);
    expect(page.hasMore).toBe(false);
    expect(page.oldestId).toBe("e00000");
  });

  test("空会话（仅 header）：空窗，oldestId/leafId 为 null", async () => {
    const path = makeSessionFile(0);
    const page = await readTailEntries(path);
    expect(page.entries).toEqual([]);
    expect(page.oldestId).toBeNull();
    expect(page.leafId).toBeNull();
    expect(page.hasMore).toBe(false);
  });

  test("末尾残缺行（写入中）丢弃不崩", async () => {
    const path = makeSessionFile(10, { trailingPartial: true });
    const page = await readTailEntries(path);
    expect(page.entries).toHaveLength(10);
    expect(page.leafId).toBe("e00009");
  });

  test("超 64KB 大条目跨块解析不丢", async () => {
    const dir = mkTemp("t16-session-");
    const path = join(dir, "s.jsonl");
    const big = "x".repeat(200 * 1024);
    const lines = [header("h")];
    for (let i = 0; i < 5; i++) {
      lines.push(
        JSON.stringify({
          type: "message",
          id: `big${i}`,
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: big }] },
        }),
      );
    }
    writeFileSync(path, lines.join("\n") + "\n");
    const page = await readTailEntries(path);
    expect(page.entries).toHaveLength(5);
    expect((page.entries[0].message as { content: Array<{ text: string }> }).content[0].text).toBe(big);
  });

  test("常量契约：窗口 200 + 重叠 16 = 单窗上限", () => {
    expect(TAIL_WINDOW).toBe(200);
    expect(OVERLAP).toBe(16);
    expect(PAGE_LIMIT).toBe(216);
  });
});

describe("readEntriesBefore 上一窗与拼缝", () => {
  test("翻页零重复零丢失：两窗按 id 去重并集 = 文件精确前缀", async () => {
    const n = 600;
    const path = makeSessionFile(n);
    const w1 = await readTailEntries(path);
    expect(w1.hasMore).toBe(true);
    const w2 = await readEntriesBefore(path, w1.oldestId!);
    // w2 含重叠锚（oldestId 自身）与更早条目
    expect(w2.entries.at(-1)!.id).toBe(w1.oldestId);
    const w2New = w2.entries.filter((e) => e.id !== w1.oldestId);
    // 去重并集恰好是文件前缀，无重复无缺口
    const union = [...w2New, ...w1.entries].map((e) => e.id);
    expect(new Set(union).size).toBe(union.length);
    // 两窗并集恰为文件连续区间 [600-431, 600)：无重复无缺口
    expect(union).toEqual(
      Array.from({ length: union.length }, (_, i) => `e${String(i + 169).padStart(5, "0")}`),
    );
    expect(w2.hasMore).toBe(true);
    expect(w2.oldestId).toBe(w2.entries[0].id);
  });

  test("翻到文件头：hasMore=false，窗口不足额", async () => {
    const path = makeSessionFile(300);
    const w1 = await readTailEntries(path);
    const w2 = await readEntriesBefore(path, w1.oldestId!);
    expect(w2.entries[0].id).toBe("e00000");
    expect(w2.hasMore).toBe(false);
  });

  test("无效 before：CursorInvalidError（路由转 409）", async () => {
    const path = makeSessionFile(10);
    await expect(readEntriesBefore(path, "nonexistent")).rejects.toBeInstanceOf(CursorInvalidError);
  });
});

// ---------------------------------------------------------------- 路由

class TailFakeGateway implements EngineGateway {
  testid = "tail-fake";
  engineCalls = 0;
  constructor(
    private readonly sessions: EngineSessionSummary[],
    private readonly page: EngineMessagesPage = { entries: [], leafId: "leaf-1", cursor: "leaf-1" },
  ) {}
  async sessionsList(): Promise<EngineSessionSummary[]> {
    return this.sessions;
  }
  async createSession(): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    throw new Error("not used");
  }
  async sessionPath(id: string): Promise<string> {
    const row = this.sessions.find((r) => r.id === id);
    if (!row) throw new Error("session_not_found");
    return row.path;
  }
  async messages(): Promise<EngineMessagesPage> {
    this.engineCalls++;
    return this.page;
  }
  async prompt(): Promise<{ disposition: string }> {
    throw new Error("not used");
  }
  async queueList() {
    return { steering: [], followUp: [], ordered: [] };
  }
  async queueClear() {
    return { steering: [], followUp: [], ordered: [] };
  }
  async abort(): Promise<void> {}
  async permissionRespond(): Promise<void> {}
  async questionsList(): Promise<never[]> {
    return [];
  }
  async usage(): Promise<never> {
    throw new Error("not used");
  }
  async modelsList(): Promise<never[]> {
    return [];
  }
  async commandsList(): Promise<null> {
    return null;
  }
  async deleteSession(): Promise<{ sessionPath: string; fileExisted: boolean }> {
    return { sessionPath: "", fileExisted: false };
  }
  async exportSessionHtml(): Promise<{ html: string; row: EngineSessionSummary }> {
    throw new Error("not used");
  }
  async forkSession(): Promise<never> {
    throw new Error("not used");
  }
  async peekActiveSessionPaths(): Promise<null> {
    return null;
  }
  async restartProject(): Promise<void> {}
  async stopAll(): Promise<void> {}
  listProjects(): string[] {
    return ["/p"];
  }
}

function row(id: string, path: string): EngineSessionSummary {
  return {
    path,
    id,
    cwd: "/p",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
  };
}

function buildApp(engines: EngineGateway): Hono {
  const meta = openMetaDb({ path: join(mkTemp("t16-meta-"), "meta.db") });
  const configs = openConfigStore({ globalDir: join(mkTemp("t16-cfg-"), "global") });
  const app = new Hono();
  app.route("/", createSessionRoutes({ meta, engines, configs, projectConfigs: createProjectConfigStores(configs) }));
  return app;
}

describe("GET messages 尾窗直读路由", () => {
  test("无 cursor：直读尾窗返回 hasMore/oldestId，不走引擎", async () => {
    const path = makeSessionFile(500);
    const engines = new TailFakeGateway([row("s1", path)]);
    const app = buildApp(engines);
    const res = await app.request("/api/sessions/s1/messages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ id: string }>;
      hasMore: boolean;
      oldestId: string | null;
      cursor: string | null;
      leafId: string | null;
    };
    expect(body.entries).toHaveLength(PAGE_LIMIT);
    expect(body.hasMore).toBe(true);
    expect(body.oldestId).toBe("e00284");
    expect(body.cursor).toBe("e00499");
    expect(engines.engineCalls).toBe(0);
  });

  test("?before= 上一窗；无效 before 409 cursor_invalid", async () => {
    const path = makeSessionFile(500);
    const engines = new TailFakeGateway([row("s1", path)]);
    const app = buildApp(engines);
    const res = await app.request("/api/sessions/s1/messages?before=e00284");
    const body = (await res.json()) as { entries: Array<{ id: string }>; hasMore: boolean };
    expect(res.status).toBe(200);
    expect(body.entries.at(-1)!.id).toBe("e00284");
    expect(body.entries).toHaveLength(PAGE_LIMIT);

    const bad = await app.request("/api/sessions/s1/messages?before=nonexistent");
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("cursor_invalid");
  });

  test("?cursor= 与 ?full=1 走引擎全量（SSE gap 对账不被尾窗截断）", async () => {
    const path = makeSessionFile(500);
    const engines = new TailFakeGateway([row("s1", path)], {
      entries: [{ type: "message", id: "a", parentId: null, timestamp: "t" }],
      leafId: "a",
      cursor: "a",
    });
    const app = buildApp(engines);
    const incr = await app.request("/api/sessions/s1/messages?cursor=e00499");
    expect(((await incr.json()) as { hasMore: boolean }).hasMore).toBe(false);
    const full = await app.request("/api/sessions/s1/messages?full=1");
    const fullBody = (await full.json()) as { entries: Array<{ id: string }>; hasMore: boolean };
    expect(fullBody.entries.map((e) => e.id)).toEqual(["a"]);
    expect(fullBody.hasMore).toBe(false);
    expect(engines.engineCalls).toBe(2);
  });

  test("会话无文件（未落盘/别名）：回退引擎全量", async () => {
    const dir = mkTemp("t16-empty-");
    const engines = new TailFakeGateway([row("s1", join(dir, "missing.jsonl"))], {
      entries: [{ type: "message", id: "x", parentId: null, timestamp: "t" }],
      leafId: "x",
      cursor: "x",
    });
    const app = buildApp(engines);
    const res = await app.request("/api/sessions/s1/messages");
    const body = (await res.json()) as { entries: Array<{ id: string }>; hasMore: boolean };
    expect(res.status).toBe(200);
    expect(body.entries.map((e) => e.id)).toEqual(["x"]);
    expect(body.hasMore).toBe(false);
    expect(engines.engineCalls).toBe(1);
  });
});
