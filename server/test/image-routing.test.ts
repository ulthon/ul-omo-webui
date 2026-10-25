// 图片按模型能力自动分流 + 历史引用化单测（docs08-2026-10-23-24 批次任务 19）：
// - 能力判定矩阵：supportsImages:true 才内联；false/缺席/文件缺失/JSON 损坏/
//   provider 无法解析一律保守回退附件（绝不误内联）
// - 分流路由：POST /prompt 携带图片 → 附件落盘 + 路径行 + images 置空；支持时原样内联
// - 能力中途变更：逐次发送重新判定，已发条目不回改
// - 历史引用化：GET /messages 条目不再含 base64（ref 形态），边车内容寻址去重，
//   GET /attachments 按需取回字节；字节级前后对比（流量收益可观测）
// - legacy 兼容：会话项目不可解析（无 resolveSessionRow）→ base64 原样下发
// - 启动清扫跳过 img-* 历史引用文件（paste-/upload- 照常清）
import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import {
  HISTORY_IMAGE_PREFIX,
  projectAttachmentsDir,
  purgeStaleAttachments,
} from "../src/api/attachments";
import { modelSupportsImages } from "../src/api/image-routing";
import { createSessionRoutes } from "../src/api/routes-session";
import { openMetaDb } from "../src/db/meta";
import type { EngineGateway } from "../src/api/engine-runtime";
import type {
  EngineMessagesPage,
  EngineModelInfo,
  EnginePermissionReply,
  EnginePromptInput,
  EngineQuestionFrame,
  EngineSessionSummary,
  EngineThinkingLevel,
  EngineUsageStats,
  EngineQueueSnapshot,
} from "../src/adapter/engine-adapter";

// ---------------------------------------------------------------- fake gateway

class FakeGateway implements EngineGateway {
  sessions = new Map<string, EngineSessionSummary>();
  promptInputs: Array<{ id: string; input: EnginePromptInput }> = [];
  messagesResult: EngineMessagesPage = { entries: [], leafId: null, cursor: null };
  withResolveSessionRow = true;

  async resolveSessionRow(sessionId: string): Promise<EngineSessionSummary | null> {
    if (!this.withResolveSessionRow) return null;
    return this.sessions.get(sessionId) ?? null;
  }
  async sessionsList(): Promise<EngineSessionSummary[]> {
    return [...this.sessions.values()];
  }
  async createSession(
    _project: string,
    _opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    throw new Error("not used");
  }
  async messages(_id: string, _cursor?: string): Promise<EngineMessagesPage> {
    return this.messagesResult;
  }
  async prompt(id: string, input: EnginePromptInput): Promise<{ disposition: string }> {
    this.promptInputs.push({ id, input });
    return { disposition: "started" };
  }
  async abort(): Promise<void> {}
  async queueList(): Promise<EngineQueueSnapshot> {
    return { steering: [], followUp: [], ordered: [] };
  }
  async queueClear(): Promise<EngineQueueSnapshot> {
    return { steering: [], followUp: [], ordered: [] };
  }
  async permissionRespond(_id: string, _requestId: string, _reply: EnginePermissionReply): Promise<void> {}
  async questionsList(_id: string): Promise<EngineQuestionFrame[]> {
    return [];
  }
  async usage(): Promise<EngineUsageStats> {
    throw new Error("not used");
  }
  async modelsList(): Promise<EngineModelInfo[]> {
    return [];
  }
  async deleteSession(): Promise<{ sessionPath: string; fileExisted: boolean }> {
    throw new Error("not used");
  }
  async exportSessionHtml(): Promise<{ html: string; row: EngineSessionSummary }> {
    throw new Error("not used");
  }
  async forkSession(): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }> {
    throw new Error("not used");
  }
  async peekActiveSessionPaths(): Promise<string[] | null> {
    return null;
  }
  async restartProject(): Promise<void> {}
  async commandsList(): Promise<null> {
    return null;
  }
  async stopAll(): Promise<void> {}
}

const PROJECT = "/tmp/opencode/img-route-project";

function summary(id: string, cwd: string): EngineSessionSummary {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
  };
}

/** 最小红点 PNG（1x1）base64——固定内容保证内容寻址文件名可预期 */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
/** 大图载荷（约 100KB base64）：让字节级流量对比有区分度（QA 面用真实 200KB 图） */
const BIG_BASE64 = "A".repeat(133_000);
const BIG_BYTES = Buffer.from(BIG_BASE64, "base64");

function writeModelsJson(path: string, supportsImages: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ providers: { p: { baseUrl: "https://x.example", models: [{ id: "m", supportsImages }] } } }),
    "utf8",
  );
}

