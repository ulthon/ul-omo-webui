// provider 认证配置面单测（凭证列表/删除/逐个检查/baseUrl 同步批次）：
// - GET /api/auth/providers：掩码（长 key 前3后4、短 key 全掩码）、缺失 auth.json → 空数组、
//   hasBaseUrl 对齐 models.json、响应无明文 key；
// - DELETE /api/auth/providers/:id：删除生效、不存在 404、原子写不破坏其他条目；
// - POST /api/auth/check：指定 provider 的 CLI 检查（伪 CLI 读 --provider 参数）、入参校验；
// - POST /api/auth/credentials + baseUrl：ready 落 models.json（新建/只改 baseUrl）；
//   非 ready 回滚（models.json 原本不存在 → 不落文件；已有 → 其余字段不动）。
// 全部 mkdtemp 隔离，伪引擎 CLI 同 routes-auth-credentials.test.ts。
import { describe, expect, test, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createExtensionsRoutes, type ExtensionsRouteDeps } from "../src/api/routes-extensions";

const ROOTS: string[] = [];
afterEach(() => {
  for (const r of ROOTS.splice(0)) rmSync(r, { recursive: true, force: true });
  delete process.env.FAKE_EXPECT_KEY;
  delete process.env.FAKE_AUTH_EXIT;
  vi.unstubAllGlobals();
});

function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "t-prov-auth-"));
  ROOTS.push(dir);
  return dir;
}

/** 伪引擎 CLI：auth check 读 auth.json，argv[5]（--provider 值）比对 FAKE_EXPECT_KEY */
function writeFakeCli(dir: string): string {
  const cli = join(dir, "fake-omo.js");
  writeFileSync(
    cli,
    `
const [, , cmd, sub] = process.argv;
if (cmd === "auth" && sub === "check") {
  const fs = require("fs");
  const agentDir = process.env.OMO_CODING_AGENT_DIR;
  let key = null;
  try {
    const doc = JSON.parse(fs.readFileSync(require("path").join(agentDir, "auth.json"), "utf8"));
    const provider = process.argv[5] || Object.keys(doc)[0];
    key = doc[provider] && doc[provider].key;
  } catch {}
  if (key != null && key === process.env.FAKE_EXPECT_KEY) process.exit(0);
  process.exit(Number(process.env.FAKE_AUTH_EXIT || 1));
}
process.exit(2);
`,
    "utf8",
  );
  return cli;
}

function makeApp(agentDir: string): Hono {
  const deps: ExtensionsRouteDeps = {
    agentDir,
    engineCli: { nodeBin: process.execPath, cliJs: join(agentDir, "fake-omo.js") },
  };
  const app = new Hono();
  app.route("/", createExtensionsRoutes(deps));
  return app;
}

async function req(app: Hono, path: string, init?: RequestInit): Promise<{ status: number; text: string; body: any }> {
  const res = await app.request(path, init);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 纯文本兜底
  }
  return { status: res.status, text, body: parsed };
}

const postJson = (app: Hono, path: string, body: unknown) =>
  req(app, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const LONG_KEY = "sk-long-abcdef0123456789wxyz";
const SHORT_KEY = "abc123";

describe("GET /api/auth/providers", () => {
  test("列表：掩码前3后4 / 短 key 全掩码 / type / hasBaseUrl，响应无明文 key", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ "prov-a": { key: LONG_KEY }, "prov-b": { key: SHORT_KEY }, "prov-c": { type: "api", key: LONG_KEY } }),
      "utf8",
    );
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({ providers: { "prov-a": { baseUrl: "https://api.example.com/v1", api: "openai-completions", models: [] } } }),
      "utf8",
    );
    const r = await req(makeApp(dir), "/api/auth/providers");
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([
      { name: "prov-a", type: null, keyMask: "sk-***wxyz", hasBaseUrl: true },
      { name: "prov-b", type: null, keyMask: "***", hasBaseUrl: false },
      { name: "prov-c", type: "api", keyMask: "sk-***wxyz", hasBaseUrl: false },
    ]);
    expect(r.text).not.toContain(LONG_KEY);
    expect(r.text).not.toContain(SHORT_KEY);
  });

  test("auth.json 缺失 → 空数组；损坏 → 空数组", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    const app = makeApp(dir);
    const r = await req(app, "/api/auth/providers");
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    writeFileSync(join(dir, "auth.json"), "{not-json", "utf8");
    const r2 = await req(app, "/api/auth/providers");
    expect(r2.status).toBe(200);
    expect(r2.body.items).toEqual([]);
  });
});

describe("DELETE /api/auth/providers/:id", () => {
  test("删除生效：目标条目移除，其他条目保留，不产生半写文件", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ a: { key: LONG_KEY }, b: { key: LONG_KEY } }), "utf8");
    const app = makeApp(dir);
    const r = await req(app, "/api/auth/providers/a", { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, name: "a" });
    const doc = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    expect(doc).toEqual({ b: { key: LONG_KEY } });
    expect(r.text).not.toContain(LONG_KEY);
  });

  test("不存在 → 404 auth_provider_not_found；非法 id → 400", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ a: { key: LONG_KEY } }), "utf8");
    const app = makeApp(dir);
    const r = await req(app, "/api/auth/providers/ghost", { method: "DELETE" });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("auth_provider_not_found");
    const r2 = await req(app, "/api/auth/providers/bad%2Fid", { method: "DELETE" });
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe("invalid_provider");
  });
});

