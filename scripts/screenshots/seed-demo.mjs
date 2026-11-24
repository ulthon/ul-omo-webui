#!/usr/bin/env node
// README 截图演示数据工具。四种命令：
//   seed   --root <dir> --lang zh-CN|en   落盘演示项目文件 + 引擎格式的会话文件 + manifest.json
//   serve  --root <dir> [--port 7799]     用隔离的数据/会话/配置目录起一个 webui 实例（后台常驻）
//   apply  --root <dir> [--url ...]       登录实例，录入项目、标题、置顶、标签、笔记
//   stop   --root <dir>                   停掉 serve 起的实例
// 会话文件按引擎 SessionManager 的 v3 JSONL 格式手写：条目按 parentId 成链，助手条目带 usage/timing，
// 状态栏的 token 与费用就是从这些 usage 汇总出来的。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { buildPlan } from "./demo-content.mjs";

const PROVIDER = "zai-coding-cn";
const MODEL = "glm-5.3";
const DEMO_PASSWORD = "demo-pass";

const hex = (bytes) => randomBytes(bytes).toString("hex");

function uuidv7(ms) {
  const ts = BigInt(ms).toString(16).padStart(12, "0");
  const variant = ((randomBytes(1)[0] & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${hex(2).slice(0, 3)}-${variant}${hex(1)}-${hex(6)}`;
}

const encodeCwdToSessionDirName = (cwd) => `--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`;
const rand = (n) => Math.floor(Math.random() * n);

class SessionBuilder {
  constructor({ cwd, projectFiles, firstUserText }) {
    this.cwd = cwd;
    this.finalFiles = projectFiles;
    this.firstUserText = firstUserText;
    this.entries = [];
    this.parent = null;
    this.t = 2500 + rand(3000);
    this.ctxTokens = 1100;
    /** 每个文件尚未应用的 edit：状态 = 最终内容把这些 edit 反向应用 */
    this.pendingEdits = new Map();
    /** 会话里 write 步骤覆盖的文件在写入前的内容（null = 原本不存在） */
    this.preWrite = new Map();
    this.written = new Set();
    this.todo = null;
    this.modelChange = { type: "model_change", id: hex(4), parentId: null, timestamp: null, provider: PROVIDER, modelId: MODEL };
    this.parent = this.modelChange.id;
  }

  contentOf(path) {
    if (this.written.has(path)) return this.finalFiles[path];
    if (this.preWrite.has(path)) return this.preWrite.get(path);
    const pending = this.pendingEdits.get(path) ?? [];
    return pending.reduce((text, edit) => replaceOnce(text, edit.newText, edit.oldText), this.finalFiles[path] ?? null);
  }

  push(entry) {
    entry.id = hex(4);
    entry.parentId = this.parent;
    entry.timestamp = this.t;
    this.parent = entry.id;
    this.entries.push(entry);
  }

  user(text) {
    this.push({
      type: "message",
      message: { role: "user", content: [{ type: "text", text }], timestamp: this.t },
      inputSource: "rpc",
    });
    this.ctxTokens += Math.round(text.length / 2.2);
    this.t += 900 + rand(1800);
  }

  assistant({ thinking, text, tools }) {
    const requestedAt = this.t;
    const firstTokenAt = requestedAt + 450 + rand(900);
    const content = [];
    let clock = firstTokenAt;
    if (thinking) {
      const thinkingMs = 2500 + Math.round(thinking.length * 22) + rand(3000);
      content.push({ type: "thinking", thinking, startedAt: requestedAt + 120, endedAt: clock + thinkingMs });
      clock += thinkingMs;
    }
    if (text) {
      content.push({ type: "text", text });
      clock += 500 + Math.round(text.length * 12);
    }
    const calls = [];
    for (const tool of tools ?? []) {
      calls.push({ call: { type: "toolCall", id: `call_${hex(12)}`, name: tool.name, arguments: tool.args }, tool });
      content.push(calls.at(-1).call);
      clock += 600;
    }
    const endedAt = clock + 30;
    const output = Math.round(((text?.length ?? 0) + (thinking?.length ?? 0) * 1.4) / 3.2) + 35 * calls.length;
    const reasoning = thinking ? Math.round(thinking.length / 2.4) : 0;
    const input = Math.round(this.ctxTokens * 0.08);
    const cacheRead = this.ctxTokens - input;
    const cost = (n, rate) => Math.round(n * rate * 1e7) / 1e7;
    this.push({
      type: "message",
      message: {
        role: "assistant",
        content,
        api: "openai-completions",
        provider: PROVIDER,
        model: MODEL,
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite: 0,
          reasoning,
          totalTokens: input + output + cacheRead,
          cost: {
            input: cost(input, 1.4e-6),
            output: cost(output, 4.4e-6),
            cacheRead: cost(cacheRead, 0.26e-6),
            cacheWrite: 0,
            total: cost(input, 1.4e-6) + cost(output, 4.4e-6) + cost(cacheRead, 0.26e-6),
          },
        },
        stopReason: calls.length ? "toolUse" : "stop",
        timestamp: endedAt,
        responseId: `${new Date(this.t + OFFSET).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}${hex(5)}`,
        rawStopReason: calls.length ? "tool_calls" : "stop",
        thinkingLevel: "max",
        timing: { requestedAt, firstTokenAt, lastTokenAt: clock, endedAt, generationMs: clock - requestedAt },
      },
    });
    this.t = endedAt + 60;
    this.ctxTokens += output;
    for (const { call, tool } of calls) this.result(call, tool);
  }

  result(call, tool) {
    const { text, details, isError, seconds } = this.toolResult(tool);
    const message = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text }],
      isError,
      timestamp: this.t + seconds * 1000,
    };
    if (details) message.details = details;
    this.push({ type: "message", message });
    this.ctxTokens += Math.min(2500, Math.round(text.length / 3.5));
  }

  toolResult(tool) {
    switch (tool.auto) {
      case "read": {
        const content = this.contentOf(tool.args.path);
        if (content == null) return { text: `File not found: ${tool.args.path}`, isError: true, seconds: 0.2 };
        return { text: content, seconds: 0.25 + rand(30) / 100 };
      }
      case "edit": {
        const path = tool.args.path;
        const before = this.contentOf(path) ?? "";
        this.pendingEdits.set(path, []);
        return { text: unifiedDiff(path, before, this.contentOf(path)), seconds: 0.4 + rand(40) / 100 };
      }
      case "write": {
        const path = tool.args.path;
        const before = this.contentOf(path);
        this.preWrite.delete(path);
        this.written.add(path);
        return { text: `Wrote ${path}\n\n${unifiedDiff(path, before ?? "", this.contentOf(path))}`, seconds: 0.3 + rand(30) / 100 };
      }
      case "bash":
        return { text: tool.output, seconds: tool.seconds };
      case "grep":
        return { text: tool.output, seconds: 0.3 + rand(20) / 100 };
      case "todo": {
        const { op } = tool.args;
        if (op === "init") {
          this.todo = { phases: tool.phases.map((p) => ({ name: p.name, tasks: p.items.map((content) => ({ content, status: "pending" })) })) };
          const first = this.todo.phases[0].tasks[0];
          if (first) first.status = "in_progress";
        } else if (op === "done") {
          const phase = this.todo?.phases.find((p) => p.name === tool.args.phase);
          for (const task of phase?.tasks ?? []) task.status = "completed";
          const next = this.todo.phases.flatMap((p) => p.tasks).find((task) => task.status === "pending");
          if (next) next.status = "in_progress";
        }
        return { text: todoText(this.firstUserText, this.todo), details: { op, phases: structuredClone(this.todo.phases) }, seconds: 0.1 };
      }
      default:
        throw new Error(`unknown tool: ${tool.name}`);
    }
  }

  /** 把相对时间整体平移到 endAt 结束，返回会话 id */
  finalize(endAt) {
    const offset = endAt - this.t;
    const createdAt = this.modelChange.timestamp + offset;
    const shift = (ms) => ms + offset;
    for (const entry of [this.modelChange, ...this.entries]) {
      entry.timestamp = new Date(shift(entry.timestamp)).toISOString();
      const m = entry.message;
      if (!m) continue;
      m.timestamp = shift(m.timestamp);
      for (const block of m.content ?? []) {
        if (block.type === "thinking") {
          block.startedAt = shift(block.startedAt);
          block.endedAt = shift(block.endedAt);
        }
      }
      if (m.timing) for (const key of Object.keys(m.timing)) m.timing[key] = key === "generationMs" ? m.timing[key] : shift(m.timing[key]);
    }
    return uuidv7(createdAt);
  }
}

let OFFSET = 0; // Date.now()，responseId 用

function replaceOnce(text, from, to) {
  if (from === "") {
    const index = text.indexOf(to);
    if (index < 0) throw new Error(`anchor not found for removal: ${to.slice(0, 60)}`);
    return text.slice(0, index) + text.slice(index + to.length);
  }
  if (!text.includes(from)) throw new Error(`anchor not found: ${from.slice(0, 60)}`);
  return text.replace(from, to);
}

function unifiedDiff(path, before, after) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start++;
  let endBefore = beforeLines.length;
  let endAfter = afterLines.length;
  while (endBefore > start && endAfter > start && beforeLines[endBefore - 1] === afterLines[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const contextStart = Math.max(0, start - 2);
  const contextBefore = beforeLines.slice(contextStart, start).map((l) => ` ${l}`);
  const contextAfter = beforeLines.slice(endBefore, endBefore + 2).map((l) => ` ${l}`);
  const removed = beforeLines.slice(start, endBefore).map((l) => `-${l}`);
  const added = afterLines.slice(start, endAfter).map((l) => `+${l}`);
  const header = `@@ -${contextStart + 1},${endBefore - contextStart + Math.min(2, contextAfter.length)} +${contextStart + 1},${
    endAfter - contextStart + Math.min(2, contextAfter.length)
  } @@`;
  return [`--- a/${path}`, `+++ b/${path}`, header, ...contextBefore, ...removed, ...added, ...contextAfter].join("\n") + "\n";
}

function todoText(ask, todo) {
  const tasks = todo.phases.flatMap((p) => p.tasks.map((task) => ({ ...task, phase: p.name })));
  const open = tasks.filter((t) => t.status !== "completed");
  const current = tasks.find((t) => t.status === "in_progress") ?? open[0];
  const next = open.find((t) => t !== current);
  const activeIndex = todo.phases.findIndex((p) => p.tasks.some((t) => t.status !== "completed"));
  const lines = [`Ask: ${ask}`, `Now: ${current ? `${current.content} (${current.phase})` : "none - all tasks closed"}`];
  lines.push(`Next: ${next ? `${next.content} (${next.phase})` : "none"}`);
  lines.push("");
  if (open.length) {
    lines.push(`Remaining items (${open.length}):`);
    for (const t of open) lines.push(`  - [ ] ${t.content} [${t.status}] (${t.phase})`);
  } else {
    lines.push("Remaining items: none");
  }
  lines.push(`Overall: ${tasks.length - open.length}/${tasks.length} done, ${open.length} open.`);
  if (activeIndex >= 0) {
    const phase = todo.phases[activeIndex];
    const done = phase.tasks.filter((t) => t.status === "completed").length;
    lines.push(`Active phase ${activeIndex + 1}/${todo.phases.length} "${phase.name}" (${done}/${phase.tasks.length}).`);
  }
  return lines.join("\n");
}

function runStep(builder, step) {
  if (step.kind === "user") {
    builder.user(step.text);
    return;
  }
  builder.assistant({ thinking: step.thinking, text: step.text, tools: step.tools ?? (step.tool ? [step.tool] : []) });
}

function cmdSeed({ root, lang }) {
  const plan = buildPlan(lang, join(root, "projects"));
  OFFSET = Date.now();
  // 只清本脚本生成的两部分，agent/ 下手工放的引擎凭证等其它内容不动
  rmSync(join(root, "projects"), { recursive: true, force: true });
  rmSync(join(root, "agent", "sessions"), { recursive: true, force: true });
  for (const project of plan.projects) {
    for (const [path, content] of Object.entries(project.files)) {
      const target = join(project.path, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  const agentDir = join(root, "agent");
  const sessions = [];
  for (const session of plan.sessions) {
    const project = plan.projects.find((p) => p.name === session.project);
    const firstUserText = session.steps.find((s) => s.kind === "user").text;
    const builder = new SessionBuilder({ cwd: project.path, projectFiles: project.files, firstUserText });
    // 会话里对每个文件的首次写入前内容 + 尚未应用的 edit，供 read/write/edit 步骤推导改动前的内容
    for (const step of session.steps) {
      for (const tool of step.tools ?? (step.tool ? [step.tool] : [])) {
        if (tool.auto === "edit") builder.pendingEdits.set(tool.args.path, [...(builder.pendingEdits.get(tool.args.path) ?? []), ...tool.args.edits]);
        if (tool.auto === "write") builder.preWrite.set(tool.args.path, tool.before ?? null);
      }
    }
    for (const step of session.steps) runStep(builder, step);
    const endAt = Date.now() - session.modifiedAgoMin * 60_000;
    const id = builder.finalize(endAt);
    const header = { type: "session", version: 3, id, timestamp: builder.modelChange.timestamp, cwd: project.path };
    const dir = join(agentDir, "sessions", encodeCwdToSessionDirName(project.path));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    const lines = [header, builder.modelChange, ...builder.entries].map((e) => JSON.stringify(e));
    writeFileSync(file, lines.join("\n") + "\n");
    sessions.push({
      id,
      file,
      key: session.key,
      project: project.path,
      title: session.title,
      pinned: Boolean(session.pinned),
      tags: session.tags ?? [],
      modifiedAt: new Date(endAt).toISOString(),
    });
  }
  const manifest = {
    lang,
    root,
    projects: plan.projects.map((p, index) => ({ name: p.name, path: p.path, lastOpenedAt: new Date(Date.now() - index * 36 * 60_000).toISOString() })),
    sessions,
    tags: plan.tags,
    notes: plan.notes.map((note, index) => ({
      project: plan.projects[0].path,
      title: note.title,
      content: note.content,
      createdAt: new Date(Date.now() - note.daysAgo * 86_400_000 - index * 3600_000).toISOString(),
    })),
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`seeded ${plan.projects.length} projects, ${sessions.length} sessions into ${root}`);
}

function envFor({ root, port }) {
  return {
    ...process.env,
    UL_OMO_WEBUI_PORT: String(port),
    UL_OMO_WEBUI_HOST: "127.0.0.1",
    UL_OMO_WEBUI_PASSWORD: DEMO_PASSWORD,
    UL_OMO_WEBUI_DATA_DIR: join(root, "data"),
    UL_OMO_WEBUI_AGENT_DIR: join(root, "agent"),
    UL_OMO_WEBUI_CONFIG_DIR: join(root, "config"),
    UL_OMO_WEBUI_LOG_FILE: "0",
  };
}

const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../../server/dist/index.js");
const pidFile = (root) => join(root, "server.pid");

async function cmdServe({ root, port }) {
  if (!process.argv.includes("--force")) {
    let status = 0;
    try {
      status = (await fetch(`http://127.0.0.1:${port}/api/auth/status`)).status;
    } catch {
      status = 0;
    }
    if (status > 0) throw new Error(`port ${port} already answers (HTTP ${status}); pass --force to start another anyway`);
  }
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  const log = join(root, "server.log");
  const logFd = openSync(log, "a");
  const child = spawn(process.execPath, [serverEntry], { env: envFor({ root, port }), detached: true, stdio: ["ignore", logFd, logFd] });
  writeFileSync(pidFile(root), String(child.pid));
  child.unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      // 未登录时 /api/auth/status 返回 401，只要服务端有应答就算就绪
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
      if (res.status < 500) {
        console.log(`serving on http://127.0.0.1:${port} (pid ${child.pid}, log ${log})`);
        return;
      }
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become ready within 30s; see ${log}`);
}

function cmdStop({ root }) {
  const file = pidFile(root);
  const pid = Number(readFileSync(file, "utf8"));
  process.kill(pid, "SIGTERM");
  rmSync(file, { force: true });
  console.log(`stopped pid ${pid}`);
}

async function cmdApply({ root, url }) {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  let cookie = "";
  const call = async (method, path, body) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  const login = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: DEMO_PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("login returned no cookie");

  for (const project of manifest.projects) await call("POST", "/api/projects", { path: project.path });
  for (const project of manifest.projects) await call("PATCH", "/api/projects/meta", { path: project.path, lastOpenedAt: project.lastOpenedAt });
  await call("PUT", "/api/tags", { scope: "global", tags: manifest.tags });
  for (const session of manifest.sessions) {
    await call("PATCH", `/api/sessions/${session.id}/meta`, { renamedTitle: session.title, pinned: session.pinned });
    if (session.tags.length) {
      await call("PUT", `/api/sessions/${session.id}/tags`, { tags: session.tags.map((name) => ({ scope: "global", name })) });
    }
    await call("POST", `/api/sessions/${session.id}/read`);
  }
  // 笔记接口没有幂等键，按内容去重，重复跑 apply 不会越加越多
  const existing = await call("GET", `/api/notes?project=${encodeURIComponent(manifest.projects[0].path)}`);
  const existingContents = new Set((existing.notes ?? existing).map((note) => note.content));
  for (const note of manifest.notes) {
    if (!existingContents.has(note.content)) await call("POST", "/api/notes", { project: note.project, title: note.title, content: note.content });
  }
  // 笔记的创建时间接口不允许指定，直接改元数据库，让面板里显示“3 天前”而不是“刚刚”
  const db = new DatabaseSync(join(root, "data", "meta.db"));
  const update = db.prepare("UPDATE meta_note SET created_at = ?, updated_at = ? WHERE project_path = ? AND content = ?");
  for (const note of manifest.notes) update.run(note.createdAt, note.createdAt, note.project, note.content);
  db.close();
  console.log(`applied: ${manifest.projects.length} projects, ${manifest.sessions.length} sessions, ${manifest.notes.length} notes`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(token);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const [command] = args._;
const root = args.root ? resolve(args.root) : null;
const port = Number(args.port ?? 7799);
const url = args.url ?? `http://127.0.0.1:${port}`;
const run = { seed: cmdSeed, serve: cmdServe, apply: cmdApply, stop: cmdStop }[command];
if (!run || !root) {
  console.error("usage: seed-demo.mjs <seed|serve|apply|stop> --root <dir> [--lang zh-CN|en] [--port 7799] [--url http://127.0.0.1:7799] [--force]");
  process.exit(2);
}
Promise.resolve()
  .then(() => run({ root, lang: args.lang, port, url }))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
