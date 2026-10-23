// 扩展资源面与 auth 凭证检查单测（docs08-2026-10-22 批次任务 24）：
// 清单形态（三目录 + packages、缺目录空态、畸形清单跳过）、启停写入与 400/404、
// auth 三态（伪 CLI 退出码 0/1/2）、spawn 超时不挂、无凭证泄漏、install/remove/update
// 动作路径。全部 mkdtemp 隔离 + 伪 CLI 脚本（不触真实引擎与凭证）。
import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createExtensionsRoutes, type ExtensionsRouteDeps } from "../src/api/routes-extensions";

const ROOTS: string[] = [];
afterEach(() => {
  for ( const r of ROOTS.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "t24-agent-"));
  ROOTS.push(dir);
  return dir;
}

/** 伪引擎 CLI：按 argv 分流——auth check 退 FAKE_AUTH_EXIT（FAKE_AUTH_SLEEP_MS 睡眠）；
 * install/remove/update 追加 marker 行后退 FAKE_ACTION_EXIT */
function writeFakeCli(dir: string): string {
  const cli = join(dir, "fake-omo.js");
  writeFileSync(
    cli,
    `
const marker = process.env.FAKE_MARKER;
const [, , cmd, sub, providerArg] = process.argv;
if (cmd === "auth" && sub === "check") {
  const sleep = Number(process.env.FAKE_AUTH_SLEEP_MS || 0);
  if (sleep > 0) { const t = Date.now(); while (Date.now() - t < sleep) {} }
  const provider = (process.argv[4] === "--provider" ? process.argv[5] : "") || "";
  require("fs").appendFileSync(marker, "auth:" + provider + "\\n");
  process.exit(Number(process.env.FAKE_AUTH_EXIT || 0));
}
if (["install", "remove", "update"].includes(cmd)) {
  require("fs").appendFileSync(marker, cmd + ":" + (process.argv[3] || "") + "\\n");
  process.exit(Number(process.env.FAKE_ACTION_EXIT || 0));
}
process.exit(2);
`,
    "utf8",
  );
  return cli;
}

function makeDeps(agentDir: string, opts?: { timeoutMs?: number }): ExtensionsRouteDeps {
  return {
    agentDir,
    engineCli: { nodeBin: process.execPath, cliJs: join(agentDir, "fake-omo.js") },
    ...(opts?.timeoutMs !== undefined ? { authTimeoutMs: opts.timeoutMs } : {}),
  };
}

function makeApp(deps: ExtensionsRouteDeps): Hono {
  const app = new Hono();
  app.route("/", createExtensionsRoutes(deps));
  return app;
}

async function req(app: Hono, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await app.request(path, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 纯文本兜底
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------- 清单

test("GET /api/extensions：三目录 + packages 清单形态，畸形清单跳过，缺目录空态", async () => {
  const dir = makeAgentDir();
  mkdirSync(join(dir, "extensions"), { recursive: true });
  writeFileSync(join(dir, "extensions", "diff.js"), "x", "utf8");
  mkdirSync(join(dir, "skills", "audio-design"), { recursive: true });
  writeFileSync(join(dir, "skills", "audio-design", "SKILL.md"), "x", "utf8");
  mkdirSync(join(dir, "skills", "broken-no-skill-md"), { recursive: true }); // 畸形：无 SKILL.md
  mkdirSync(join(dir, "prompts"), { recursive: true });
  writeFileSync(join(dir, "prompts", "pause-plan.md"), "x", "utf8");
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ packages: ["npm:oh-my-pi@0.2.0"], extensionsState: { "extension/diff": false } }),
    "utf8",
  );
  const res = await req(makeApp(makeDeps(dir)), "/api/extensions");
  expect(res.status).toBe(200);
  expect(res.body.cliAvailable).toBe(true);
  const items = res.body.items as Array<{ name: string; kind: string; enabled: boolean; source?: string }>;
  const pick = (kind: string, name: string) => items.find((i) => i.kind === kind && i.name === name);
  expect(pick("extension", "diff")).toEqual({ name: "diff", kind: "extension", enabled: false });
  expect(pick("skill", "audio-design")?.enabled).toBe(true);
  expect(pick("skill", "broken-no-skill-md")).toBeUndefined();
  expect(pick("prompt", "pause-plan")?.enabled).toBe(true);
  expect(pick("package", "oh-my-pi")).toEqual({
    name: "oh-my-pi",
    kind: "package",
    enabled: true,
    source: "npm:oh-my-pi@0.2.0",
  });
});

