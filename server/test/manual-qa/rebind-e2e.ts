// r10 todo 18 MANUAL-QA：真实表面端到端证明（数据面形状）。
// 场景：仓库从 /data/projects/demo-old 移动到 /data/projects/demo-new（新目录未注册过会话），
// 旧会话库滞留 agentDir/sessions/--data-projects-demo-old--/。
// 验证链：scan 预览 → import 重绑 → SessionManager.list 可见（列表入口）→
// readTailEntries 直读消息完整（webui 首载真实路径）→ header cwd 已重写 → 续聊文件就绪。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { SessionManager } from "@code-yeongyu/senpi";
import { encodeCwdToSessionDirName } from "../../src/adapter/senpi-adapter";
import { readTailEntries } from "../../src/adapter/session-file";
import { createRebindRoutes } from "../../src/api/routes-rebind";
import { openMetaDb } from "../../src/db/meta";
import type { EngineGateway } from "../../src/api/engine-runtime";

function fakeGateway(): EngineGateway {
  return {
    async sessionsList() { return []; },
    async peekActiveSessionPaths() { return null; },
    async createSession() { throw new Error("not canned"); },
    async messages() { return { entries: [], leafId: null, cursor: null }; },
    async prompt() { return { disposition: "started" }; },
    async queueList() { return { steering: [], followUp: [], ordered: [] }; },
    async queueClear() { return { steering: [], followUp: [], ordered: [] }; },
    async abort() {},
    async permissionRespond() {},
    async questionsList() { return []; },
    async usage() { throw new Error("not canned"); },
    async modelsList() { return []; },
    async deleteSession(id: string) { return { sessionPath: id, fileExisted: false }; },
    async exportSessionHtml(id: string) { throw new Error("not canned"); },
    async forkSession(id: string) { throw new Error("not canned"); },
    async restartProject() {},
    async commandsList() { return null; },
    async stopAll() {},
  };
}

const agentDir = mkdtempSync(join(tmpdir(), "qa-agent-"));
const newProject = mkdtempSync(join(tmpdir(), "qa-new-")); // 真实存在的新项目目录
const oldPath = "/data/projects/demo-old"; // 旧路径（磁盘上已不存在——仓库已移动）
const oldDir = join(agentDir, "sessions", encodeCwdToSessionDirName(oldPath));
const newDir = join(agentDir, "sessions", encodeCwdToSessionDirName(newProject));
mkdirSync(oldDir, { recursive: true });

// 旧会话：header + 5 条消息（3 user / 2 assistant 交替）+ 扩展边车
const sid = "qa-sess-0001";
const lines = [
  JSON.stringify({ type: "session", id: sid, timestamp: "2026-10-20T10:00:00.000Z", cwd: oldPath }),
];
for (let i = 1; i <= 5; i++) {
  lines.push(JSON.stringify({
    type: "message",
    id: `${sid}-e${i}`,
    parentId: i === 1 ? null : `${sid}-e${i - 1}`,
    timestamp: `2026-10-20T10:0${i}:00.000Z`,
    message: { role: i % 2 === 1 ? "user" : "assistant", content: [{ type: "text", text: `消息 ${i}：迁移前的历史内容` }] },
  }));
}
writeFileSync(join(oldDir, `${sid}.jsonl`), lines.join("\n") + "\n");
mkdirSync(join(oldDir, "extensions", "qa-ext"), { recursive: true });
writeFileSync(join(oldDir, "extensions", "qa-ext", `${encodeURIComponent(sid)}.json`), "{\"note\":\"sidecar\"}");

const meta = openMetaDb({ path: join(mkdtempSync(join(tmpdir(), "qa-meta-")), "meta.db") });
const app = new Hono();
app.route("/", createRebindRoutes({ meta, engines: fakeGateway(), agentDir }));

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const assert = (name: string, cond: boolean, detail = "") => {
  if (!cond) { console.error(`FAIL ${name} ${detail}`); process.exit(1); }
  console.log(`PASS ${name}${detail ? " — " + detail : ""}`);
};

// 1) 扫描预览
let res = await post("/api/sessions/rebind/scan", { project: newProject, oldPath });
assert("scan 200", res.status === 200);
let body = await res.json();
assert("scan 返回旧会话", body.sessions.length === 1 && body.sessions[0].id === sid,
  `firstMessage="${body.sessions[0]?.firstMessage}" messageCount=${body.sessions[0]?.messageCount}`);

// 2) 导入重绑
res = await post("/api/sessions/rebind", { project: newProject, oldPath, sessionIds: [sid] });
assert("import 200", res.status === 200);
body = await res.json();
assert("import moved", body.imported?.[0]?.disposition === "moved", `path=${body.imported?.[0]?.path}`);

// 3) 列表发现口径：新项目编码目录可见
const rows = await SessionManager.list(newProject, newDir);
assert("SessionManager.list 可见", rows.some((r) => r.id === sid));

// 4) 消息完整（webui 首载真实路径：尾窗直读）
const page = await readTailEntries(join(newDir, `${sid}.jsonl`));
const messages = page.entries.filter((e) => e.type === "message");
assert("历史消息完整（5 条）", messages.length === 5, `实际 ${messages.length} 条`);
assert("首条 user 消息内容在", JSON.stringify(messages[0]).includes("消息 1"));

// 5) header cwd 已重写为新项目（续聊文件就绪：引擎 open 后 cwd 正确）
const firstLine = JSON.parse((await import("node:fs")).readFileSync(join(newDir, `${sid}.jsonl`), "utf-8").split("\n")[0]);
assert("header cwd 重写", firstLine.cwd === newProject, firstLine.cwd);

// 6) sidecar 随迁
const { existsSync, readFileSync } = await import("node:fs");
const sidecar = join(newDir, "extensions", "qa-ext", `${encodeURIComponent(sid)}.json`);
assert("sidecar 随迁", existsSync(sidecar) && readFileSync(sidecar, "utf-8").includes("sidecar"));

// 7) 源目录已清空（物理移动语义，无副本）
assert("源文件已移走", !existsSync(join(oldDir, `${sid}.jsonl`)));

// 8) 重复导入幂等
res = await post("/api/sessions/rebind", { project: newProject, oldPath, sessionIds: [sid] });
assert("幂等重导 not_found→目标命中 already_bound", res.status === 200);
body = await res.json();
assert("幂等 already_bound", body.imported?.[0]?.disposition === "already_bound");

console.log("\nALL PASS — 8/8");
rmSync(agentDir, { recursive: true, force: true });
rmSync(newProject, { recursive: true, force: true });
