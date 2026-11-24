#!/usr/bin/env node
// README 截图采集：登录隔离实例，截电脑端两张、手机端三张，再用真实引擎触发一次权限确认卡截一张。
// 前置：seed-demo.mjs seed / serve / apply 已跑过。用法：
//   node scripts/screenshots/capture.mjs --root /tmp/omo-demo/zh-CN --lang zh-CN --out docs/screenshots/zh-CN --port 7799
// 浏览器走 omo-ai 自带的 omowright（server/node_modules 里的 browser 技能脚本），无头 Chrome，独立 profile。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { loadOmowright } = await import("../../server/node_modules/omo-ai/plugin/skills/browser/scripts/omowright.mjs");
const { omowright } = await loadOmowright();

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((token, index, all) => [token.replace(/^--/, ""), token.startsWith("--") && !all[index + 1]?.startsWith("--") ? all[index + 1] : true])
    .filter(([key]) => key),
);
const root = resolve(args.root ?? "/tmp/omo-demo/zh-CN");
const lang = args.lang ?? "zh-CN";
const out = resolve(args.out ?? `docs/screenshots/${lang}`);
const port = Number(args.port ?? 7799);
// --only desktop,mobile,permission：只跑指定段（补截单张时用）
const only = typeof args.only === "string" ? new Set(args.only.split(",")) : null;
const want = (name) => !only || only.has(name);
const url = `http://127.0.0.1:${port}`;
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const main = manifest.sessions[0];
const t = {
  "zh-CN": { overviewTab: "总览", filesTab: "文件", openSidebar: "打开侧栏", closeDrawer: "关闭会话抽屉", openPanel: "打开任务面板", closePanel: "关闭任务面板", permission: "权限请求", prompt: "只做一件事：运行 npm test，把输出原样贴给我。不要先读文件。", permTitle: "跑一遍测试看失败用例" },
  en: { overviewTab: "Overview", filesTab: "Files", openSidebar: "Open sidebar", closeDrawer: "Close session drawer", openPanel: "Open task panel", closePanel: "Close task panel", permission: "Permission request", prompt: "Do exactly one thing: run npm test and paste the output as is. Do not read any files first.", permTitle: "Run the tests and list failures" },
}[lang];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = "";
async function call(method, path, body) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
await call("POST", "/api/auth/login", { password: "demo-pass" });

// 引擎即会话：状态条的 token/费用来自会话专属引擎，只看不会自动拉起；一次空 abort 即可绑定，
// 然后等用量接口能从会话文件里算出数字（引擎冷启动最长约 90 秒）。
async function bindEngine(sessionId) {
  await call("POST", `/api/sessions/${sessionId}/abort`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { usage } = await call("GET", `/api/usage?session=${sessionId}`);
    if (usage.assistantMessages > 0) return;
    await sleep(2000);
  }
  throw new Error(`engine for ${sessionId} did not come up`);
}

mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "omo-shot-profile-"));
const storage = mkdtempSync(join(tmpdir(), "omo-shot-storage-"));
const browser = await omowright.connectPipe({
  browserPath: "/usr/bin/google-chrome",
  browserArgs: ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "--window-size=1920,1080", `--lang=${lang}`],
  storageRoot: storage,
  dialogPolicy: { accept: true },
});
const clickVisible = async (page, selector) => {
  const ok = await page.evaluate((s) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.getBoundingClientRect().width > 0);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
  if (!ok) throw new Error(`no visible element for ${selector}`);
};
const shot = async (page, name) => {
  const png = await page.screenshot();
  writeFileSync(join(out, name), png);
  console.log(`${name} ${(png.length / 1024).toFixed(0)} KB`);
};
try {
  const page = await browser.newTab(`${url}/login`);
  // 界面语言取自 localStorage（kv 未设 ui.language 时以它为准；无头浏览器的 navigator.language 不可靠）
  await page.evaluate((l) => localStorage.setItem("ul_omo_language", l), lang);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.fill('input[type="password"]', "demo-pass");
  await page.locator('input[type="password"]').press("Enter");
  await page.waitForURL((u) => !String(u).includes("/login"), { timeout: 20_000 });
  await page.evaluate((l) => localStorage.setItem("ul_omo_language", l), lang);

  // 电脑端：主会话 + 右栏文件预览
  if (want("desktop")) {
    await bindEngine(main.id);
  await page.goto(`${url}/?session=${main.id}`);
  await page.getByText(manifest.sessions[0].title).first().waitFor({ timeout: 20_000 });
  await sleep(2500);
  await shot(page, "desktop-session.png");
  const tabs = page.getByRole("tab", { name: t.filesTab });
  await tabs.last().click();
  await page.waitForSelector('[data-testid="rail-files-row-name-src"]', { timeout: 15_000 });
  await clickVisible(page, '[data-testid="rail-files-row-name-src"]');
  await page.waitForSelector('[data-testid="rail-files-row-name-index.ts"]', { timeout: 15_000 });
  await clickVisible(page, '[data-testid="rail-files-row-name-index.ts"]');
  await sleep(1800);
  await shot(page, "desktop-files.png");
  // 右栏页签会记在 localStorage 里，切回总览，手机端打开面板时才是任务/笔记视图
    await page.getByRole("tab", { name: t.overviewTab }).last().click();
    await sleep(400);
  }

  // 手机端：会话视图、会话抽屉、任务面板
  if (want("mobile")) {
    await page.setViewportSize({ width: 390, height: 844 });
    await bindEngine(main.id);
  await page.goto(`${url}/?session=${main.id}`);
  await page.getByText(manifest.sessions[0].title).first().waitFor({ timeout: 20_000 });
  await sleep(2500);
  await shot(page, "mobile-session.png");
  await clickVisible(page, `[aria-label="${t.openSidebar}"]`);
  await sleep(900);
  await shot(page, "mobile-sessions.png");
  await clickVisible(page, `[aria-label="${t.closeDrawer}"]`);
  await sleep(500);
  await clickVisible(page, `[aria-label="${t.openPanel}"]`);
  await sleep(1200);
  await shot(page, "mobile-panel.png");
  await clickVisible(page, `[aria-label="${t.closePanel}"]`).catch(() => page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))));
  }

  // 权限确认卡：不是持久化数据，只能让引擎真的问一次。项目预设改成 ask，新会话发一条会跑 bash 的请求。
  // 模型偶尔会一轮跑很久都不问，最多换新会话试两次。
  if (want("permission")) {
  await page.setViewportSize({ width: 390, height: 844 });
  const project = manifest.projects[0].path;
  await call("PATCH", "/api/projects/meta", { path: project, permissionPreset: "ask" });
  for (let attempt = 1; ; attempt++) {
    const { session } = await call("POST", "/api/sessions", { project });
    await call("PATCH", `/api/sessions/${session.id}/meta`, { renamedTitle: t.permTitle });
    await page.goto(`${url}/?session=${session.id}`);
    await page.getByText(t.permTitle).first().waitFor({ timeout: 20_000 });
    await call("POST", `/api/sessions/${session.id}/prompt`, { text: t.prompt });
    const card = page.getByText(t.permission).first();
    try {
      await card.waitFor({ timeout: 90_000 });
    } catch (error) {
      await call("POST", `/api/sessions/${session.id}/abort`);
      await call("DELETE", `/api/sessions/${session.id}`);
      if (attempt >= 2) throw error;
      console.log("permission card did not show up, retrying with a new session");
      continue;
    }
    await sleep(400);
    await shot(page, "permission-card.png");
    await call("POST", `/api/sessions/${session.id}/abort`);
    await call("DELETE", `/api/sessions/${session.id}`);
    break;
  }
  await call("PATCH", "/api/projects/meta", { path: project, permissionPreset: null });
  }
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(storage, { recursive: true, force: true });
}