describe("POST /api/auth/check（指定 provider）", () => {
  test("指定 provider 的 CLI 检查：匹配退 0 → ready，不匹配退 1 → not_configured", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    process.env.FAKE_EXPECT_KEY = LONG_KEY;
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "p-good": { key: LONG_KEY }, "p-bad": { key: "nope" } }), "utf8");
    const app = makeApp(dir);
    const good = await postJson(app, "/api/auth/check", { provider: "p-good" });
    expect(good.status).toBe(200);
    expect(good.body.status).toBe("ready");
    expect(good.body.provider).toBe("p-good");
    const bad = await postJson(app, "/api/auth/check", { provider: "p-bad" });
    expect(bad.status).toBe(200);
    expect(bad.body.status).toBe("not_configured");
    expect(bad.body.provider).toBe("p-bad");
    expect(good.text).not.toContain(LONG_KEY);
  });

  test("auth.json 无该 provider → not_configured（CLI 退 1）；非法 provider → 400", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "p-good": { key: LONG_KEY } }), "utf8");
    const app = makeApp(dir);
    const r = await postJson(app, "/api/auth/check", { provider: "ghost" });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("not_configured");
    const r2 = await postJson(app, "/api/auth/check", {});
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe("invalid_provider");
  });
});

describe("POST /api/auth/credentials + baseUrl", () => {
  test("ready：models.json 无该 provider → 建最小条目 {baseUrl, api, models:[]}", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    process.env.FAKE_EXPECT_KEY = LONG_KEY;
    const r = await postJson(makeApp(dir), "/api/auth/credentials", {
      provider: "new-p",
      apiKey: LONG_KEY,
      baseUrl: "https://api.example.com/v1",
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ready");
    const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
    expect(models.providers["new-p"]).toEqual({ baseUrl: "https://api.example.com/v1", api: "openai-completions", models: [] });
  });

  test("ready：已有 provider 条目 → 只改 baseUrl，其余字段不动", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    process.env.FAKE_EXPECT_KEY = LONG_KEY;
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({ providers: { "new-p": { baseUrl: "https://old.example.com/v1", api: "openai-completions", models: [{ id: "m1" }], headers: { "x-hi": "1" } } } }),
      "utf8",
    );
    const r = await postJson(makeApp(dir), "/api/auth/credentials", {
      provider: "new-p",
      apiKey: LONG_KEY,
      baseUrl: "https://api.example.com/v1 ",
    });
    expect(r.status).toBe(200);
    const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
    expect(models.providers["new-p"]).toEqual({
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      models: [{ id: "m1" }],
      headers: { "x-hi": "1" },
    });
  });

  test("非 ready 回滚：models.json 原本不存在 → 不落文件（同事务）", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    process.env.FAKE_EXPECT_KEY = "right-key";
    // CLI not_configured 后会走 HTTP 直验兜底（models.json 已带 baseUrl+key）→ stub 隔离网络
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    const r = await postJson(makeApp(dir), "/api/auth/credentials", {
      provider: "p",
      apiKey: LONG_KEY,
      baseUrl: "https://api.example.com/v1",
    });
    expect(r.status).toBe(422);
    expect(r.body.checkedVia).toBe("http"); // 直验网络错 → error 仍同事务回滚
    expect(existsSync(join(dir, "models.json"))).toBe(false);
    expect(existsSync(join(dir, "auth.json"))).toBe(false);
  });

  test("非 ready 回滚：已有 models.json → baseUrl 恢复旧值，其余字段不动", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    process.env.FAKE_EXPECT_KEY = "right-key";
    // 同上：直验兜底 stub 隔离网络
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({ providers: { p: { baseUrl: "https://old.example.com/v1", models: [{ id: "keep" }] } } }),
      "utf8",
    );
    const r = await postJson(makeApp(dir), "/api/auth/credentials", {
      provider: "p",
      apiKey: LONG_KEY,
      baseUrl: "https://api.example.com/v1",
    });
    expect(r.status).toBe(422);
    const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
    expect(models.providers.p).toEqual({ baseUrl: "https://old.example.com/v1", models: [{ id: "keep" }] });
  });

  test("baseUrl 空 = 不改 models.json；非法 baseUrl → 400 不写任何文件", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    process.env.FAKE_EXPECT_KEY = LONG_KEY;
    const app = makeApp(dir);
    const r = await postJson(app, "/api/auth/credentials", { provider: "p", apiKey: LONG_KEY, baseUrl: "" });
    expect(r.status).toBe(200);
    expect(existsSync(join(dir, "models.json"))).toBe(false);
    const r2 = await postJson(app, "/api/auth/credentials", { provider: "p", apiKey: LONG_KEY, baseUrl: "ftp://x" });
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe("invalid_baseurl");
    const r3 = await postJson(app, "/api/auth/credentials", { provider: "p", apiKey: LONG_KEY, baseUrl: "not a url" });
    expect(r3.status).toBe(400);
  });
});
