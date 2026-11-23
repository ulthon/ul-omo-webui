#!/usr/bin/env node
/**
 * 长会话复现台架 · QA 编排脚本（webui-refetch-storm 计划任务 6，阶段 A）。
 *
 * 职责：端到端编排隔离验证实例——种子 17k 条目会话、最小凭证注入 agentDir、独立端口
 * 起服务（UL_OMO_WEBUI_AGENT_DIR=<临时根>，绝不写真实 ~/.omo/agent）、HTTP API 打开
 * 种子会话、跑一轮真引擎回合（帧注入已否决：需产品代码接缝，违反 Must NOT），并在
 * API 层断言服务端可观测面：
 *   - 回合中 full=1 请求计数 0（harness 是唯一客户端，请求记账全量审计；产品 http req
 *     日志只记 path 不记 query，服务端日志无法区分 full=1——局限记录在 results）；
 *   - SSE 帧流动（entry_appended/settle 帧计数、无 gap 帧）；
 *   - 种子被引擎如实接管：追加条目 JSON 可解析、parentId 链接续、文件行数单调不降；
 *   - 助手真实回复落盘。
 *
 * 阶段 B（真浏览器几何 + 前端诊断行断言）留钩子：--browser-url 模式打印 URL、落
 * browser-info.json、等待 <tmpRoot>/browser-stage-done.marker 标记文件，标记出现后
 * 解析服务端日志中 fe.* 诊断行（graph-repair/session_open/scroll/items）评估计划断言。
 *
 * 清理纪律：服务进程按 spawn 返回的 PID 定向终止（进程组信号，绝不 pkill 按名）；tmpRoot
 * 用后即删（--keep 保留并登记路径）；try/finally 兜底，失败路径同样清理。
 *
 * 用法：
 *   node scripts/qa-large-session.mjs [--evidence-dir <dir>] [--entries 17000]
 *        [--model zai-coding-cn/glm-5.3-flash] [--keep] [--rebuild]
 *        [--browser-url] [--browser-wait-secs 600] [--turn-timeout-secs 180]
 *
 * 结果：machine-readable JSON 写 <evidence-dir>/task-6-webui-refetch-storm.json（缺省
 * 主仓 .omo/evidence/webui-refetch-storm/ 绝对路径），人读日志同目录 .log；任一断言
 * fail 即非零退出（skipped-envblocked / skipped-stage-b 不计失败）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { runSeed } from "./seed-large-session.mjs";

const WORKTREE = resolve(import.meta.dirname, "..");
const DEFAULT_EVIDENCE_DIR = "/data/projects/ul-omo-webui/.omo/evidence/webui-refetch-storm";
// 最小凭证面：引擎 spawn（模型解析 + 鉴权）必需或强相关的 agentDir 文件。mcp.json /
// extensions/ / skills/ / prompts/ 刻意不拷——隔离实例不做外延加载，回合最小化。
const AGENT_SEED_FILES = [
  "models.json",
  "auth.json",
  "models-store.json",
  "credential-pool-state.json",
  "config-identity.key",
  "settings.json",
];
const SETTLE_TYPES = new Set(["agent_end", "agent_settled", "session_closed"]);
const PROMPT_TEXT =
  "这是长会话复现台架的真引擎回合探针。请直接用一句中文回答：OK 17k。" +
  "不要使用任何工具，不要读写任何文件，不要调用任何扩展能力。";

// ---- 参数 ----
function parseArgs(argv) {
  const a = {
    entries: 17000,
    model: "zai-coding-cn/glm-5.3-flash",
    browserWaitSecs: 600,
    turnTimeoutSecs: 180,
    evidenceDir: DEFAULT_EVIDENCE_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--evidence-dir") a.evidenceDir = argv[++i];
    else if (t === "--entries") a.entries = Number(argv[++i]);
    else if (t === "--model") a.model = argv[++i];
    else if (t === "--keep") a.keep = true;
    else if (t === "--rebuild") a.rebuild = true;
    else if (t === "--browser-url") a.browserUrl = true;
    else if (t === "--browser-wait-secs") a.browserWaitSecs = Number(argv[++i]);
    else if (t === "--turn-timeout-secs") a.turnTimeoutSecs = Number(argv[++i]);
    else {
      console.error(`未知参数：${t}`);
      process.exit(2);
    }
  }
  return a;
}

// ---- 日志（stderr 人读 + evidence 文件全量） ----
function makeLogger(logFile) {
  const write = (line) => {
    process.stderr.write(`${line}\n`);
    try {
      appendFileSync(logFile, `${line}\n`);
    } catch {}
  };
  return {
    info: (m) => write(`[qa] ${m}`),
    detail: (obj) => write(`[qa:detail] ${JSON.stringify(obj)}`),
    raw: write,
  };
}

// ---- 基础设施 ----
function grabFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

function portIsFree(port) {
  return new Promise((resolveFree) => {
    const srv = createServer();
    srv.once("error", () => resolveFree(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolveFree(true));
    });
  });
}

function killProcessGroup(pid, log) {
  const receipt = { pid, sigterm: false, sigkill: false, exited: false };
  try {
    process.kill(-pid, "SIGTERM");
    receipt.sigterm = true;
  } catch (err) {
    log.info(`进程组 SIGTERM 失败（可能已退出）：${err.message}`);
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    } catch {
      receipt.exited = true;
      return receipt;
    }
  }
  try {
    process.kill(-pid, "SIGKILL");
    receipt.sigkill = true;
  } catch {}
  receipt.exited = true;
  return receipt;
}

// 异步睡眠：必须让出事件循环——同进程的 SSE for-await 读取器依赖它推进；
// 同步 Atomics.wait 会冻结循环，settle 帧结构性不可见（gate-review B1 实证缺陷）
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 结果装配 ----
const assertions = [];
function record(name, status, detail) {
  assertions.push({ name, status, ...(detail !== undefined ? { detail } : {}) });
}

function lineCountOf(file) {
  const buf = readFileSync(file);
  let n = 0;
  for (const b of buf) if (b === 0x0a) n += 1;
  return n;
}

// ---- SSE 订阅（fetch 流手工解析，记录帧分布与 settle/gap 标志） ----
async function subscribeSse(baseUrl, cookie, state, log) {
  const controller = new AbortController();
  state.abortSse = () => controller.abort();
  const res = await fetch(`${baseUrl}/api/events`, {
    headers: { cookie, accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE 连接失败：HTTP ${res.status}`);
  }
  state.connected = true;
  log.info("SSE 已连接 /api/events");
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let eventName = "message";
          let dataStr = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
          }
          state.frames.total += 1;
          state.frames.byType[eventName] = (state.frames.byType[eventName] ?? 0) + 1;
          if (eventName === "gap") state.frames.gapCount += 1;
          let payload = null;
          try {
            payload = dataStr ? JSON.parse(dataStr) : null;
          } catch {}
          const type = payload?.event?.type ?? eventName;
          state.frames.byEngineType[type] = (state.frames.byEngineType[type] ?? 0) + 1;
          state.recentFrames.push({
            t: Date.now(),
            event: eventName,
            type,
            sessionPath: payload?.sessionPath ?? payload?.event?.sessionPath ?? null,
          });
          if (state.recentFrames.length > 400) state.recentFrames.shift();
          if (SETTLE_TYPES.has(type)) state.settleFrames.push({ t: Date.now(), type });
          if (type === "replay_done") state.replayDone = true;
        }
      }
    } catch (err) {
      if (!state.aborting) state.sseError = String(err);
    }
  })();
  return res;
}

// ---- 阶段 B 日志解析：fe.* 诊断行（graph-repair/session_open/scroll/items） ----
function parseDiagLines(serverLogFile, windowStart, windowEnd) {
  let text;
  try {
    text = readFileSync(serverLogFile, "utf8");
  } catch {
    return { available: false, note: "服务端日志不可读" };
  }
  const counts = { graphRepair: 0, graphRepairFailed: 0, sessionOpen: 0, scroll: 0, items: 0, totalFe: 0 };
  for (const line of text.split("\n")) {
    if (!line.includes("fe.")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Date.parse(entry.t ?? "");
    if (!(t >= windowStart && t <= windowEnd)) continue;
    const ev = String(entry.ev ?? "");
    if (!ev.startsWith("fe.")) continue;
    counts.totalFe += 1;
    if (ev.includes("graph-repair-failed")) counts.graphRepairFailed += 1;
    else if (ev.includes("graph-repair")) counts.graphRepair += 1;
    else if (ev.includes("session_open")) counts.sessionOpen += 1;
    else if (ev.includes("scroll")) counts.scroll += 1;
    else if (ev.includes("items")) counts.items += 1;
  }
  return { available: true, ...counts };
}

// ---- 主流程 ----
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidenceDir = resolve(args.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true });
  const logFile = join(evidenceDir, "task-6-webui-refetch-storm.log");
  const resultsFile = join(evidenceDir, "task-6-webui-refetch-storm.json");
  const log = makeLogger(logFile);

  const tmpRoot = join(WORKTREE, ".omo", "tmp", "webui-refetch-storm", `qa-${runStamp}`);
  const projectDir = join(tmpRoot, "projects", "qa-large-session");
  const agentRoot = join(tmpRoot, "agent");
  const dataDir = join(tmpRoot, "webui-data");
  const cleanup = { serverKilled: null, portFree: null, tmpRootRemoved: null, keptPath: null };

  const envBlocked = { blocked: false, reason: null };
  const results = {
    task: "webui-refetch-storm/6-长会话复现台架-阶段A",
    stageA: true,
    runStamp,
    worktree: WORKTREE,
    tmpRoot,
    evidence: { resultsFile, logFile },
    seed: null,
    agentSeed: null,
    server: null,
    baseline: null,
    turn: null,
    stageB: { enabled: args.browserUrl === true, markerSeen: false },
    assertions,
    cleanup,
    env: { node: process.version, platform: process.platform },
    ok: false,
  };

  let server = null;
  let port = null;
  let turnState = null;
  const requests = []; // harness 全量请求记账：{t, method, url}
  const sse = {
    frames: { total: 0, byType: {}, byEngineType: {}, gapCount: 0 },
    recentFrames: [],
    settleFrames: [],
    replayDone: false,
    connected: false,
    error: null,
    aborting: false,
  };

  try {
    // ---- 1. 全新 tmpRoot（幂等重建：本运行独占时间戳目录，残留同名即清） ----
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(projectDir, { recursive: true });
    log.info(`tmpRoot 就绪：${tmpRoot}`);

    // ---- 2. 种子 17k 条目会话（--out = agentRoot：与服务端 UL_OMO_WEBUI_AGENT_DIR 同根，
    // 种子落 <agentRoot>/sessions/<encode(projectDir)>/，服务端 sessionsList 扫描同一目录）----
    log.info(`种子生成开始（${args.entries} 条目，项目 ${projectDir}）`);
    const seedStats = await runSeed({ out: agentRoot, project: projectDir, entries: args.entries });
    results.seed = seedStats;
    if (!seedStats.ok) {
      record("seed_self_asserts", "fail", { failed: seedStats.asserts.filter((a) => !a.pass) });
      throw new Error("种子自断言未全过，终止编排");
    }
    record("seed_self_asserts", "pass", { entries: seedStats.entries, fileBytes: seedStats.fileBytes });
    log.info(`种子完成：${seedStats.entries} 条目，会话 ${seedStats.sessionId}`);

    // ---- 3. 最小 agentDir 凭证注入 ----
    const realAgent = join(homedir(), ".omo", "agent");
    mkdirSync(agentRoot, { recursive: true });
    const copied = [];
    const missing = [];
    for (const f of AGENT_SEED_FILES) {
      const src = join(realAgent, f);
      if (existsSync(src)) {
        copyFileSync(src, join(agentRoot, f));
        copied.push(f);
      } else {
        missing.push(f);
      }
    }
    results.agentSeed = { source: realAgent, copied, missing };
    log.info(`agentDir 注入：拷贝 ${copied.join(", ") || "无"}；缺失 ${missing.join(", ") || "无"}`);
    if (!existsSync(join(agentRoot, "models.json")) || !existsSync(join(agentRoot, "auth.json"))) {
      envBlocked.blocked = true;
      envBlocked.reason = "真实 agentDir 缺 models.json/auth.json，无法种子模型凭证";
      record("agent_seed_models_auth", "skipped-envblocked", { missing });
    } else {
      record("agent_seed_models_auth", "pass", { copied });
    }

    // ---- 4. 服务端构建（源码形态；--server-only 跳过 web——同波任务在改 web 源码） ----
    const serverEntry = join(WORKTREE, "server", "dist", "index.js");
    let buildReceipt = "预构建产物已存在";
    if (args.rebuild || !existsSync(serverEntry)) {
      log.info("构建服务端（node scripts/build-package.mjs --server-only）…");
      const r = spawnSync(process.execPath, [join(WORKTREE, "scripts", "build-package.mjs"), "--server-only"], {
        cwd: WORKTREE,
        stdio: "pipe",
        encoding: "utf8",
      });
      buildReceipt = `exit=${r.status}${r.stdout ? ` stdout尾=${r.stdout.trim().split("\n").slice(-2).join(" | ")}` : ""}`;
      if (r.status !== 0) {
        throw new Error(`服务端构建失败：${buildReceipt}\n${r.stderr ?? ""}`);
      }
    }
    log.info(`服务端构建态：${buildReceipt}`);
    results.server = { entry: serverEntry, buildReceipt, port: null, pid: null, logFile: null };

    // ---- 5. 独立端口 + 隔离环境变量起服务 ----
    port = await grabFreePort();
    const password = randomBytes(12).toString("base64url");
    server = spawn(process.execPath, [serverEntry], {
      cwd: WORKTREE,
      detached: true, // 独立进程组：引擎子进程同组，按组信号定向清理
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        UL_OMO_WEBUI_HOST: "127.0.0.1",
        UL_OMO_WEBUI_PORT: String(port),
        UL_OMO_WEBUI_AGENT_DIR: agentRoot,
        UL_OMO_WEBUI_DATA_DIR: dataDir,
        UL_OMO_WEBUI_PASSWORD: password,
        UL_OMO_WEBUI_LOG_LEVEL: "debug",
      },
    });
    results.server.port = port;
    results.server.pid = server.pid;
    const serverLogFile = join(dataDir, "logs", `webui-${new Date().toISOString().slice(0, 10)}.log`);
    results.server.logFile = serverLogFile;
    server.stdout.on("data", () => {});
    server.stderr.on("data", (d) => log.raw(`[server:stderr] ${String(d).trimEnd()}`));
    server.on("exit", (code, sig) => {
      log.info(`服务进程退出：code=${code} sig=${sig}`);
    });
    log.info(`服务已 spawn：pid=${server.pid} port=${port}（agentDir=${agentRoot}）`);

    // ---- 6. 登录 + 健康就绪（有界轮询 30s）----
    const baseUrl = `http://127.0.0.1:${port}`;
    let cookie = null;
    const readyDeadline = Date.now() + 30000;
    let readyError = null;
    while (Date.now() < readyDeadline) {
      try {
        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (loginRes.status === 200) {
          const setCookie = loginRes.headers.get("set-cookie") ?? "";
          cookie = setCookie.split(";")[0];
          const health = await fetch(`${baseUrl}/api/health`, { headers: { cookie } });
          if (health.status === 200) {
            requests.push({ t: Date.now(), method: "POST", url: "/api/auth/login" });
            requests.push({ t: Date.now(), method: "GET", url: "/api/health" });
            break;
          }
          readyError = `health=${health.status}`;
        } else {
          readyError = `login=${loginRes.status}`;
        }
      } catch (err) {
        readyError = err.message;
      }
      await sleep(500);
    }
    if (!cookie) {
      throw new Error(`服务就绪超时（30s）：${readyError}`);
    }
    log.info("服务就绪：登录成功，健康检查通过");

    // ---- 6b. 注册项目（全新 DATA_DIR 的 meta 库无注册项目，resolveRuntime 按注册
    // 项目反查会话；不注册则 messages/prompt 全部 route.miss 404——二次实跑实证）----
    const regRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ path: projectDir }),
    });
    requests.push({ t: Date.now(), method: "POST", url: "/api/projects" });
    const regJson = await regRes.json().catch(() => ({}));
    record("project_registered", regRes.status === 200 ? "pass" : "fail", {
      status: regRes.status,
      response: regJson,
    });
    log.info(`项目注册：HTTP ${regRes.status}`);

    // ---- 7. 打开种子会话（列表发现 + 尾窗直读基线）----
    const listRes = await fetch(`${baseUrl}/api/sessions?project=${encodeURIComponent(projectDir)}`, {
      headers: { cookie },
    });
    requests.push({ t: Date.now(), method: "GET", url: `/api/sessions?project=${projectDir}` });
    const listJson = await listRes.json();
    const row = (listJson.sessions ?? []).find((s) => s.id === results.seed.sessionId);
    record("session_discoverable", row ? "pass" : "fail", {
      total: (listJson.sessions ?? []).length,
      expectedId: results.seed.sessionId,
    });
    if (!row) throw new Error("种子会话未出现在项目会话列表（SessionManager 未识别种子文件）");
    log.info(`会话列表发现种子：id=${row.id} firstMessage=${JSON.stringify(row.firstMessage ?? "").slice(0, 60)}`);

    const openRes = await fetch(`${baseUrl}/api/sessions/${row.id}/messages`, { headers: { cookie } });
    requests.push({ t: Date.now(), method: "GET", url: `/api/sessions/${row.id}/messages` });
    const openJson = await openRes.json();
    const baseline = {
      httpStatus: openRes.status,
      entries: (openJson.entries ?? []).length,
      hasMore: openJson.hasMore === true,
      cursor: openJson.cursor ?? null,
      leafId: openJson.leafId ?? null,
      totalSeeded: results.seed.entries,
    };
    results.baseline = baseline;
    record("open_tail_window", baseline.entries >= 1 && baseline.hasMore ? "pass" : "fail", baseline);
    log.info(`尾窗基线：${baseline.entries}/${baseline.totalSeeded} 条（hasMore=${baseline.hasMore}）`);

    // ---- 8. SSE 订阅（先于回合，避免丢帧）----
    await subscribeSse(baseUrl, cookie, sse, log);
    results.server.sse = "connected";

    // ---- 9. 真引擎回合 ----
    const fileBefore = lineCountOf(results.seed.sessionFile);
    const turnStart = Date.now();
    const settleBase = sse.settleFrames.length;
    let fileSizeBefore = 0;
    try {
      fileSizeBefore = statSync(results.seed.sessionFile).size;
    } catch {}
    turnState = { windowStart: turnStart, windowEnd: null, settleWaitMs: null, timedOut: false };
    log.info(`回合开始：POST prompt（model=${args.model}）…`);
    let promptReceipt = null;
    let promptError = null;
    try {
      const promptRes = await fetch(`${baseUrl}/api/sessions/${row.id}/prompt`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: PROMPT_TEXT, model: args.model }),
      });
      promptReceipt = await promptRes.json();
      requests.push({ t: Date.now(), method: "POST", url: `/api/sessions/${row.id}/prompt` });
      if (promptRes.status !== 200) promptError = `HTTP ${promptRes.status}: ${JSON.stringify(promptReceipt)}`;
    } catch (err) {
      promptError = err.message;
    }
    if (promptError) {
      envBlocked.blocked = true;
      envBlocked.reason = `prompt 失败：${promptError}`;
      record("engine_turn_completed", "skipped-envblocked", { error: promptError });
    } else {
      log.info(`prompt 回执：${JSON.stringify(promptReceipt)}`);
      // 有界等待 settle（SSE settle 帧；同时旁观会话文件增长作降级观测）
      const deadline = turnStart + args.turnTimeoutSecs * 1000;
      let fileGrew = false;
      while (Date.now() < deadline) {
        const settled = sse.settleFrames.length > settleBase;
        if (!fileGrew) {
          try {
            fileGrew = statSync(results.seed.sessionFile).size > fileSizeBefore;
          } catch {}
        }
        if (settled && fileGrew) break;
        // SSE 降级观测：连接失败时仅凭文件增长 + 宽限 10s 放行（结果如实标注降级）
        if (!sse.connected && fileGrew && Date.now() - turnStart > 10000) break;
        await sleep(1000);
      }
      turnState.windowEnd = Date.now();
      turnState.settleWaitMs = turnState.windowEnd - turnStart;
      turnState.timedOut = !(sse.settleFrames.length > settleBase);
      turnState.degraded = !sse.connected;
      results.turn = { ...turnState, promptReceipt, model: args.model };
      if (turnState.timedOut) {
        // 兜底中止（防引擎悬挂）
        try {
          await fetch(`${baseUrl}/api/sessions/${row.id}/abort`, { method: "POST", headers: { cookie } });
          requests.push({ t: Date.now(), method: "POST", url: `/api/sessions/${row.id}/abort` });
        } catch {}
        record("engine_turn_completed", "fail", { detail: `settle 帧超时（${args.turnTimeoutSecs}s），已 abort 兜底`, fileGrew, degraded: turnState.degraded });
      } else {
        record("engine_turn_completed", "pass", {
          settleWaitMs: turnState.settleWaitMs,
          settleTypes: sse.settleFrames.slice(settleBase).map((f) => f.type).join(","),
          degraded: turnState.degraded,
          promptReceipt,
        });
        log.info(`回合落定：${turnState.settleWaitMs}ms${turnState.degraded ? "（SSE 降级观测）" : ""}`);
      }
    }

    // ---- 10. 回合后核验（文件追加面 + 请求记账 + SSE 面）----
    const fileAfter = lineCountOf(results.seed.sessionFile);
    const appended = { linesBefore: fileBefore, linesAfter: fileAfter, grew: fileAfter > fileBefore };
    if (!envBlocked.blocked) {
      // 10a. 追加行全部可解析且链接续（引擎如实接管种子形态的铁证）
      let chainOk = true;
      let appendedAssistant = false;
      let parseErr = null;
      let firstAppendedParent = null;
      if (appended.grew) {
        const buf = readFileSync(results.seed.sessionFile, "utf8");
        const lines = buf.split("\n").filter((l) => l.trim() !== "");
        const beforeLines = lines.slice(0, fileBefore);
        const afterLines = lines.slice(fileBefore);
        const lastBefore = JSON.parse(beforeLines[beforeLines.length - 1]);
        firstAppendedParent = afterLines.length > 0 ? (JSON.parse(afterLines[0]).parentId ?? null) : null;
        if (firstAppendedParent !== lastBefore.id) chainOk = false;
        for (const l of afterLines) {
          try {
            const e = JSON.parse(l);
            if (e.type === "message" && e.message?.role === "assistant") appendedAssistant = true;
          } catch (err) {
            chainOk = false;
            parseErr = err.message;
            break;
          }
        }
      } else {
        chainOk = false;
      }
      record("engine_appended_parseable_chain_intact", chainOk ? "pass" : "fail", {
        ...appended,
        firstAppendedParent,
        appendedAssistant,
        parseErr,
      });
      record("assistant_replied_on_disk", appendedAssistant ? "pass" : "fail", appended);

      // 10b. 回合窗口 full=1 计数 == 0；harness 对 /messages 的请求也计 0（唯一客户端审计）
      const inWindow = requests.filter((r) => r.t >= turnState.windowStart && r.t <= (turnState.windowEnd ?? Date.now()));
      const fullOnes = inWindow.filter((r) => r.url.includes("full=1"));
      const messageGets = inWindow.filter((r) => r.method === "GET" && r.url.includes("/messages"));
      record("full1_requests_in_turn_window", fullOnes.length === 0 ? "pass" : "fail", {
        count: fullOnes.length,
        urls: fullOnes.map((r) => r.url),
        note: "harness 为唯一客户端；产品 http req 日志不记 query，服务端侧计数不可得（局限）",
      });
      record("no_unplanned_message_fetch_in_window", messageGets.length === 0 ? "pass" : "fail", {
        count: messageGets.length,
      });

      // 10c. SSE 面：帧流动、entry_appended 增量帧、无 gap
      const turnFrames = sse.recentFrames.filter((f) => f.t >= turnState.windowStart);
      record("sse_frames_flowed", sse.frames.total > 0 ? "pass" : "fail", {
        total: sse.frames.total,
        engineTypes: sse.frames.byEngineType,
      });
      record("sse_entry_appended_seen", (sse.frames.byEngineType.entry_appended ?? 0) >= 1 ? "pass" : "fail", {
        count: sse.frames.byEngineType.entry_appended ?? 0,
      });
      record("sse_no_gap_in_window", turnFrames.filter((f) => f.event === "gap").length === 0 ? "pass" : "fail", {
        gapCount: sse.frames.gapCount,
      });

      // 10d. 文件行数单调不降（无重写/整替）
      record("session_file_monotonic", fileAfter >= fileBefore ? "pass" : "fail", { fileBefore, fileAfter });
    } else {
      for (const name of [
        "engine_appended_parseable_chain_intact",
        "assistant_replied_on_disk",
        "full1_requests_in_turn_window",
        "no_unplanned_message_fetch_in_window",
        "sse_frames_flowed",
        "sse_entry_appended_seen",
        "sse_no_gap_in_window",
        "session_file_monotonic",
      ]) {
        record(name, "skipped-envblocked", { reason: envBlocked.reason });
      }
    }

    // ---- 11. 阶段 B 钩子：浏览器 URL 模式 ----
    if (args.browserUrl) {
      const url = `${baseUrl}/?logLevel=debug`;
      const info = {
        url,
        sessionId: results.seed.sessionId,
        projectDir,
        agentRoot,
        note: "浏览器打开后手动/自动化执行阶段B脚本，完成时创建本目录 browser-stage-done.marker",
        markerPath: join(tmpRoot, "browser-stage-done.marker"),
      };
      writeFileSync(join(tmpRoot, "browser-info.json"), JSON.stringify(info, null, 2));
      log.info(`阶段 B 钩子：浏览器地址 ${url}`);
      log.info(`等待标记文件 ${info.markerPath}（上限 ${args.browserWaitSecs}s）…`);
      const markerDeadline = Date.now() + args.browserWaitSecs * 1000;
      while (Date.now() < markerDeadline && !existsSync(info.markerPath)) await sleep(1000);
      if (existsSync(info.markerPath)) {
        results.stageB.markerSeen = true;
        log.info("阶段 B 标记已出现，解析服务端诊断行…");
        const diag = parseDiagLines(serverLogFile, turnStart, Date.now());
        results.stageB.diag = diag;
        if (diag.available) {
          record("stageB_graph_repair_zero", diag.graphRepair === 0 && diag.graphRepairFailed === 0 ? "pass" : "fail", diag);
          record("stageB_diag_lines_present", diag.totalFe > 0 ? "pass" : "skipped-stage-b", { totalFe: diag.totalFe });
        } else {
          record("stageB_diag_lines_present", "skipped-stage-b", { note: diag.note });
        }
      } else {
        log.info("阶段 B 标记未出现（超时），诊断断言按 skipped-stage-b 记录");
        record("stageB_graph_repair_zero", "skipped-stage-b", { note: "浏览器标记未出现" });
        record("stageB_session_open_once", "skipped-stage-b", { note: "浏览器标记未出现" });
        record("stageB_viewport_geometry", "skipped-stage-b", { note: "真几何断言属阶段 B 终验 F3" });
      }
    } else {
      record("stageB_graph_repair_zero", "skipped-stage-b", { note: "非 --browser-url 模式；阶段 B/F3 驱动真浏览器时启用" });
      record("stageB_session_open_once", "skipped-stage-b", { note: "同上" });
      record("stageB_viewport_geometry", "skipped-stage-b", { note: "真几何断言属阶段 B 终验 F3" });
    }
  } catch (err) {
    results.fatalError = String(err && err.stack ? err.stack : err);
    log.info(`编排失败：${results.fatalError}`);
  } finally {
    // ---- 清理（成功失败都走）：按 PID 进程组定向终止 + 端口回检 + tmpRoot 处置 ----
    if (server && server.pid) {
      log.info(`清理：进程组终止 pid=${server.pid}`);
      cleanup.serverKilled = killProcessGroup(server.pid, log);
      sse.aborting = true;
      try {
        sse.abortSse?.();
      } catch {}
    }
    if (port != null) {
      cleanup.portFree = await portIsFree(port);
      log.info(`端口 ${port} 回检：${cleanup.portFree ? "已释放" : "仍占用"}`);
    }
    // 孤儿 runner 定向清理（硬化，防 stage B/F3 再泄漏同型）：引擎 schedule runner
    // 会脱离服务进程组改父到 init（PPID 1，R2 实证 PID 2284899 存活 22 分钟并周期性
    // 重建已删 tmpRoot），进程组信号打不到；心跳文件 <agentRoot>/agent/schedule/
    // runners/<pid>.json 登记其 PID，删除 tmpRoot 前逐一定向终结
    const runnersDir = join(agentRoot, "schedule", "runners");
    const orphanPids = new Set();
    try {
      for (const f of readdirSync(runnersDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const hb = JSON.parse(readFileSync(join(runnersDir, f), "utf8"));
          const pid = Number(hb.pid);
          if (Number.isInteger(pid) && pid > 1) orphanPids.add(pid);
        } catch {}
      }
    } catch {}
    if (orphanPids.size > 0) {
      log.info(`孤儿 runner 心跳登记：${[...orphanPids].join(", ")}——定向终结`);
      for (const pid of orphanPids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      const deadDeadline = Date.now() + 3000;
      while (Date.now() < deadDeadline) {
        const allDead = [...orphanPids].every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        });
        if (allDead) break;
        await sleep(200);
      }
      for (const pid of orphanPids) {
        try {
          process.kill(pid, 0);
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    cleanup.orphanRunnersKilled = [...orphanPids];
    if (args.keep) {
      cleanup.keptPath = tmpRoot;
      log.info(`tmpRoot 按 --keep 保留：${tmpRoot}`);
    } else {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
        cleanup.tmpRootRemoved = true;
        log.info("tmpRoot 已删除");
      } catch (err) {
        cleanup.tmpRootRemoved = false;
        log.info(`tmpRoot 删除失败：${err.message}`);
      }
    }

    // ---- 汇总断言状态并落盘 ----
    const fails = assertions.filter((a) => a.status === "fail");
    const skips = assertions.filter((a) => a.status.startsWith("skipped"));
    results.assertions = assertions;
    results.cleanup = cleanup;
    results.ok = fails.length === 0 && !results.fatalError;
    results.summary = {
      pass: assertions.filter((a) => a.status === "pass").length,
      fail: fails.length,
      skippedEnvBlocked: skips.filter((a) => a.status === "skipped-envblocked").length,
      skippedStageB: skips.filter((a) => a.status === "skipped-stage-b").length,
    };
    try {
      writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
      log.info(`结果 JSON 已写：${resultsFile}`);
    } catch (err) {
      log.info(`结果 JSON 写入失败：${err.message}`);
    }
    log.info(
      `收尾：pass=${results.summary.pass} fail=${results.summary.fail} ` +
        `skipped-envblocked=${results.summary.skippedEnvBlocked} skipped-stage-b=${results.summary.skippedStageB}`,
    );
    process.exitCode = results.ok ? 0 : 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  main().catch((err) => {
    console.error(`[qa] 未捕获异常：${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
