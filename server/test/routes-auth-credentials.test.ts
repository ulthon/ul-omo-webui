// 粘贴凭证端到端单测（r10 批次任务 13）：POST /api/auth/credentials 写入→检查→回滚。
// 伪引擎 CLI 模拟 omo auth check：读 auth.json 实际比对期望 key（env 注入，无真实付费
// 凭证），匹配退 0（ready），否则退 1（not_configured）；FAKE_AUTH_EXIT=2 覆盖为 error。
// 验收：happy 路径落盘 + ready；无效 key 不落盘（回滚）；安全断言——响应体无明文 key、
// console 无 key 输出；engineCli 缺失 503；入参校验 400。全部 mkdtemp 隔离。
import { describe, expect, test, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createExtensionsRoutes, type ExtensionsRouteDeps } from "../src/api/routes-extensions";

const ROOTS: string[] = [];
afterEach(() => {
  for (const r of ROOTS.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "t13-auth-"));
  ROOTS.push(dir);
  return dir;
}

/** 伪引擎 CLI：auth check 时读 agentDir/auth.json，key 与 FAKE_EXPECT_KEY 一致退 0，否则退 FAKE_AUTH_EXIT（缺省 1） */
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

async function post(app: Hono, body: unknown): Promise<{ status: number; text: string; body: any }> {
  const res = await app.request("/api/auth/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 纯文本兜底
  }
  return { status: res.status, text, body: parsed };
}

const KEY = "sk-test-abcdef0123456789";

describe("POST /api/auth/credentials（r10 任务 13）", () => {
  test("happy：有效 key → 200 ready，auth.json+defaultProvider 落盘，响应无 key", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    process.env.FAKE_EXPECT_KEY = KEY;
    const app = makeApp(dir);
    const logs: unknown[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => logs.push(a));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const r = await post(app, { provider: "mock-provider", apiKey: KEY });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ready", provider: "mock-provider", checkedAt: expect.any(Number), detail: null });
    expect(r.text).not.toContain(KEY);

    const doc = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    expect(doc["mock-provider"]).toEqual({ key: KEY });
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(settings.defaultProvider).toBe("mock-provider");
    for (const spy of [logSpy, errorSpy, warnSpy]) {
      for (const call of spy.mock.calls) expect(call.join(" ")).not.toContain(KEY);
    }
    expect(logs).toHaveLength(0);
  });

  test("failure：无效 key → 422 not_configured，auth.json 不落盘（回滚），失败原因外显，不崩", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    process.env.FAKE_EXPECT_KEY = "another-correct-key";
    const app = makeApp(dir);

    const r = await post(app, { provider: "mock-provider", apiKey: KEY });
    expect(r.status).toBe(422);
    expect(r.body.status).toBe("not_configured");
    expect(r.body.provider).toBe("mock-provider");
    expect(r.text).not.toContain(KEY);
    expect(existsSync(join(dir, "auth.json"))).toBe(false);
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(settings.defaultProvider).toBeUndefined();
  });

  test("failure：检查 error（exit 2）→ 422 error 带 detail，已有其他 provider 凭证保留", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    process.env.FAKE_AUTH_EXIT = "2";
    process.env.FAKE_EXPECT_KEY = "";
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "other-p": { key: "keep-me" } }), "utf8");
    const app = makeApp(dir);

    const r = await post(app, { provider: "mock-provider", apiKey: KEY });
    expect(r.status).toBe(422);
    expect(r.body.status).toBe("error");
    expect(typeof r.body.detail).toBe("string");
    expect(r.body.detail).not.toContain(KEY);
    const doc = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    expect(doc["other-p"]).toEqual({ key: "keep-me" });
    expect(doc["mock-provider"]).toBeUndefined();
  });

  test("engineCli 缺失 → 503 cli_missing，不写任何文件", async () => {
    const dir = makeAgentDir();
    const app = new Hono();
    app.route("/", createExtensionsRoutes({ agentDir: dir, engineCli: null }));
    const r = await post(app, { provider: "p", apiKey: KEY });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("cli_missing");
    expect(existsSync(join(dir, "auth.json"))).toBe(false);
  });

  test("入参校验 400：非法 provider / 空 key / 缺字段", async () => {
    const dir = makeAgentDir();
    writeFakeCli(dir);
    const app = makeApp(dir);
    const cases: Array<[unknown, string]> = [
      [{ provider: "bad provider!", apiKey: KEY }, "invalid_provider"],
      [{ provider: "", apiKey: KEY }, "invalid_provider"],
      [{ provider: "p", apiKey: "" }, "invalid_api_key"],
      [{ provider: "p" }, "invalid_api_key"],
      [{ apiKey: KEY }, "invalid_provider"],
    ];
    for (const [body, code] of cases) {
      const r = await post(app, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe(code);
    }
    expect(existsSync(join(dir, "auth.json"))).toBe(false);
  });
});
