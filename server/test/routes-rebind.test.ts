// 会话 rebind 路由测试（r10 todo 18 / GAP-15）：
// - scan：fixture 旧目录布局（编码目录 + JSONL）返回会话行；损坏 JSONL 计入 totalFiles
//   不入 sessions；目录不存在/空目录 → 空清单不崩；相对路径/根路径 → 400
// - import：文件移入当前项目编码目录（header cwd 重写、源文件消失、sidecars 迁移）、
//   SessionManager.list 口径可见；冲突/幂等/损坏逐会话 skipped 报告；非法输入 4xx
// 引擎语义对照：bundle chunk-7UNN3YHW.js rebindSessionFile/moveSessionFile（物理移动）。
import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { SessionManager } from "@code-yeongyu/senpi";
import { encodeCwdToSessionDirName } from "../src/adapter/senpi-adapter";
import { createRebindRoutes } from "../src/api/routes-rebind";
import { openMetaDb } from "../src/db/meta";
import type { EngineGateway } from "../src/api/engine-runtime";

// 最小 fake gateway：rebind 路由不触引擎面（纯磁盘操作），占位满足 ApiDeps 类型
function fakeGateway(): EngineGateway {
  return {
    async sessionsList() {
      return [];
    },
    async peekActiveSessionPaths() {
      return null;
    },
    async createSession() {
      throw new Error("not canned");
    },
    async messages() {
      return { entries: [], leafId: null, cursor: null };
    },
    async prompt() {
      return { disposition: "started" };
    },
    async queueList() {
      return { steering: [], followUp: [], ordered: [] };
    },
    async queueClear() {
      return { steering: [], followUp: [], ordered: [] };
    },
    async abort() {},
    async permissionRespond() {},
    async questionsList() {
      return [];
    },
    async usage() {
      throw new Error("not canned");
    },
    async modelsList() {
      return [];
    },
    async deleteSession(id: string) {
      return { sessionPath: id, fileExisted: false };
    },
    async exportSessionHtml(id: string) {
      throw new Error("not canned");
    },
    async forkSession(id: string) {
      throw new Error("not canned");
    },
    async restartProject() {},
    async commandsList() {
      return null;
    },
    async stopAll() {},
  };
}

/** 构造隔离环境：临时 agentDir（会话库根）+ 真实存在的当前项目目录 + 旧路径。
 *  旧路径刻意不建目录（仓库移动后旧目录不存在的常态场景）。 */
function setupFixture() {
  const agentDir = mkdtempSync(join(tmpdir(), "rebind-agent-"));
  const project = mkdtempSync(join(tmpdir(), "rebind-proj-"));
  const oldPath = "/data/projects/moved-away-repo"; // 不存在于磁盘
  const oldStoreDir = join(agentDir, "sessions", encodeCwdToSessionDirName(oldPath));
  const targetStoreDir = join(agentDir, "sessions", encodeCwdToSessionDirName(project));
  mkdirSync(oldStoreDir, { recursive: true });

  const meta = openMetaDb({ path: join(mkdtempSync(join(tmpdir(), "rebind-meta-")), "meta.db") });
  const app = new Hono();
  app.route("/", createRebindRoutes({ meta, engines: fakeGateway(), agentDir }));
  return { agentDir, project, oldPath, oldStoreDir, targetStoreDir, app };
}

