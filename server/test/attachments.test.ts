// 附件临时区单测（docs08-r3 任务 17：大文本粘贴转附件）：
// - POST 安全矩阵：name 注入（路径分隔符 / ".."）400、1MB 上限、落点复核
// - DELETE 安全矩阵：本项目内 ok、其他项目临时文件 403、临时区外路径 403、
//   符号链接逃逸 403、不存在 404
// - 启动清理：49h 删 / 47h 留、非临时区文件不动
import { describe, expect, test } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  ATTACHMENT_MAX_AGE_MS,
  ATTACHMENT_MAX_BYTES,
  projectAttachmentsDir,
  projectAttachmentsHash,
  purgeStaleAttachments,
} from "../src/api/attachments";
import type { EngineGateway } from "../src/api/engine-runtime";
import { createSessionRoutes } from "../src/api/routes-session";
import { openMetaDb } from "../src/db/meta";
import type {
  EngineMessagesPage,
  EngineModelInfo,
  EnginePermissionReply,
  EngineQuestionFrame,
  EngineSessionSummary,
  EngineThinkingLevel,
  EngineUsageStats,
  EngineQueueSnapshot,
} from "../src/adapter/engine-adapter";
import type { ApiError as ApiErrorClass } from "../src/api/http";

// ---------------------------------------------------------------- fake gateway

class FakeGateway implements EngineGateway {
  sessions = new Map<string, EngineSessionSummary>();

  /** 端点经结构能力探测调用（SessionRowGateway），返回会话所属项目（cwd） */
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
  async permissionRespond(_id: string, _requestId: string, _reply: EnginePermissionReply): Promise<void> {}
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

const PROJECT_A = "/tmp/opencode/att-project-a";
const PROJECT_B = "/tmp/opencode/att-project-b";

function summary(id: string, cwd: string): EngineSessionSummary {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
  };
}

function buildApp(engines: FakeGateway, root: string) {
  const meta = openMetaDb({ path: join(mkdtempSync(join(tmpdir(), "att-meta-")), "meta.db") });
  const app = new Hono();
  app.route("/", createSessionRoutes({ meta, engines, attachmentsRoot: root }));
  return app;
}

const req = (app: Hono, path: string, init?: RequestInit) => app.request(path, init);

// ---------------------------------------------------------------- POST