function buildApp(engines: FakeGateway, root: string, modelsPath: string) {
  const meta = openMetaDb({ path: join(mkdtempSync(join(tmpdir(), "imgmeta-")), "meta.db") });
  const app = new Hono();
  app.route("/", createSessionRoutes({ meta, engines, attachmentsRoot: root, modelsPath }));
  return app;
}

const postPrompt = (app: Hono, body: Record<string, unknown>) =>
  app.request("/api/sessions/s1/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------- 能力判定（纯函数）

describe("modelSupportsImages 能力判定矩阵", () => {
  const dir = mkdtempSync(join(tmpdir(), "imgmodels-"));
  const modelsPath = join(dir, "models.json");
  test("显式 supportsImages:true → true（唯一内联口径）", () => {
    writeModelsJson(modelsPath, true);
    expect(modelSupportsImages(modelsPath, "p/m")).toBe(true);
  });
  test("显式 false / 字段缺席 / 垃圾值 → false（保守回退附件）", () => {
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          p: {
            models: [
              { id: "noflag" },
              { id: "no", supportsImages: false },
              { id: "garbage", supportsImages: "yes" },
            ],
          },
        },
      }),
      "utf8",
    );
    expect(modelSupportsImages(modelsPath, "p/noflag")).toBe(false);
    expect(modelSupportsImages(modelsPath, "p/no")).toBe(false);
    expect(modelSupportsImages(modelsPath, "p/garbage")).toBe(false);
  });
  test("能力源不可用：文件缺失 / JSON 损坏 / 结构异常 → false（绝不误内联）", () => {
    expect(modelSupportsImages(join(dir, "nope.json"), "p/m")).toBe(false);
    writeFileSync(modelsPath, "{not json", "utf8");
    expect(modelSupportsImages(modelsPath, "p/m")).toBe(false);
    writeFileSync(modelsPath, JSON.stringify({ providers: "oops" }), "utf8");
    expect(modelSupportsImages(modelsPath, "p/m")).toBe(false);
  });
  test("模型形态异常：无 provider 斜杠 / 未携带 model / 条目不存在 → false", () => {
    writeModelsJson(modelsPath, true);
    expect(modelSupportsImages(modelsPath, "bare-model")).toBe(false);
    expect(modelSupportsImages(modelsPath, undefined)).toBe(false);
    expect(modelSupportsImages(modelsPath, "p/other")).toBe(false);
    expect(modelSupportsImages(modelsPath, "/leading")).toBe(false);
  });
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 分流路由

