/**
 * W5 todo 28 (c) 终态比对：soak 会话 A 的 REST / jsonl / 页面状态条三源一致 +
 * 修正版内存采样（CDP Performance.enable 后取 metrics）。
 * 运行：cd /tmp/opencode/w5-28-qa && bun run soak-verify.ts
 */
import { chromium } from "playwright-core";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const BASE = "http://localhost:17962";
const PASSWORD = "w5soak-qa";
const PROJECT = "/tmp/opencode/w5-28-proj";
const SID = readFileSync("/tmp/opencode/w5-28-qa/soak-session.txt", "utf8").trim();
const LOG = "/tmp/opencode/w5-28-qa/soak-verify.log";

function log(msg: string) {
  console.log(msg);
  appendFileSync(LOG, msg + "\n");
}

let cookie = "";
async function api(method: string, path: string) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", cookie },
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}
function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];

  // ---- REST 口径 ----
  const sessions = await api("GET", `/api/sessions?project=${encodeURIComponent(PROJECT)}`);
  const row = sessions.json.sessions?.find((s: any) => s.id === SID);
  const messages = await api("GET", `/api/sessions/${SID}/messages`);
  const entries: any[] = messages.json.entries ?? [];
  const restMessageEntries = entries.filter((e) => e.type === "message");
  const restUser = restMessageEntries.filter((e) => e.message?.role === "user");
  const restAssistant = restMessageEntries.filter((e) => e.message?.role === "assistant");
  const usage = await api("GET", `/api/usage?session=${SID}`);
  log(`REST: entries=${entries.length} message条目=${restMessageEntries.length} user=${restUser.length} assistant=${restAssistant.length}`);
  log(`REST: sessions行 messageCount=${row?.messageCount} modified=${row?.modified}`);
  log(`REST usage: tokens=${JSON.stringify(usage.json.usage?.tokens)} cost=${usage.json.usage?.cost} userMessages=${usage.json.usage?.userMessages} assistantMessages=${usage.json.usage?.assistantMessages}`);

  // ---- jsonl 磁盘口径 ----
  const sessionPath: string = row?.path ?? "";
  const lines = readFileSync(sessionPath, "utf8").trim().split("\n");
  const diskEntries = lines.map((l) => JSON.parse(l));
  const header = diskEntries[0];
  const diskMessages = diskEntries.filter((e) => e.type === "message");
  const diskUser = diskMessages.filter((e) => e.message?.role === "user");
  const diskAssistant = diskMessages.filter((e) => e.message?.role === "assistant");
  log(`jsonl: 文件=${sessionPath.split("/").at(-1)} 总行=${lines.length} message=${diskMessages.length} user=${diskUser.length} assistant=${diskAssistant.length} header.id=${header.id}`);

  // ---- 页面口径 + 内存采样 ----
  const browser = await chromium.launch({
    executablePath: "/opt/google/chrome/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addCookies([{ name: "ul_omo_session", value: cookie.split("=")[1], domain: "localhost", path: "/" }]);
  const page = await context.newPage();
  await page.goto(`${BASE}/?session=${SID}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").textContent();
  // 状态条：按 status-bar 同公式找 tokens 值（368915 → "369.0k"）
  const expectTotal = usage.json.usage?.tokens?.total ?? 0;
  const expectCost = usage.json.usage?.cost ?? 0;
  const totalStr = fmtTokens(expectTotal);
  const costStr = fmtCost(expectCost);
  log(`页面口径: 含 total(${expectTotal}→${totalStr})=${bodyText?.includes(totalStr)} 含 cost(${costStr})=${bodyText?.includes(costStr)}`);
  // 页面 user 气泡计数（prompt 文本 soak-1..soak-12）
  let pageSoakCount = 0;
  for (let i = 1; i <= 12; i++) {
    if (bodyText?.includes(`soak-${i}`)) pageSoakCount += 1;
  }
  log(`页面口径: soak-N prompt 可见 ${pageSoakCount}/12`);

  // 内存采样（enable 后取，间隔 15s × 6 次 = 90s 窗口）
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const memSamples: number[] = [];
  for (let i = 0; i < 6; i++) {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const heap = metrics.find((m: any) => m.name === "JSHeapUsedSize")?.value ?? 0;
    memSamples.push(Math.round((heap / 1048576) * 10) / 10);
    if (i < 5) await new Promise((r) => setTimeout(r, 15000));
  }
  log(`内存采样(MB, 15s×6): ${memSamples.join(" → ")} 增长=${memSamples[5] - memSamples[0]}MB`);
  const consoleErrors: string[] = [];
  page.on("console", (m: any) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.screenshot({ path: "/tmp/opencode/w5-28-qa/soak-verify-final.png" });
  log(`页面 console 错误（verify 窗口）: ${consoleErrors.length}`);

  // ---- 一致性判定 ----
  const verdict = {
    restVsDiskMessageCount: restMessageEntries.length === diskMessages.length,
    restVsDiskUser: restUser.length === diskUser.length,
    restVsDiskAssistant: restAssistant.length === diskAssistant.length,
    headerIdMatches: header.id === SID,
    pageShowsTotal: bodyText?.includes(totalStr) ?? false,
    pageShowsCost: bodyText?.includes(costStr) ?? false,
    pageSoak12: pageSoakCount === 12,
    memoryGrowthMB: memSamples[5] - memSamples[0],
  };
  writeFileSync("/tmp/opencode/w5-28-qa/soak-verify-result.json", JSON.stringify(verdict, null, 2));
  log(`VERDICT: ${JSON.stringify(verdict)}`);
  await browser.close();
}

main().catch((e) => {
  log(`FATAL: ${e?.stack ?? e}`);
  process.exit(1);
});
