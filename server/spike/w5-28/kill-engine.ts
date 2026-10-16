/**
 * W5 todo 28 (a)：流式中段 kill -9 引擎子进程 → 自动重启 → 前端恢复 → 历史完整 → 可继续。
 * 运行：cd /tmp/opencode/w5-28-qa && bun run kill-engine.ts
 * 注意：只在 soak 会话空闲窗口执行（杀进程会中断同项目引擎承载的全部会话回合）。
 */
import { chromium } from "playwright-core";
import { appendFileSync } from "node:fs";

const BASE = "http://localhost:17962";
const PASSWORD = "w5soak-qa";
const PROJECT = "/tmp/opencode/w5-28-proj";
const MODEL = "zai-coding-cn/glm-5.3-flash";
const LOG = "/tmp/opencode/w5-28-qa/kill-engine.log";

const t0 = Date.now();
function ts() {
  return `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
}
function log(msg: string) {
  const line = `${ts()} ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
}

let cookie = "";
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** /proc 精确定位本项目引擎主进程：cwd=项目目录 且 cmdline 为单字段 "senpi"
 * （launcher execve 后 setProcessTitle 覆盖；ast-grep-mcp/py kernel 等子进程
 * cmdline 含完整路径，不匹配）。 */
function findEnginePids(): Array<{ pid: number; cmdline: string }> {
  const out: Array<{ pid: number; cmdline: string }> = [];
  const dir = "/proc";
  for (const name of require("node:fs").readdirSync(dir)) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const cwd = require("node:fs").readlinkSync(`/proc/${pid}/cwd`);
      if (cwd !== PROJECT) continue;
      const fields = require("node:fs").readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const isMain = (fields.length === 1 && fields[0] === "senpi") || fields.some((f: string) => f.endsWith("bundle/cli.js"));
      if (isMain) out.push({ pid, cmdline: fields.join(" ") });
    } catch {
      // 进程已退出
    }
  }
  return out;
}

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];

  // soak 空闲确认：项目无 active 回合
  const st = await api("GET", `/api/sessions?project=${encodeURIComponent(PROJECT)}`);
  const actives = st.json.sessions?.filter((s: any) => s.active === true) ?? [];
  if (actives.length > 0) throw new Error(`soak 回合进行中，禁止杀进程: ${actives.map((s: any) => s.id)}`);
  log("soak 空闲确认（无 active 回合）");

  const created = await api("POST", "/api/sessions", { project: PROJECT, model: MODEL, thinkingLevel: "low" });
  const sidB = created.json.session.id;
  log(`会话 B 建成 id=${sidB}`);

  // 浏览器
  const browser = await chromium.launch({
    executablePath: "/opt/google/chrome/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addCookies([{ name: "ul_omo_session", value: cookie.split("=")[1], domain: "localhost", path: "/" }]);
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m: any) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e: Error) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/?session=${sidB}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  log("页面已打开（会话 B）");

  // 发长输出 prompt（REST 驱动，页面 SSE 观察）
  await api("POST", `/api/sessions/${sidB}/prompt`, {
    text: "写一篇约 800 字的散文，主题是秋天的山野。直接输出正文。",
  });
  log("长输出 prompt 已发");
  // 等待回合进行中（active=true）
  let streaming = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await api("GET", `/api/sessions?project=${encodeURIComponent(PROJECT)}`);
    const row = s.json.sessions?.find((x: any) => x.id === sidB);
    if (row?.active === true) {
      streaming = true;
      break;
    }
  }
  if (!streaming) throw new Error("回合未进入 active（无法确认流式中）");
  log("确认流式中（active=true），再等 2s 让输出充分展开");
  await new Promise((r) => setTimeout(r, 2000));

  // 精确 kill -9
  const engines = findEnginePids();
  if (engines.length !== 1) throw new Error(`引擎进程数异常: ${JSON.stringify(engines)}`);
  const victim = engines[0];
  log(`kill -9 ${victim.pid}（cmdline: ${victim.cmdline.slice(0, 120)}）`);
  const tKill = Date.now();
  process.kill(victim.pid, "SIGKILL");

  // 观察重启（新引擎进程出现）
  let newPid: number | null = null;
  let tReady: number | null = null;
  while (Date.now() - tKill < 30000) {
    await new Promise((r) => setTimeout(r, 300));
    const now = findEnginePids();
    const fresh = now.find((e) => e.pid !== victim.pid);
    if (fresh) {
      newPid = fresh.pid;
      tReady = Date.now();
      break;
    }
  }
  log(`引擎重启: 新 pid=${newPid}，耗时 ${tReady ? ((tReady - tKill) / 1000).toFixed(2) : "未检出"}s`);

  // 观察 composer 解锁（停止生成按钮消失 / textarea 可用）
  let tUnlock: number | null = null;
  while (Date.now() - tKill < 30000) {
    await new Promise((r) => setTimeout(r, 300));
    const stopBtn = await page.locator("text=停止生成").count().catch(() => 0);
    const ta = await page.locator("textarea").count().catch(() => 0);
    if (stopBtn === 0 && ta > 0) {
      tUnlock = Date.now();
      break;
    }
  }
  log(`composer 解锁: ${tUnlock ? `${((tUnlock - tKill) / 1000).toFixed(1)}s（自 kill 时刻）` : "30s 未解锁"}`);
  await page.screenshot({ path: "/tmp/opencode/w5-28-qa/kill-after-unlock.png" });

  // REST 口径：active 回落（重启窗口期引擎未就绪时 peek 返回 null，active=null 同样属回落）
  let activeFalseAt: number | null = null;
  while (Date.now() - tKill < 30000) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await api("GET", `/api/sessions?project=${encodeURIComponent(PROJECT)}`);
    const row = s.json.sessions?.find((x: any) => x.id === sidB);
    if (row?.active !== true) {
      activeFalseAt = Date.now();
      break;
    }
  }
  log(`active 回落 false: ${activeFalseAt ? `${((activeFalseAt - tKill) / 1000).toFixed(1)}s` : "30s 未回落"}`);

  // 崩溃时刻页面消息数（刷新前基准）
  const beforeBody = await page.locator("body").textContent();
  log(`刷新前页面含 prompt 文本=${beforeBody?.includes("秋天的山野") ?? false}`);

  // 刷新 → 历史完整
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const afterBody = await page.locator("body").textContent();
  const historyOk = afterBody?.includes("秋天的山野") ?? false;
  log(`刷新后历史完整（user prompt 可见）=${historyOk}`);
  await page.screenshot({ path: "/tmp/opencode/w5-28-qa/kill-after-reload.png" });

  // 可继续发新 prompt
  const tContinue = Date.now();
  const cont = await api("POST", `/api/sessions/${sidB}/prompt`, { text: "只回复一行: continue-ok" });
  log(`新 prompt HTTP ${cont.status}`);
  let continueOk = false;
  if (cont.status === 200) {
    // 轮询 assistant 完成
    while (Date.now() - tContinue < 120000) {
      await new Promise((r) => setTimeout(r, 2500));
      const msgs = await api("GET", `/api/sessions/${sidB}/messages`);
      const entries: any[] = msgs.json.entries ?? [];
      const assistants = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
      const last = assistants.at(-1);
      if (last && JSON.stringify(last.message?.content ?? "").includes("continue-ok")) {
        continueOk = true;
        break;
      }
    }
  }
  log(`可继续发新 prompt 且正常完成=${continueOk}`);

  const summary = {
    killPid: victim.pid,
    newPid,
    restartSec: tReady ? (tReady - tKill) / 1000 : null,
    unlockSec: tUnlock ? (tUnlock - tKill) / 1000 : null,
    activeFalseSec: activeFalseAt ? (activeFalseAt - tKill) / 1000 : null,
    historyOk,
    continueOk,
    consoleErrors,
  };
  require("node:fs").writeFileSync("/tmp/opencode/w5-28-qa/kill-engine-result.json", JSON.stringify(summary, null, 2));
  log(`RESULT: ${JSON.stringify(summary)}`);
  await browser.close();
}

main().catch((e) => {
  log(`FATAL: ${e?.stack ?? e}`);
  process.exit(1);
});
