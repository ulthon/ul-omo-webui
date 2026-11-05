// 任务 16（docs08-2026-10-22-batch）：首载尾窗直读与向上翻页
// - session-file.ts 反向分块直读：尾窗形状 / 短会话 / 空会话 / 恰窗 / 残行丢弃
//   / 跨块长行 / before 翻页拼缝零重复零丢失 / cursor_invalid
// - 任务 5（engine-open-read-batch A-2）：reverseScan 字节上限（≥8MiB 截停至少保
//   1 条）/ readAllEntries 正向流式全量 / full=1 磁盘优先（引擎零参与）/ ?cursor=
//   游标失效 409 cursor_invalid（客户端升级 full=1 分层闭环）/ fake 网关（无
//   sessionPath）回退引擎
import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  OVERLAP,
  PAGE_LIMIT,
  TAIL_WINDOW,
  WINDOW_BYTE_CAP,
  CursorInvalidError,
  readAllEntries,
  readEntriesBefore,
  readTailEntries,
} from "../src/adapter/session-file";
import { EngineAdapterError } from "../src/adapter/engine-adapter";
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
  /** 注入面：messages() 抛出该错误（模拟引擎游标失效上抛） */
  messagesError?: Error;
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
    if (this.messagesError) throw this.messagesError;
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

  test("?cursor= 走引擎；?full=1 磁盘正向全量（引擎零参与）", async () => {
    const path = makeSessionFile(500);
    const engines = new TailFakeGateway([row("s1", path)], {
      entries: [{ type: "message", id: "a", parentId: null, timestamp: "t" }],
      leafId: "a",
      cursor: "a",
    });
    const app = buildApp(engines);
    const incr = await app.request("/api/sessions/s1/messages?cursor=e00499");
    expect(((await incr.json()) as { hasMore: boolean }).hasMore).toBe(false);
    expect(engines.engineCalls).toBe(1);
    const full = await app.request("/api/sessions/s1/messages?full=1");
    const fullBody = (await full.json()) as {
      entries: Array<{ id: string }>;
      hasMore: boolean;
      leafId: string | null;
      oldestId: string | null;
    };
    expect(full.status).toBe(200);
    // 磁盘全量：全部 500 条文件序，头尾 id 正确（SSE gap 对账不被尾窗截断）
    expect(fullBody.entries).toHaveLength(500);
    expect(fullBody.entries[0]!.id).toBe("e00000");
    expect(fullBody.entries.at(-1)!.id).toBe("e00499");
    expect(fullBody.leafId).toBe("e00499");
    expect(fullBody.oldestId).toBe("e00000");
    expect(fullBody.hasMore).toBe(false);
    // full=1 引擎零参与（误导性成功输出防线：计数器断言而非仅无错）
    expect(engines.engineCalls).toBe(1);
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

// ------------------------------------------------- reverseScan 字节上限（任务 5）

/** 大条目会话文件：count 条 × bytesPerEntry 文本载荷（每行实际字节数略多） */
function makeFatSessionFile(count: number, bytesPerEntry: number): { path: string; ids: string[] } {
  const dir = mkTemp("t16-fat-");
  const path = join(dir, "s.jsonl");
  const ids: string[] = [];
  const parts = [header("hdr-fat")];
  for (let i = 0; i < count; i++) {
    const id = `fat${String(i).padStart(4, "0")}`;
    ids.push(id);
    parts.push(
      JSON.stringify({
        type: "message",
        id,
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "x".repeat(bytesPerEntry) }] },
      }),
    );
  }
  writeFileSync(path, parts.join("\n") + "\n");
  return { path, ids };
}