test("GET /api/extensions：空 agentDir 诚实空态；engineCli=null 降级 cliAvailable=false", async () => {
  const dir = makeAgentDir();
  const res = await req(makeApp({ agentDir: dir, engineCli: null }), "/api/extensions");
  expect(res.status).toBe(200);
  expect(res.body.items).toEqual([]);
  expect(res.body.cliAvailable).toBe(false); // deps 未注入 cli（engineCli=null 场景）
});

// ---------------------------------------------------------------- 启停

test("PUT /api/extensions/:name：启停写入 settings.json（串行锁内读-改-写），GET 反映", async () => {
  const dir = makeAgentDir();
  mkdirSync(join(dir, "skills", "mail"), { recursive: true });
  writeFileSync(join(dir, "skills", "mail", "SKILL.md"), "x", "utf8");
  const app = makeApp(makeDeps(dir));
  const res = await req(app, "/api/extensions/mail", {
    method: "PUT",
    body: JSON.stringify({ enabled: false, kind: "skill" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ name: "mail", kind: "skill", enabled: false });
  // 落盘：settings.json extensionsState；既有键不丢
  const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(saved.extensionsState).toEqual({ "skill/mail": false });
  const list = await req(app, "/api/extensions");
  expect((list.body.items as Array<{ kind: string; enabled: boolean }>).find((i) => i.kind === "skill")?.enabled).toBe(false);
  // 反向开回
  await req(app, "/api/extensions/mail", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, kind: "skill" }),
    headers: { "content-type": "application/json" },
  });
  expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).extensionsState["skill/mail"]).toBe(true);
});

test("PUT 校验：enabled 非布尔 400 invalid_enabled；未知资源 404 extension_not_found；kind 缺失 400", async () => {
  const dir = makeAgentDir();
  const app = makeApp(makeDeps(dir));
  const bad = await req(app, "/api/extensions/x", {
    method: "PUT",
    body: JSON.stringify({ enabled: "yes", kind: "skill" }),
    headers: { "content-type": "application/json" },
  });
  expect(bad.status).toBe(400);
  expect((bad.body as { error: { code: string } }).error.code).toBe("invalid_enabled");
  const missing = await req(app, "/api/extensions/ghost", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, kind: "prompt" }),
    headers: { "content-type": "application/json" },
  });
  expect(missing.status).toBe(404);
  expect((missing.body as { error: { code: string } }).error.code).toBe("extension_not_found");
  const noKind = await req(app, "/api/extensions/x", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
    headers: { "content-type": "application/json" },
  });
  expect(noKind.status).toBe(400);
  expect((noKind.body as { error: { code: string } }).error.code).toBe("invalid_kind");
});

test("PUT 复合名 kind/name 合法；package 拒绝启停", async () => {
  const dir = makeAgentDir();
  mkdirSync(join(dir, "extensions"), { recursive: true });
  writeFileSync(join(dir, "extensions", "tps.js"), "x", "utf8");
  const app = makeApp(makeDeps(dir));
  const res = await req(app, "/api/extensions/extension%2Ftps", {
    method: "PUT",
    body: JSON.stringify({ enabled: false }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ name: "tps", kind: "extension", enabled: false });
  const pkg = await req(app, "/api/extensions/oh-my-pi", {
    method: "PUT",
    body: JSON.stringify({ enabled: false, kind: "package" }),
    headers: { "content-type": "application/json" },
  });
  expect(pkg.status).toBe(400);
  expect((pkg.body as { error: { code: string } }).error.code).toBe("invalid_kind");
});

// ---------------------------------------------------------------- auth 三态 + 无泄漏 + 超时

test("GET /api/auth/status：伪 CLI 退出码 0/1/2 → ready/not_configured/error", async () => {
  const dir = makeAgentDir();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "zai-coding-cn" }), "utf8");
  writeFakeCli(dir);
  const marker = join(dir, "marker.log");
  process.env.FAKE_MARKER = marker;
  try {
    for (const [exit, expectStatus] of [[0, "ready"], [1, "not_configured"], [2, "error"]] as const) {
      process.env.FAKE_AUTH_EXIT = String(exit);
      const res = await req(makeApp(makeDeps(dir)), "/api/auth/status");
      expect(res.status).toBe(200);
      expect((res.body as { status: string; provider: string }).status).toBe(expectStatus);
      expect((res.body as { provider: string }).provider).toBe("zai-coding-cn");
    }
    // 真实调用了伪 CLI（provider 透传）
    expect(readFileSync(marker, "utf8").split("\n").filter(Boolean)).toEqual([
      "auth:zai-coding-cn",
      "auth:zai-coding-cn",
      "auth:zai-coding-cn",
    ]);
  } finally {
    delete process.env.FAKE_MARKER;
    delete process.env.FAKE_AUTH_EXIT;
  }
});

