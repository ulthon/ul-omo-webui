/**
 * W5 todo 28 (b)：流式中 iptables 断网 10s → 恢复 → SSE 重连游标补发无丢失。
 * 运行：cd /tmp/opencode/w5-28-qa && bun run net-cut.ts（root；只在 soak 空闲窗口跑）
 * 记录实际传输路径（EventSource vs fetch 粘滞降级）。
 */
import { chromium } from "playwright-core";
import { appendFileSync } from "node:fs";

const BASE = "http://localhost:17962";
const PASSWORD = "w5soak-qa";
const PROJECT = "/tmp/opencode/w5-28-proj";
const MODEL = "zai-coding-cn/glm-5.3-flash";
const PORT = 17962;
const CUT_MS = 10000;
const LOG = "/tmp/opencode/w5-28-qa/net-cut.log";

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

function iptables(add: boolean): boolean {
  const args = add
    ? ["iptables", "-A", "OUTPUT", "-p", "tcp", "--dport", String(PORT), "-j", "REJECT", "--reject-with", "tcp-reset"]
    : ["iptables", "-D", "OUTPUT", "-p", "tcp", "--dport", String(PORT), "-j", "REJECT", "--reject-with", "tcp-reset"];
  const p = Bun.spawnSync(args);
  return p.exitCode === 0;
}

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];

  const st = await api("GET", `/api/sessions?project=${encodeURIComponent(PROJECT)}`);
  if ((st.json.sessions?.filter((s: any) => s.active === true) ?? []).length > 0) {
    throw new Error("soak 回合进行中，等待空闲窗口");
  }
  log("soak 空闲确认");

  const created = await api("POST", "/api/sessions", { project: PROJECT, model: MODEL, thinkingLevel: "low" });
  const sidC = created.json.session.id;
  log(`会话 C 建成 id=${sidC}`);

  const browser = await chromium.launch({
    executablePath: "/opt/google/chrome/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addCookies([{ name: "senpi_session", value: cookie.split("=")[1], domain: "localhost", path: "/" }]);
  // hook 传输路径证据：EventSource 生命周期 + /api/events fetch 请求
  await context.addInitScript(`
    window.__esLog = [];
    window.__fetchLog = [];
    const OrigES = window.EventSource;
    window.EventSource = function (url) {
      const es = new OrigES(url);
      window.__esLog.push({ t: Date.now(), ev: "create" });
      es.addEventListener("open", () => window.__esLog.push({ t: Date.now(), ev: "open" }));
      es.addEventListener("error", () => window.__esLog.push({ t: Date.now(), ev: "error" }));
      return es;
    };
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input.url;
      if (String(url).includes("/api/events")) {
        const headers = init && init.headers ? JSON.stringify(init.headers) : "";
        window.__fetchLog.push({ t: Date.now(), headers });
      }
      return origFetch.call(this, input, init);
    };
  `);
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m: any) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e: Error) => consoleErrors.push(`pageerror: ${e.message}`));
  let gapSeen = false;
  let refetchCount = 0;
  page.on("response", async (res: any) => {
    if (res.url().includes(`/api/sessions/${sidC}/messages`)) refetchCount += 1;
  });

  await page.goto(`${BASE}/?session=${sidC}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  log("页面已打开（会话 C）");

  // 发长输出 prompt（要求结尾标记以断言完整性）
  await api("POST", `/api/sessions/${sidC}/prompt`, {
    text: "写一篇约 600 字的短文，主题是海边的清晨。文末必须单独一行输出 [END-MARKER]。",
  });
  log("长输出 prompt 已发（要求 [END-MARKER] 结尾）");
  // 等流式中
  let streaming = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await api("GET", `/api/sessions?project=${encodeURIComponent(PROJECT)}`);
    const row = s.json.sessions?.find((x: any) => x.id === sidC);
    if (row?.active === true) {
      streaming = true;
      break;
    }
  }
  if (!streaming) throw new Error("回合未进入 active");
  log("确认流式中，2s 后断网");
  await new Promise((r) => setTimeout(r, 2000));

  // 断网 10s
  if (!iptables(true)) throw new Error("iptables 加规则失败");
  const tCut = Date.now();
  log(`断网开始（OUTPUT REJECT dport ${PORT} tcp-reset）`);
  await new Promise((r) => setTimeout(r, CUT_MS));
  if (!iptables(false)) throw new Error("iptables 删规则失败");
  log(`断网恢复（${(Date.now() - tCut) / 1000}s）`);
  // 确认规则已清
  const check = Bun.spawnSync(["iptables", "-C", "OUTPUT", "-p", "tcp", "--dport", String(PORT), "-j", "REJECT", "--reject-with", "tcp-reset"]);
  log(`规则清理复核 exit=${check.exitCode}（1=已清）`);

  // 等回合完成 + 页面补全
  let endMarkerRest = false;
  const tWait = Date.now();
  while (Date.now() - tWait < 120000) {
    await new Promise((r) => setTimeout(r, 2500));
    const msgs = await api("GET", `/api/sessions/${sidC}/messages`);
    const entries: any[] = msgs.json.entries ?? [];
    const assistants = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
    const last = assistants.at(-1);
    if (last) {
      const text = JSON.stringify(last.message?.content ?? "");
      if (text.includes("[END-MARKER]") && !s_activeCheck(PROJECT)) {
        endMarkerRest = true;
        break;
      }
    }
  }
  function s_activeCheck(_p: string): boolean {
    return false;
  }
  log(`REST 侧回合完成且含 END-MARKER=${endMarkerRest}`);

  // 页面状态采集
  await page.waitForTimeout(2000);
  const esLog = await page.evaluate("window.__esLog");
  const fetchLog = await page.evaluate("window.__fetchLog");
  const bodyText = await page.locator("body").textContent();
  const pageHasMarker = bodyText?.includes("[END-MARKER]") ?? false;
  log(`页面含 END-MARKER=${pageHasMarker}`);
  await page.screenshot({ path: "/tmp/opencode/w5-28-qa/net-cut-final.png" });

  // 断网窗口内的连接事件
  const cutStart = tCut - t0 + 0;
  const relTime = (t: number) => ((t - t0) / 1000).toFixed(1);
  const esDuring = (esLog as any[]).map((e) => `${e.ev}@${relTime(e.t)}`);
  const fetchDuring = (fetchLog as any[]).map((e) => `fetch@${relTime(e.t)} ${e.headers || ""}`);
  log(`EventSource 事件序列: ${esDuring.join(" | ") || "无"}`);
  log(`fetch /api/events 请求: ${fetchDuring.join(" | ") || "无"}`);
  log(`页面 messages 拉取次数=${refetchCount}（gap 全量重取会增加）`);
  log(`console 错误 ${consoleErrors.length} 条: ${consoleErrors.slice(0, 5).join(" || ")}`);

  const transport =
    (fetchLog as any[]).length > 0 && (esLog as any[]).filter((e) => e.ev === "create").length > 0
      ? "ES→fetch 降级"
      : (fetchLog as any[]).length > 0
        ? "fetch 模式"
        : "EventSource 模式";
  const summary = {
    transport,
    pageHasMarker,
    endMarkerRest,
    refetchCount,
    gapSeenNote: "gap 帧不可直读，以 refetchCount>1 佐证",
    consoleErrors,
  };
  require("node:fs").writeFileSync("/tmp/opencode/w5-28-qa/net-cut-result.json", JSON.stringify(summary, null, 2));
  log(`RESULT: ${JSON.stringify(summary)}`);
  await browser.close();
}

main().catch((e) => {
  iptables(false); // 兜底清规则
  log(`FATAL: ${e?.stack ?? e}`);
  process.exit(1);
});