describe("reverseScan 字节上限（≥8MiB 截停）", () => {
  test("尾窗字节截停：条数未达 PAGE_LIMIT 即停，形态与条数截停同形（hasMore/oldestId）", async () => {
    // 30 条 × ~300KB ≈ 9MB：条数远小于 216，字节先到
    const { path, ids } = makeFatSessionFile(30, 300 * 1024);
    const page = await readTailEntries(path);
    expect(page.entries.length).toBeGreaterThanOrEqual(1);
    expect(page.entries.length).toBeLessThan(30);
    // 尾部对齐（最新条目必在窗内）+ 文件序 + 形态与条数截停同形
    expect(page.entries.at(-1)!.id).toBe(ids.at(-1));
    expect(page.leafId).toBe(ids.at(-1));
    expect(page.hasMore).toBe(true);
    expect(page.oldestId).toBe(page.entries[0]!.id);
    expect(page.entries.map((e) => e.id)).toEqual(
      [...page.entries].sort((a, b) => a.id.localeCompare(b.id)).map((e) => e.id),
    );
    // 窗内字节数受 8MiB 上限约束（余量 = 单条超限容忍）
    const bytes = page.entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);
    expect(bytes).toBeLessThanOrEqual(WINDOW_BYTE_CAP + 301 * 1024);
  });

  test("字节截停后 before 翻页拼缝零丢失：两窗并集 = 全文件，末窗不误报翻页", async () => {
    const { path, ids } = makeFatSessionFile(30, 300 * 1024);
    const w1 = await readTailEntries(path);
    expect(w1.hasMore).toBe(true);
    const w2 = await readEntriesBefore(path, w1.oldestId!);
    // 含重叠锚
    expect(w2.entries.at(-1)!.id).toBe(w1.oldestId);
    const union = [...w2.entries, ...w1.entries.filter((e) => e.id !== w1.oldestId)].map((e) => e.id);
    expect([...new Set(union)]).toEqual(ids);
    // 扫尽文件头不误报（剩余仅 header 行不算条目）
    expect(w2.hasMore).toBe(false);
  });

  test("单条超 8MiB：至少保 1 条完整交付，不误报翻页", async () => {
    const { path } = makeFatSessionFile(1, 9 * 1024 * 1024);
    const page = await readTailEntries(path);
    expect(page.entries).toHaveLength(1);
    expect(page.leafId).toBe("fat0000");
    expect(page.oldestId).toBe("fat0000");
    expect(page.hasMore).toBe(false);
  });
});

// ------------------------------------------------- readAllEntries 正向流式全量（任务 5）

describe("readAllEntries 正向流式全量", () => {
  test("全量文件序返回，header 不计，leafId = 最后条目", async () => {
    const path = makeSessionFile(50);
    const all = await readAllEntries(path);
    expect(all.entries).toHaveLength(50);
    expect(all.entries[0]!.id).toBe("e00000");
    expect(all.entries.at(-1)!.id).toBe("e00049");
    expect(all.leafId).toBe("e00049");
  });

  test("空会话（仅 header）：entries 空、leafId null", async () => {
    const path = makeSessionFile(0);
    const all = await readAllEntries(path);
    expect(all.entries).toEqual([]);
    expect(all.leafId).toBeNull();
  });

  test("损坏行跳过不崩 + 末尾残行丢弃（与 reverseScan 同约定）", async () => {
    const dir = mkTemp("t16-fwd-");
    const path = join(dir, "s.jsonl");
    const lines = [header("h"), line(0), "not json {{{", line(1)];
    writeFileSync(path, lines.join("\n") + "\n" + '{"type":"message","id":"partial');
    const all = await readAllEntries(path);
    expect(all.entries.map((e) => e.id)).toEqual(["e00000", "e00001"]);
    expect(all.leafId).toBe("e00001");
  });

  test("多 chunk 大文件（约 18MB，跨 64KB 分块与长行边界）全量不丢不重", async () => {
    const dir = mkTemp("t16-fwd-big-");
    const path = join(dir, "s.jsonl");
    const count = 300;
    const per = 60 * 1024;
    const parts = [header("h-big")];
    for (let i = 0; i < count; i++) {
      parts.push(
        JSON.stringify({
          type: "message",
          id: `big${String(i).padStart(4, "0")}`,
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "y".repeat(per) }] },
        }),
      );
    }
    writeFileSync(path, parts.join("\n") + "\n");
    // 300 × 60KB 文本 + JSON 包裹 ≈ 17.6MB：远超 64KB 分块与单窗 8MiB 字节上限
    expect(statSync(path).size).toBeGreaterThan(17 * 1024 * 1024);
    const all = await readAllEntries(path);
    expect(all.entries).toHaveLength(count);
    expect(all.entries[0]!.id).toBe("big0000");
    expect(all.entries.at(-1)!.id).toBe("big0299");
    expect(all.leafId).toBe("big0299");
    // 长行内容跨块完整性拙验（首末两条）
    const first = (all.entries[0]!.message as { content: Array<{ text: string }> }).content[0]!.text;
    expect(first.length).toBe(per);
  });
});

