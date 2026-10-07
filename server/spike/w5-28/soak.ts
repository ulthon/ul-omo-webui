/**
 * W5 todo 28 (c) 长会话 soak：30 分钟串行短 prompt + 页面观察 + 3 次刷新。
 * 运行：cd /tmp/opencode/w5-28-qa && bun run soak.ts
 * 服务：http://localhost:17962（DATA_DIR=/tmp/opencode/w5-28-data）
 * 模型：zai-coding-cn/glm-5.3-flash thinking low
 */
import { chromium } from "playwright-core";
import { appendFileSync, writeFileSync } from "node:fs";

const BASE = "http://localhost:17962";
const PASSWORD = "w5soak-qa";
const PROJECT = "/tmp/opencode/w5-28-proj";
const MODEL = "zai-coding-cn/glm-5.3-flash";
const LOG = "/tmp/opencode/w5-28-qa/soak.log";
const TOTAL_MS = 30 * 60 * 1000;
const INTERVAL_MS = 2.5 * 60 * 1000;
const RELOAD_AT_MIN = [10, 20, 28];

const t0 = Date.now();
function ts() {
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  const d = new Date();
  return `[${d.toISOString().slice(11, 19)} +${s}s]`;
}
function log(msg: string) {
  const line = `${ts()} ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
}

let cookie = "";
async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const consoleErrors: string[] = [];
const memorySamples: Array<{ min: number; heapMB: number }> = [];
const reloadChecks: Array<Record<string, unknown>> = [];
let page: any;

async function sampleMemory() {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { metrics } = await cdp.send("Performance.getMetrics");
    const heap = metrics.find((m: any) => m.name === "JSHeapUsedSize")?.value ?? 0;
    memorySamples.push({ min: (Date.now() - t0) / 60000, heapMB: Math.round(heap / 1048576 * 10) / 10 });
    await cdp.detach();
  } catch (e) {
    log(`memory sample 失败: ${e}`);
  }
}

async function reloadAndCheck(expectMinEntries: number, label: string) {
  log(`--- 刷新检查(${label})开始，期望 entries>=${expectMinEntries}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  // 登录态保持（cookie 在 context），等 composer/会话内容出现
  await page.waitForSelector("textarea, [contenteditable]", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);
  // 状态条文本（token 计数）
  const statusText = await page
    .locator("text=/tokens/i")
    .first()
    .textContent({ timeout: 8000 })
    .catch(() => null);
  const bodyText = await page.locator("body").textContent();
  const hasInterrupted = bodyText?.includes("已中断") ?? false;
  reloadChecks.push({
    label,
    at: new Date().toISOString(),
    statusText,
    hasInterruptedBadge: hasInterrupted,
  });
  log(`--- 刷新检查(${label}) statusText=${JSON.stringify(statusText)} 中断徽标=${hasInterrupted}`);
}