/** 写一个真实形态的会话 JSONL（header + 2 条消息行），返回文件绝对路径 */
function writeSessionJsonl(
  dir: string,
  sessionId: string,
  opts: { cwd?: string; firstMessage?: string } = {},
): string {
  const path = join(dir, `${sessionId}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  const header = { type: "session", id: sessionId, timestamp: "2026-10-01T00:00:00.000Z", cwd: opts.cwd ?? "/any" };
  const e1 = {
    type: "message",
    id: `${sessionId}-e1`,
    parentId: null,
    timestamp: "2026-10-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: opts.firstMessage ?? "修复登录 bug" }] },
  };
  const e2 = {
    type: "message",
    id: `${sessionId}-e2`,
    parentId: `${sessionId}-e1`,
    timestamp: "2026-10-01T00:00:02.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
  };
  writeFileSync(path, [JSON.stringify(header), JSON.stringify(e1), JSON.stringify(e2)].join("\n") + "\n");
  return path;
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/sessions/rebind/scan", () => {
  test("旧目录布局返回会话行：id/首条消息/消息数/alreadyBound=false", async () => {
    const { app, oldStoreDir, project, oldPath } = setupFixture();
    writeSessionJsonl(oldStoreDir, "sess-a", { cwd: oldPath });
    writeSessionJsonl(oldStoreDir, "sess-b", { cwd: oldPath, firstMessage: "重构部署脚本" });
    const res = await post(app, "/api/sessions/rebind/scan", { project, oldPath });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.oldPath).toBe(oldPath);
    expect(body.totalFiles).toBe(2);
    expect(body.sessions).toHaveLength(2);
    const ids = body.sessions.map((s: { id: string }) => s.id).sort();
    expect(ids).toEqual(["sess-a", "sess-b"]);
    const rowA = body.sessions.find((s: { id: string }) => s.id === "sess-a");
    expect(rowA.firstMessage).toContain("修复登录 bug");
    expect(rowA.messageCount).toBe(2);
    expect(rowA.alreadyBound).toBe(false);
  });

  test("损坏 JSONL（首行非 session header）：不计入 sessions 但计入 totalFiles", async () => {
    const { app, oldStoreDir, project, oldPath } = setupFixture();
    writeSessionJsonl(oldStoreDir, "sess-ok", { cwd: oldPath });
    writeFileSync(join(oldStoreDir, "corrupt.jsonl"), "not-a-session-header\n{\"type\":\"message\"}\n");
    const body = await (await post(app, "/api/sessions/rebind/scan", { project, oldPath })).json();
    expect(body.totalFiles).toBe(2);
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["sess-ok"]);
  });

  test("旧目录编码目录不存在：空清单不崩（仓库移动后常态）", async () => {
    const { app, project } = setupFixture();
    const res = await post(app, "/api/sessions/rebind/scan", { project, oldPath: "/data/projects/never-existed" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions).toEqual([]);
    expect(body.totalFiles).toBe(0);
  });

  test("空编码目录：空清单不崩", async () => {
    const { app, project, oldPath } = setupFixture();
    const res = await post(app, "/api/sessions/rebind/scan", { project, oldPath });
    expect(res.status).toBe(200);
    expect((await res.json()).sessions).toEqual([]);
  });

  test("目标项目已存在同名文件：alreadyBound=true；oldPath 即当前项目时全部 alreadyBound", async () => {
    const { app, oldStoreDir, targetStoreDir, project, oldPath } = setupFixture();
    writeSessionJsonl(oldStoreDir, "sess-dup", { cwd: oldPath });
    writeSessionJsonl(targetStoreDir, "sess-dup", { cwd: project });
    const body = await (await post(app, "/api/sessions/rebind/scan", { project, oldPath })).json();
    expect(body.sessions.find((s: { id: string }) => s.id === "sess-dup").alreadyBound).toBe(true);

    // oldPath === 当前项目：编码目录即目标目录，全部 alreadyBound
    const self = await (await post(app, "/api/sessions/rebind/scan", { project, oldPath: project })).json();
    expect(self.sessions.length).toBeGreaterThan(0);
    expect(self.sessions.every((s: { alreadyBound: boolean }) => s.alreadyBound)).toBe(true);
  });

  test("非法输入：相对路径/非字符串/空串/根路径/缺 project/project 不存在 → 400 结构化错误", async () => {
    const { app, project, oldPath } = setupFixture();
    const cases: Array<Record<string, unknown>> = [
      { project, oldPath: "data/projects/rel" },
      { project, oldPath: "" },
      { project, oldPath: 123 },
      { project, oldPath: "/" },
      { oldPath },
      { project: "/data/projects/nope", oldPath },
    ];
    for (const body of cases) {
      const res = await post(app, "/api/sessions/rebind/scan", body);
      expect(res.status).toBe(400);
      const err = (await res.json()).error;
      expect(typeof err.code).toBe("string");
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});

describe("POST /api/sessions/rebind（导入）", () => {
  test("happy：会话移入当前项目编码目录，header cwd 重写、源消失、SessionManager.list 可见", async () => {
    const { app, oldStoreDir, targetStoreDir, project, oldPath } = setupFixture();
    const source = writeSessionJsonl(oldStoreDir, "sess-move", { cwd: oldPath });

    const res = await post(app, "/api/sessions/rebind", { project, oldPath, sessionIds: ["sess-move"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toHaveLength(1);
    expect(body.imported[0]).toMatchObject({ id: "sess-move", disposition: "moved" });
    expect(body.skipped).toEqual([]);

    // 物理移动：源文件消失，目标出现，header cwd 已重写为当前项目
    expect(existsSync(source)).toBe(false);
    const targetFile = join(targetStoreDir, "sess-move.jsonl");
    expect(existsSync(targetFile)).toBe(true);
    const firstLine = JSON.parse(readFileSync(targetFile, "utf-8").split("\n")[0]);
    expect(firstLine.cwd).toBe(project);
    expect(firstLine.id).toBe("sess-move");

    // 发现口径：SessionManager.list 在当前项目编码目录下能列出该会话（导入后即入列表）
    const rows = await SessionManager.list(project, targetStoreDir);
    expect(rows.map((r) => r.id)).toContain("sess-move");
  });

  test("sidecars 随迁：extensions 边车 JSON 与 resident-blobs 目录移入目标", async () => {
    const { app, oldStoreDir, targetStoreDir, project, oldPath } = setupFixture();
    writeSessionJsonl(oldStoreDir, "sess-side", { cwd: oldPath });
    const sidecarFrom = join(oldStoreDir, "extensions", "demo-ext", `${encodeURIComponent("sess-side")}.json`);
    mkdirSync(dirname(sidecarFrom), { recursive: true });
    writeFileSync(sidecarFrom, "{\"state\":1}");
    const blobsFrom = join(oldStoreDir, "resident-blobs", "sess-side");
    mkdirSync(blobsFrom, { recursive: true });
    writeFileSync(join(blobsFrom, "blob-1.txt"), "x");

    const res = await post(app, "/api/sessions/rebind", { project, oldPath, sessionIds: ["sess-side"] });
    expect(res.status).toBe(200);
    expect((await res.json()).imported).toHaveLength(1);

    const sidecarTo = join(targetStoreDir, "extensions", "demo-ext", `${encodeURIComponent("sess-side")}.json`);
    expect(existsSync(sidecarFrom)).toBe(false);
    expect(readFileSync(sidecarTo, "utf-8")).toBe("{\"state\":1}");
    const blobsTo = join(targetStoreDir, "resident-blobs", "sess-side");
    expect(existsSync(join(blobsTo, "blob-1.txt"))).toBe(true);
    expect(existsSync(blobsFrom)).toBe(false);
  });

  test("幂等：源已不在而目标在 → already_bound 不报错", async () => {
    const { app, targetStoreDir, project, oldPath } = setupFixture();
    writeSessionJsonl(targetStoreDir, "sess-idem", { cwd: project }); // 源已被移走（半途态）
    const res = await post(app, "/api/sessions/rebind", { project, oldPath, sessionIds: ["sess-idem"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported[0]).toMatchObject({ id: "sess-idem", disposition: "already_bound" });
  });

  test("冲突：源与目标同名并存 → skipped(rebind_conflict)，源保持原位", async () => {
    const { app, oldStoreDir, targetStoreDir, project, oldPath } = setupFixture();
    const src = writeSessionJsonl(oldStoreDir, "sess-clash", { cwd: oldPath });
    writeSessionJsonl(targetStoreDir, "sess-clash", { cwd: project });
    const res = await post(app, "/api/sessions/rebind", { project, oldPath, sessionIds: ["sess-clash"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toEqual([]);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]).toMatchObject({ id: "sess-clash", reason: "rebind_conflict" });
    expect(existsSync(src)).toBe(true); // 源不动，用户可自行处置
  });

  test("扫描后文件被移走（scan-then-import 竞态）：not_found 结构化报告", async () => {
    const { app, oldStoreDir, project, oldPath } = setupFixture();
    writeSessionJsonl(oldStoreDir, "sess-gone", { cwd: oldPath });
    rmSync(join(oldStoreDir, "sess-gone.jsonl"));
    const res = await post(app, "/api/sessions/rebind", { project, oldPath, sessionIds: ["sess-gone"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped[0]).toMatchObject({ id: "sess-gone", reason: "not_found" });
  });

  test("扫描后文件被截断（scan-then-import 竞态）：list 丢弃坏文件 → not_found 结构化报告，不炸整批", async () => {
    const { app, oldStoreDir, project, oldPath } = setupFixture();
    // 损坏文件（首行非 session header）在导入时被 SessionManager.list 丢弃：
    // 无法定位即 not_found（消息含损坏提示）——与 scan 阶段 totalFiles 差值口径一致；
    // corrupt_header 分支为 list→rebind 同请求 await 边界间的 TOCTOU 防御保留。
    writeSessionJsonl(oldStoreDir, "sess-fine", { cwd: oldPath });
    writeFileSync(join(oldStoreDir, "sess-trunc.jsonl"), "truncated-garbage\n");
    const res = await post(app, "/api/sessions/rebind", { project, oldPath, sessionIds: ["sess-trunc", "sess-fine"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped.find((s: { id: string }) => s.id === "sess-trunc").reason).toBe("not_found");
    expect(body.imported.map((s: { id: string }) => s.id)).toEqual(["sess-fine"]);
  });

  test("非法输入：sessionIds 空/非数组/含非字符串；旧库不存在 → 400", async () => {
    const { app, project, oldPath, oldStoreDir } = setupFixture();
    writeSessionJsonl(oldStoreDir, "sess-x", { cwd: oldPath });
    for (const ids of [[], "sess-x", [null], [42]]) {
      const res = await post(app, "/api/sessions/rebind", { project, oldPath, sessionIds: ids });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_session_ids");
    }
    const gone = await post(app, "/api/sessions/rebind", { project, oldPath: "/data/projects/no-store", sessionIds: ["any"] });
    expect(gone.status).toBe(400);
    expect((await gone.json()).error.code).toBe("old_store_not_found");
  });
});