// ------------------------------------------------- full=1 磁盘优先路由（任务 5）

describe("GET messages full=1 磁盘优先与游标失效 409", () => {
  test("full=1 大文件（约 18MB）磁盘正向全量：引擎调用计数 === 0", async () => {
    // 300 条 × 60KB ≈ 18MB：超过单窗 8MiB 字节上限与 64KB 分块，证明真流式全量
    const dir = mkTemp("t16-route-big-");
    const path = join(dir, "s.jsonl");
    const parts = [header("h-route")];
    for (let i = 0; i < 300; i++) {
      parts.push(
        JSON.stringify({
          type: "message",
          id: `big${String(i).padStart(4, "0")}`,
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "y".repeat(60 * 1024) }] },
        }),
      );
    }
    writeFileSync(path, parts.join("\n") + "\n");
    const engines = new TailFakeGateway([row("s1", path)], { entries: [], leafId: null, cursor: null });
    const app = buildApp(engines);
    const res = await app.request("/api/sessions/s1/messages?full=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ id: string }>;
      hasMore: boolean;
      leafId: string | null;
    };
    expect(body.entries).toHaveLength(300);
    expect(body.entries[0]!.id).toBe("big0000");
    expect(body.entries.at(-1)!.id).toBe("big0299");
    expect(body.leafId).toBe("big0299");
    expect(body.hasMore).toBe(false);
    // 误导性成功输出防线：引擎 RPC 调用计数严格为 0（计数器而非仅无错）
    expect(engines.engineCalls).toBe(0);
  });

  test("full=1 文件缺失（未落盘/别名）：回退引擎分页循环", async () => {
    const dir = mkTemp("t16-route-nofile-");
    const engines = new TailFakeGateway([row("s1", join(dir, "missing.jsonl"))], {
      entries: [{ type: "message", id: "x", parentId: null, timestamp: "t" }],
      leafId: "x",
      cursor: "x",
    });
    const app = buildApp(engines);
    const res = await app.request("/api/sessions/s1/messages?full=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ id: string }> };
    expect(body.entries.map((e) => e.id)).toEqual(["x"]);
    expect(engines.engineCalls).toBe(1);
  });

  test("?cursor= 游标失效：409 cursor_invalid，客户端升级 full=1 后磁盘全量成功", async () => {
    const path = makeSessionFile(5);
    const engines = new TailFakeGateway([row("s1", path)]);
    engines.messagesError = new EngineAdapterError("cursor_invalid", "增量游标已失效");
    const app = buildApp(engines);
    const bad = await app.request("/api/sessions/s1/messages?cursor=stale");
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("cursor_invalid");
    // 升级链路服务端侧就绪：同会话 full=1 走磁盘成功（不再触发引擎）
    const full = await app.request("/api/sessions/s1/messages?full=1");
    expect(full.status).toBe(200);
    expect(((await full.json()) as { entries: unknown[] }).entries).toHaveLength(5);
    expect(engines.engineCalls).toBe(1);
  });
});