describe("POST /api/sessions/:id/attachments", () => {
  test("happy：写入临时区、响应绝对路径、文件内容一致", async () => {
    const root = mkdtempSync(join(tmpdir(), "att-root-"));
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", summary("s1", PROJECT_A));
    const app = buildApp(gateway, root);

    const res = await req(app, "/api/sessions/s1/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "大段文本内容", name: "notes.txt" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string; name: string; bytes: number };
    expect(body.name).toBe("notes.txt");
    expect(body.bytes).toBe(Buffer.byteLength("大段文本内容", "utf8"));
    expect(body.path.startsWith(projectAttachmentsDir(root, PROJECT_A) + "/")).toBe(true);
    expect(readFileSync(body.path, "utf8")).toBe("大段文本内容");
    rmSync(root, { recursive: true, force: true });
  });

  test("name 注入矩阵：含 / 或 \\ 或 .. 一律 400（评审钉死口径 a）", async () => {
    const root = mkdtempSync(join(tmpdir(), "att-root-"));
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", summary("s1", PROJECT_A));
    const app = buildApp(gateway, root);

    for (const name of ["../evil.txt", "a/b.txt", "a\\b.txt", "..", "foo/../bar", "..\\evil", "x..y"]) {
      const res = await req(app, "/api/sessions/s1/attachments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "x", name }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_name");
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("name 缺省：服务端自生成 .txt 文件名", async () => {
    const root = mkdtempSync(join(tmpdir(), "att-root-"));
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", summary("s1", PROJECT_A));
    const app = buildApp(gateway, root);

    const res = await req(app, "/api/sessions/s1/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string };
    expect(body.name.endsWith(".txt")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("上限：恰好 1MB 通过，1MB+1 字节 400（content_too_large）", async () => {
    const root = mkdtempSync(join(tmpdir(), "att-root-"));
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", summary("s1", PROJECT_A));
    const app = buildApp(gateway, root);

    const exactly = "a".repeat(ATTACHMENT_MAX_BYTES);
    const ok = await req(app, "/api/sessions/s1/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: exactly }),
    });
    expect(ok.status).toBe(201);

    const over = await req(app, "/api/sessions/s1/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "a".repeat(ATTACHMENT_MAX_BYTES + 1) }),
    });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("content_too_large");
    rmSync(root, { recursive: true, force: true });
  });

  test("畸形载荷：content 非字符串/空串 400；多字节按 UTF-8 字节计上限", async () => {
    const root = mkdtempSync(join(tmpdir(), "att-root-"));
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", summary("s1", PROJECT_A));
    const app = buildApp(gateway, root);

    for (const content of [null, 42, "", [], {}]) {
      const res = await req(app, "/api/sessions/s1/attachments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      expect(res.status).toBe(400);
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("会话不存在（gateway 无 resolveSessionRow / 查无此会话）→ 404", async () => {
    const root = mkdtempSync(join(tmpdir(), "att-root-"));
    const app = buildApp(new FakeGateway(), root);
    const res = await req(app, "/api/sessions/nope/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
    rmSync(root, { recursive: true, force: true });
  });

  test("落点复核：临时区内预置同名符号链接劫持写入 → 403 且链接本体被清理", async () => {
    const root = mkdtempSync(join(tmpdir(), "att-root-"));
    const outside = mkdtempSync(join(tmpdir(), "att-outside-"));
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", summary("s1", PROJECT_A));
    const app = buildApp(gateway, root);

    const dir = projectAttachmentsDir(root, PROJECT_A);
    mkdirSync(dir, { recursive: true });
    const bait = join(dir, "bait.txt");
    symlinkSync(join(outside, "victim.txt"), bait);

    const res = await req(app, "/api/sessions/s1/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hijack", name: "bait.txt" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("attachment_escape");
    // 链接本体已被删除（unlink 不跟随符号链接），外部目标未被写入
    let baitExists = true;
    try {
      readFileSync(bait);
    } catch {
      baitExists = false;
    }
    expect(baitExists).toBe(false);
    let victimExists = true;
    try {
      readFileSync(join(outside, "victim.txt"));
    } catch {
      victimExists = false;
    }
    expect(victimExists).toBe(false);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- DELETE

describe("DELETE /api/sessions/:id/attachments", () => {
  function setup(): { app: Hono; root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "att-root-"));
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", summary("s1", PROJECT_A));
    gateway.sessions.set("s2", summary("s2", PROJECT_B));
    return { app: buildApp(gateway, root), root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  test("happy：删除本项目附件 → ok 且文件消失", async () => {
    const { app, root, cleanup } = setup();
    const dir = projectAttachmentsDir(root, PROJECT_A);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "mine.txt");
    writeFileSync(file, "x");

    const res = await req(app, `/api/sessions/s1/attachments?path=${encodeURIComponent(file)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    let exists = true;
    try {
      readFileSync(file);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
    cleanup();
  });

  test("越界矩阵一律 403：其他项目临时文件、临时区外路径、目录本身", async () => {
    const { app, root, cleanup } = setup();
    const dirA = projectAttachmentsDir(root, PROJECT_A);
    const dirB = projectAttachmentsDir(root, PROJECT_B);
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const otherProject = join(dirB, "theirs.txt");
    const outside = join(mkdtempSync(join(tmpdir(), "att-out-")), "outside.txt");
    writeFileSync(otherProject, "x");
    writeFileSync(outside, "x");

    for (const path of [otherProject, outside, root, dirA]) {
      const res = await req(app, `/api/sessions/s1/attachments?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("attachment_escape");
    }
    // 被拒目标原样存在
    expect(readFileSync(otherProject, "utf8")).toBe("x");
    expect(readFileSync(outside, "utf8")).toBe("x");
    rmSync(outside, { recursive: true, force: true });
    cleanup();
  });

  test("符号链接逃逸：realpath 指向临时区外 → 403", async () => {
    const { app, root, cleanup } = setup();
    const outside = mkdtempSync(join(tmpdir(), "att-out-"));
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "keep");
    const dir = projectAttachmentsDir(root, PROJECT_A);
    mkdirSync(dir, { recursive: true });
    const link = join(dir, "link.txt");
    symlinkSync(victim, link);

    const res = await req(app, `/api/sessions/s1/attachments?path=${encodeURIComponent(link)}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(readFileSync(victim, "utf8")).toBe("keep"); // 真身未被删
    rmSync(outside, { recursive: true, force: true });
    cleanup();
  });

  test("目标不存在 → 404 attachment_not_found；path 参数缺失 → 400", async () => {
    const { app, root, cleanup } = setup();
    const missing = await req(app, `/api/sessions/s1/attachments?path=${encodeURIComponent("/nonexistent/x.txt")}`, {
      method: "DELETE",
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("attachment_not_found");

    const noParam = await req(app, "/api/sessions/s1/attachments", { method: "DELETE" });
    expect(noParam.status).toBe(400);
    cleanup();
  });
});

// ---------------------------------------------------------------- 启动清理

describe("purgeStaleAttachments（启动清理挂点）", () => {
  test("49h 文件删除、47h 保留、目录与非文件跳过、root 不存在返回 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "att-purge-"));
    const dirA = projectAttachmentsDir(root, PROJECT_A);
    mkdirSync(dirA, { recursive: true });
    const now = Date.now();
    const stale = join(dirA, "stale.txt");
    const fresh = join(dirA, "fresh.txt");
    writeFileSync(stale, "old");
    writeFileSync(fresh, "new");
    utimesSync(stale, new Date(now - ATTACHMENT_MAX_AGE_MS - 3600_000), new Date(now - ATTACHMENT_MAX_AGE_MS - 3600_000)); // 49h
    utimesSync(fresh, new Date(now - ATTACHMENT_MAX_AGE_MS + 3600_000), new Date(now - ATTACHMENT_MAX_AGE_MS + 3600_000)); // 47h

    const removed = purgeStaleAttachments(root, ATTACHMENT_MAX_AGE_MS, now);
    expect(removed).toBe(1);
    let staleExists = true;
    try {
      readFileSync(stale);
    } catch {
      staleExists = false;
    }
    expect(staleExists).toBe(false);
    expect(readFileSync(fresh, "utf8")).toBe("new");
    expect(purgeStaleAttachments(join(root, "nope"))).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("hash 稳定性与形态：同路径恒同值、16 hex", async () => {
    expect(projectAttachmentsHash(PROJECT_A)).toBe(projectAttachmentsHash(PROJECT_A));
    expect(projectAttachmentsHash(PROJECT_A)).not.toBe(projectAttachmentsHash(PROJECT_B));
    expect(projectAttachmentsHash(PROJECT_A)).toMatch(/^[0-9a-f]{16}$/);
  });
});