test("GET /api/auth/status：无 provider（settings+auth.json 皆无）→ not_configured 不 spawn", async () => {
  const dir = makeAgentDir();
  const marker = join(dir, "marker.log");
  process.env.FAKE_MARKER = marker;
  try {
    const res = await req(makeApp(makeDeps(dir)), "/api/auth/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "not_configured", provider: null });
    expect(existsSync(marker)).toBe(false);
  } finally {
    delete process.env.FAKE_MARKER;
  }
});

test("GET /api/auth/status：绝不回显凭证材料；超时降级 error 不挂", async () => {
  const dir = makeAgentDir();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "stub" }), "utf8");
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ stub: { type: "api", key: "t24-super-secret-key" } }), "utf8");
  writeFakeCli(dir);
  process.env.FAKE_MARKER = join(dir, "marker.log");
  process.env.FAKE_AUTH_SLEEP_MS = "4000";
  try {
    const started = Date.now();
    const res = await req(makeApp(makeDeps(dir, { timeoutMs: 300 })), "/api/auth/status");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5000);
    expect(res.body).toMatchObject({ status: "error" });
    expect((res.body as { detail: string }).detail).toContain("超时");
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("t24-super-secret-key");
    expect(text).not.toContain('"key"');
  } finally {
    delete process.env.FAKE_MARKER;
    delete process.env.FAKE_AUTH_SLEEP_MS;
  }
});

// ---------------------------------------------------------------- install / remove / update

test("POST install/remove/update：伪 CLI 动作路径（ok=true + 调用留痕；失败 502；缺 source 400）", async () => {
  const dir = makeAgentDir();
  writeFakeCli(dir);
  const marker = join(dir, "marker.log");
  process.env.FAKE_MARKER = marker;
  try {
    const app = makeApp(makeDeps(dir));
    const ins = await req(app, "/api/extensions/install", {
      method: "POST",
      body: JSON.stringify({ source: "npm:oh-my-pi@0.2.0" }),
      headers: { "content-type": "application/json" },
    });
    expect(ins.status).toBe(200);
    expect(ins.body.ok).toBe(true);
    const upd = await req(app, "/api/extensions/update", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(upd.body.ok).toBe(true);
    const rem = await req(app, "/api/extensions/remove", {
      method: "POST",
      body: JSON.stringify({ source: "npm:oh-my-pi@0.2.0" }),
      headers: { "content-type": "application/json" },
    });
    expect(rem.body.ok).toBe(true);
    expect(readFileSync(marker, "utf8").split("\n").filter(Boolean)).toEqual([
      "install:npm:oh-my-pi@0.2.0",
      "update:",
      "remove:npm:oh-my-pi@0.2.0",
    ]);
    // CLI 失败 → 502 ok=false
    process.env.FAKE_ACTION_EXIT = "1";
    const fail = await req(app, "/api/extensions/install", {
      method: "POST",
      body: JSON.stringify({ source: "npm:broken" }),
      headers: { "content-type": "application/json" },
    });
    expect(fail.status).toBe(502);
    expect(fail.body.ok).toBe(false);
    delete process.env.FAKE_ACTION_EXIT;
    // 缺 source → 400
    const noSource = await req(app, "/api/extensions/install", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(noSource.status).toBe(400);
    expect((noSource.body as { error: { code: string } }).error.code).toBe("invalid_source");
  } finally {
    delete process.env.FAKE_MARKER;
    delete process.env.FAKE_ACTION_EXIT;
  }
});