describe("POST /prompt 图片分流", () => {
  test("(a) capability=支持 → 内联原样（既有路径回归）", async () => {
    const root = mkdtempSync(join(tmpdir(), "imgroot-"));
    const mdir = mkdtempSync(join(tmpdir(), "imgmodels-"));
    const modelsPath = join(mdir, "models.json");
    writeModelsJson(modelsPath, true);
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", summary("s1", PROJECT));
    const app = buildApp(gateway, root, modelsPath);

    const res = await postPrompt(app, {
      text: "看图",
      model: "p/m",
      images: [{ data: PNG_BASE64, mimeType: "image/png" }],
    });
    expect(res.status).toBe(200);
    expect(gateway.promptInputs).toHaveLength(1);
    expect(gateway.promptInputs[0].input.images).toHaveLength(1);
    expect(gateway.promptInputs[0].input.images?.[0].data).toBe(PNG_BASE64);
    expect(gateway.promptInputs[0].input.text).toBe("看图");
    rmSync(root, { recursive: true, force: true });
    rmSync(mdir, { recursive: true, force: true });
  });

  test("(b) capability=不支持 → 转附件：images 置空、text 拼路径行、文件落盘", async () => {
    const root = mkdtempSync(join(tmpdir(), "imgroot-"));
    const mdir = mkdtempSync(join(tmpdir(), "imgmodels-"));
    const modelsPath = join(mdir, "models.json");
    writeModelsJson(modelsPath, false);
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", summary("s1", PROJECT));
    const app = buildApp(gateway, root, modelsPath);

    const res = await postPrompt(app, {
      text: "看图",
      model: "p/m",
      images: [{ data: PNG_BASE64, mimeType: "image/png" }],
    });
    expect(res.status).toBe(200);
    const input = gateway.promptInputs[0].input;
    expect(input.images ?? []).toHaveLength(0);
    expect(input.text).toContain("[图片已保存为附件：");
    expect(input.text).toContain("（按需读取）]");
    expect(input.text).toContain("看图");
    // 文件确实落在本项目附件目录且字节一致
    const dir = projectAttachmentsDir(root, PROJECT);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0].startsWith(HISTORY_IMAGE_PREFIX)).toBe(true);
    expect(files[0].endsWith(".png")).toBe(true);
    expect(readFileSync(join(dir, files[0]))).toEqual(PNG_BYTES);
    rmSync(root, { recursive: true, force: true });
    rmSync(mdir, { recursive: true, force: true });
  });

  test("(c) 能力源失败（文件缺失 / JSON 损坏 / 未携带 model）→ 一律附件回退，绝不内联", async () => {
    const root = mkdtempSync(join(tmpdir(), "imgroot-"));
    const mdir = mkdtempSync(join(tmpdir(), "imgmodels-"));
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", summary("s1", PROJECT));
    // 缺失文件
    const gw1 = new FakeGateway();
    gw1.sessions.set("s1", summary("s1", PROJECT));
    const app1 = buildApp(gw1, root, join(mdir, "nope.json"));
    await postPrompt(app1, { text: "看图", model: "p/m", images: [{ data: PNG_BASE64, mimeType: "image/png" }] });
    expect(gw1.promptInputs[0].input.images ?? []).toHaveLength(0);
    expect(gw1.promptInputs[0].input.text).toContain("[图片已保存为附件：");

    // JSON 损坏
    const modelsPath = join(mdir, "models.json");
    writeFileSync(modelsPath, "{broken", "utf8");
    const gw2 = new FakeGateway();
    gw2.sessions.set("s1", summary("s1", PROJECT));
    const app2 = buildApp(gw2, root, modelsPath);
    await postPrompt(app2, { text: "看图", model: "p/m", images: [{ data: PNG_BASE64, mimeType: "image/png" }] });
    expect(gw2.promptInputs[0].input.images ?? []).toHaveLength(0);

    // 支持 json 但请求未携带 model（无法判定当前模型）
    writeModelsJson(modelsPath, true);
    const gw3 = new FakeGateway();
    gw3.sessions.set("s1", summary("s1", PROJECT));
    const app3 = buildApp(gw3, root, modelsPath);
    await postPrompt(app3, { text: "看图", images: [{ data: PNG_BASE64, mimeType: "image/png" }] });
    expect(gw3.promptInputs[0].input.images ?? []).toHaveLength(0);
    expect(gw3.promptInputs[0].input.text).toContain("[图片已保存为附件：");
    rmSync(root, { recursive: true, force: true });
    rmSync(mdir, { recursive: true, force: true });
  });

  test("stale_state：能力中途翻转变更后续发送口径，已发条目不回改", async () => {
    const root = mkdtempSync(join(tmpdir(), "imgroot-"));
    const mdir = mkdtempSync(join(tmpdir(), "imgmodels-"));
    const modelsPath = join(mdir, "models.json");
    writeModelsJson(modelsPath, false);
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", summary("s1", PROJECT));
    const app = buildApp(gateway, root, modelsPath);
    const img = [{ data: PNG_BASE64, mimeType: "image/png" }];

    await postPrompt(app, { text: "第一张", model: "p/m", images: img });
    expect(gateway.promptInputs[0].input.images ?? []).toHaveLength(0);

    // 能力变更（用户改 models.json）：下一次发送重新判定 → 内联
    writeModelsJson(modelsPath, true);
    await postPrompt(app, { text: "第二张", model: "p/m", images: img });
    expect(gateway.promptInputs[1].input.images).toHaveLength(1);
    // 第一条已发条目保持附件口径（不回改）
    expect(gateway.promptInputs[0].input.images ?? []).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
    rmSync(mdir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- 历史引用化

describe("GET /messages 历史引用化", () => {
  const base64Entry = {
    type: "message",
    id: "e1",
    message: {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image", data: BIG_BASE64, mimeType: "image/png" },
      ],
    },
  };

  test("(d) 新条目不含 base64：ref 形态下发 + 按需取回字节 + 内容寻址去重", async () => {
    const root = mkdtempSync(join(tmpdir(), "imgroot-"));
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", summary("s1", PROJECT));
    gateway.messagesResult = { entries: [base64Entry] as never, leafId: "e1", cursor: "e1" };
    const app = buildApp(gateway, root, join(root, "no-models.json"));

    const before = JSON.stringify(gateway.messagesResult.entries).length;
    expect(before).toBeGreaterThan(100_000); // 前提：内联形态确实携带大 base64
    const res = await app.request("/api/sessions/s1/messages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ message: { content: Array<Record<string, unknown>> } }> };
    const part = body.entries[0].message.content.find((p) => p.type === "image") as Record<string, unknown>;
    // 引用形态：无 data，有 ref.path；字节级流量收益（引用条目远小于 base64 条目）
    expect(part.data).toBeUndefined();
    const ref = part.ref as { path: string; name: string };
    expect(typeof ref.path).toBe("string");
    expect(ref.name.startsWith(HISTORY_IMAGE_PREFIX)).toBe(true);
    const after = JSON.stringify(body.entries).length;
    expect(after).toBeLessThan(before / 100); // 引用形态：~百字节 vs ~100KB

    // 按需取回：GET /attachments 返回原始字节
    const fetchRes = await app.request(
      `/api/sessions/s1/attachments?path=${encodeURIComponent(ref.path)}`,
    );
    expect(fetchRes.status).toBe(200);
    expect(Buffer.from(await fetchRes.arrayBuffer())).toEqual(BIG_BYTES);

    // 重复拉取历史：内容寻址不重复落盘
    await app.request("/api/sessions/s1/messages");
    const files = readdirSync(projectAttachmentsDir(root, PROJECT));
    expect(files).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("(e) legacy 兼容：会话项目不可解析（resolveSessionRow null）→ base64 原样下发", async () => {
    const root = mkdtempSync(join(tmpdir(), "imgroot-"));
    const gateway = new FakeGateway();
    gateway.withResolveSessionRow = false;
    gateway.messagesResult = { entries: [base64Entry] as never, leafId: "e1", cursor: "e1" };
    const app = buildApp(gateway, root, join(root, "no-models.json"));

    const res = await app.request("/api/sessions/s1/messages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ message: { content: Array<Record<string, unknown>> } }> };
    const part = body.entries[0].message.content.find((p) => p.type === "image") as Record<string, unknown>;
    expect(part.data).toBe(BIG_BASE64); // 原样，渲染兼容不破
    rmSync(root, { recursive: true, force: true });
  });

  test("非 user / 无图 / 已是引用形态的条目零改动", async () => {
    const root = mkdtempSync(join(tmpdir(), "imgroot-"));
    const gateway = new FakeGateway();
    gateway.sessions.set("s1", summary("s1", PROJECT));
    const entries = [
      { type: "message", id: "a", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      { type: "message", id: "b", message: { role: "user", content: [{ type: "text", text: "纯文本" }] } },
      { type: "message", id: "c", message: { role: "user", content: [{ type: "image", ref: { path: "/x", name: "x" }, mimeType: "image/png" }] } },
    ];
    gateway.messagesResult = { entries: entries as never, leafId: "c", cursor: "c" };
    const app = buildApp(gateway, root, join(root, "no-models.json"));
    const res = await app.request("/api/sessions/s1/messages");
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual(entries);
    // 未产生任何边车文件（目录未创建）
    expect(existsSync(projectAttachmentsDir(root, PROJECT))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- 清扫豁免

describe("purgeStaleAttachments 豁免仅限严格内容寻址形态", () => {
  test("img-<16hex>.png 超龄保留，paste-/upload- 超龄照删", () => {
    const root = mkdtempSync(join(tmpdir(), "imgroot-"));
    const dir = projectAttachmentsDir(root, PROJECT);
    mkdirSync(dir, { recursive: true });
    const imgFile = join(dir, "img-0123456789abcdef.png");
    const pasteFile = join(dir, "paste-123.txt");
    writeFileSync(imgFile, PNG_BYTES);
    writeFileSync(pasteFile, "x");
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
    utimesSync(imgFile, old, old);
    utimesSync(pasteFile, old, old);
    const removed = purgeStaleAttachments(root);
    expect(removed).toBe(1);
    expect(statSync(imgFile).isFile()).toBe(true);
    expect(() => statSync(pasteFile)).toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  test("上传通道仿冒 img- 前缀（验证审查探针）：img-evil.txt 超龄照清，仅严格形态豁免", () => {
    const root = mkdtempSync(join(tmpdir(), "imgroot-"));
    const dir = projectAttachmentsDir(root, PROJECT);
    mkdirSync(dir, { recursive: true });
    const fake = join(dir, "img-evil.txt");
    const strict = join(dir, "img-0123456789abcdef.png");
    writeFileSync(fake, "x");
    writeFileSync(strict, PNG_BYTES);
    const old = new Date(Date.now() - 100 * 60 * 60 * 1000);
    utimesSync(fake, old, old);
    utimesSync(strict, old, old);
    const removed = purgeStaleAttachments(root);
    expect(removed).toBe(1);
    expect(() => statSync(fake)).toThrow(); // 仿冒名不豁免，超龄被清
    expect(statSync(strict).isFile()).toBe(true); // 严格内容寻址形态保留
    rmSync(root, { recursive: true, force: true });
  });
});