async function main() {
  // ---- 登录 + 建会话（REST）----
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const setCookie = loginRes.headers.get("set-cookie") ?? "";
  cookie = setCookie.split(";")[0];
  if (!cookie.includes("senpi_session=")) throw new Error("登录失败");
  log("REST 登录成功");

  const created = await api("POST", "/api/sessions", {
    project: PROJECT,
    model: MODEL,
    thinkingLevel: "low",
  });
  if (created.status !== 201) throw new Error(`建会话失败: ${JSON.stringify(created)}`);
  const sid = created.json.session.id;
  log(`会话 A 建成 id=${sid}`);

  writeFileSync("/tmp/opencode/w5-28-qa/soak-session.txt", sid);

  // ---- 浏览器 ----
  const browser = await chromium.launch({
    executablePath: "/opt/google/chrome/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  // 预注入登录 cookie（绕过登录页，深链直达）
  const domain = "localhost";
  await context.addCookies([
    { name: "senpi_session", value: cookie.split("=")[1], domain, path: "/" },
  ]);
  page = await context.newPage();
  page.on("console", (msg: any) => {
    if (msg.type() === "error") {
      consoleErrors.push(`[min ${(Date.now() - t0) / 60000 | 0}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err: Error) => {
    consoleErrors.push(`[min ${(Date.now() - t0) / 60000 | 0}] pageerror: ${err.message}`);
  });
  // 拦截 messages 响应记 entries 数（页面真实拉取口径）
  page.on("response", async (res: any) => {
    if (res.url().includes(`/api/sessions/${sid}/messages`)) {
      try {
        const j = await res.json();
        log(`页面拉取 messages: entries=${j.entries?.length} cursor=${j.cursor}`);
      } catch {}
    }
  });

  await page.goto(`${BASE}/?session=${sid}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  log("页面已打开（深链 ?session=）");
  await page.screenshot({ path: "/tmp/opencode/w5-28-qa/soak-initial.png" });
  await sampleMemory();

  // ---- soak 主循环 ----
  let lastCursor = 0;
  let totalAssistant = 0;
  let round = 0;
  const reloadSet = new Set(RELOAD_AT_MIN);
  let nextPromptAt = t0;

  while (Date.now() - t0 < TOTAL_MS) {
    const elapsed = Date.now() - t0;
    // 定时刷新检查
    const min = Math.floor(elapsed / 60000);
    if (reloadSet.has(min) && min > 0) {
      reloadSet.delete(min);
      await reloadAndCheck(totalAssistant * 2, `min-${min}`);
      await sampleMemory();
    }
    // 每 60s 内存采样
    if (min !== (memorySamples.at(-1)?.min | 0) && min > (memorySamples.at(-1)?.min ?? -1)) {
      await sampleMemory();
    }
    // 到点发 prompt
    if (Date.now() >= nextPromptAt) {
      round += 1;
      const text = `只回复一行，格式 soak-${round} ok，不要其他内容`;
      const sent = await api("POST", `/api/sessions/${sid}/prompt`, { text });
      if (sent.status !== 200) {
        log(`第 ${round} 条 prompt 发送失败 HTTP ${sent.status}: ${JSON.stringify(sent.json)}`);
        // 409 等待重试一次
        await new Promise((r) => setTimeout(r, 5000));
        const retry = await api("POST", `/api/sessions/${sid}/prompt`, { text });
        if (retry.status !== 200) {
          log(`第 ${round} 条重试仍失败 ${retry.status}，跳过本轮`);
          nextPromptAt = Date.now() + INTERVAL_MS;
          continue;
        }
      }
      const sendAt = Date.now();
      log(`第 ${round} 条 prompt 已发（cursor=${lastCursor}）`);
      // 轮询回合完成：cursor 增量出现 assistant message
      let done = false;
      while (Date.now() - sendAt < 180000) {
        await new Promise((r) => setTimeout(r, 2500));
        const msgs = await api("GET", `/api/sessions/${sid}/messages?cursor=${lastCursor}`);
        if (msgs.status !== 200) {
          log(`GET messages 异常 ${msgs.status}`);
          continue;
        }
        const entries: any[] = msgs.json.entries ?? [];
        if (entries.length > 0) lastCursor = msgs.json.cursor ?? lastCursor;
        const assistant = entries.filter(
          (e) => e.type === "message" && e.message?.role === "assistant",
        );
        if (assistant.length > 0) {
          totalAssistant += assistant.length;
          const usage = assistant[0].message?.usage;
          done = true;
          log(
            `第 ${round} 条完成 ${((Date.now() - sendAt) / 1000).toFixed(1)}s 增量条目=${entries.length} assistant=${assistant.length} usage=${JSON.stringify(usage ?? null)}`,
          );
          break;
        }
      }
      if (!done) log(`第 ${round} 条 180s 未完成（超时）`);
      nextPromptAt += INTERVAL_MS;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // ---- 终态采集 ----
  log("=== soak 30 分钟到，终态采集 ===");
  await sampleMemory();
  await page.screenshot({ path: "/tmp/opencode/w5-28-qa/soak-final.png" });
  const finalSessions = await api("GET", `/api/sessions?project=${encodeURIComponent(PROJECT)}`);
  const finalMessages = await api("GET", `/api/sessions/${sid}/messages`);
  const finalUsage = await api("GET", `/api/usage?session=${sid}`);
  const summary = {
    sessionId: sid,
    roundsSent: round,
    assistantEntries: totalAssistant,
    restEntries: finalMessages.json.entries?.length,
    restCursor: finalMessages.json.cursor,
    sessionsList: finalSessions.json.sessions?.find((s: any) => s.id === sid),
    usage: finalUsage.json.usage,
    memorySamples,
    consoleErrors,
    reloadChecks,
    wallClockMin: ((Date.now() - t0) / 60000).toFixed(1),
  };
  writeFileSync("/tmp/opencode/w5-28-qa/soak-final.json", JSON.stringify(summary, null, 2));
  log(`终态: rounds=${round} assistant=${totalAssistant} entries=${summary.restEntries} usage_tokens=${JSON.stringify(summary.usage?.tokens ?? null)}`);
  log(`console 错误 ${consoleErrors.length} 条; 内存样本 ${memorySamples.length} 个（首 ${memorySamples[0]?.heapMB}MB → 末 ${memorySamples.at(-1)?.heapMB}MB）`);
  log("浏览器关闭，脚本结束");
  await browser.close();
}

main().catch((e) => {
  log(`FATAL: ${e?.stack ?? e}`);
  process.exit(1);
});
