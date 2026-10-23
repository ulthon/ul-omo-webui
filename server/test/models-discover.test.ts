// 模型发现单测（docs08-2026-10-22 批次任务 23）。
// 聚焦：载荷解析/去重（纯函数）、真实 HTTP 桩服务器全链路（预览不落盘/导入写回/
// 保留既有/重复发现不重复）、鉴权失败与不可达降级（文件 mtime 零改）、baseUrl 缺失、
// 并发导入模块级串行、providers 结构校验、GET provider 清单。
// 全部 mkdtemp 隔离，绝不触碰真实 agent 目录；桩服务器走真实 fetch（应用内零 mock）。
import { afterAll, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Hono } from "hono";
import { createMetaRoutes } from "../src/api/routes-meta";
import { readModelsFallback } from "../src/api/engine-runtime";
import {
  buildDiscoveryHeaders,
  discoverProviderModels,
  discoveryListingUrl,
  listDiscoverableProviders,
  mergeDiscoveredModels,
  parseModelListing,
  validateModelsDocument,
} from "../src/api/models-discover";

// ---------------------------------------------------------------- 桩 OpenAI 兼容服务器

const stubs: Server[] = [];
const stubByBase = new Map<string, Server>();
afterAll(() => {
  for (const s of stubs) s.close();
});

/** 起一个真实 HTTP 桩：GET /models 返回 payload（可指定 status/鉴权校验）。 */
async function startStub(opts: {
  payload?: unknown;
  status?: number;
  text?: string;
  requireAuth?: string | null;
  captureHeaders?: (h: Record<string, string | undefined>) => void;
}): Promise<string> {
  const server = createServer((req, res) => {
    if (opts.captureHeaders) opts.captureHeaders(req.headers as Record<string, string | undefined>);
    const authed = opts.requireAuth === undefined || req.headers.authorization === opts.requireAuth;
    if (!authed) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(opts.status ?? 200, { "content-type": "application/json" });
    if (opts.text !== undefined) {
      res.end(opts.text);
      return;
    }
    res.end(JSON.stringify(opts.payload ?? { data: [] }));
  });
  stubs.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("stub listen failed");
  const base = `http://127.0.0.1:${addr.port}`;
  stubByBase.set(base, server);
  return base;
}

/** 关闭一个已起的桩（连接拒绝用例：起后即关）。 */
async function closeStub(base: string): Promise<void> {
  const server = stubByBase.get(base);
  if (!server) throw new Error(`stub ${base} not found`);
  stubByBase.delete(base);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------- 装配

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function makeModelsPath(initial?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "t23-models-"));
  tempRoots.push(dir);
  const file = join(dir, "models.json");
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial, null, 2));
  return file;
}

/** 装配：GET /api/models 走引擎未就绪降级（readModelsFallback 直读同目录
 * models.json）——导入后立即可见的全链路断言用真实读路径。 */
function makeApp(modelsPath: string): Hono {
  return new Hono().route(
    "/",
    createMetaRoutes({
      meta: { listProjectMeta: () => [{ projectPath: "/proj" }] } as never,
      engines: { modelsList: async () => readModelsFallback(dirname(modelsPath)) } as never,
      modelsPath,
    }),
  );
}

const LISTING = { data: [{ id: "glm-5.3" }, { id: "glm-5.3-4k" }, { id: "glm-5.3-air" }] };

// ---------------------------------------------------------------- 纯函数

describe("parseModelListing 载荷解析", () => {
  test("裸数组与 {data:[...]} 双形态，非字符串/空 id 剔除，按 id 去重保序", () => {
    expect(parseModelListing([{ id: "b" }, { id: "a" }, { id: "b" }, { id: "" }, { nope: 1 }, "x", null])).toEqual([
      { id: "b" },
      { id: "a" },
    ]);
    expect(parseModelListing({ data: [{ id: "m1" }] })).toEqual([{ id: "m1" }]);
  });

  test("非列表载荷返回空数组（bad listing 判定由调用方区分）", () => {
    expect(parseModelListing({ error: "boom" })).toEqual([]);
    expect(parseModelListing(null)).toEqual([]);
    expect(parseModelListing({ data: "nope" })).toEqual([]);
  });

  test("discoveryListingUrl 去尾斜杠拼接 /models；非法输入 null", () => {
    expect(discoveryListingUrl("https://api.example.com/v1")?.request).toBe("https://api.example.com/v1/models");
    expect(discoveryListingUrl("https://api.example.com/")?.request).toBe("https://api.example.com/models");
    expect(discoveryListingUrl("not a url")).toBeNull();
    expect(discoveryListingUrl(undefined)).toBeNull();
    expect(discoveryListingUrl("")).toBeNull();
  });

  test("buildDiscoveryHeaders：apiKey 兜底 Bearer，显式 authorization 不覆盖，null 头删除", () => {
    expect(buildDiscoveryHeaders({ apiKey: "sk-test" }).authorization).toBe("Bearer sk-test");
    expect(buildDiscoveryHeaders({ apiKey: "sk", headers: { authorization: "Basic x" } }).authorization).toBe("Basic x");
    const h = buildDiscoveryHeaders({ headers: { "x-rogue": null, "x-keep": "1" } });
    expect("x-rogue" in h).toBe(false);
    expect(h["x-keep"]).toBe("1");
    expect(h.accept).toBe("application/json");
  });

  test("mergeDiscoveredModels：新增补 {id} 默认形态，既有条目原样保留", () => {
    const doc = { providers: { p: { baseUrl: "https://x", models: [{ id: "glm-5.3", contextWindow: 1_000_000 }] } } };
    const { document, added, unchanged } = mergeDiscoveredModels(doc, "p", [{ id: "glm-5.3" }, { id: "new" }]);
    expect(added).toEqual(["new"]);
    expect(unchanged).toEqual(["glm-5.3"]);
    const models = (document.providers?.p?.models ?? []) as Array<Record<string, unknown>>;
    expect(models[0]).toEqual({ id: "glm-5.3", contextWindow: 1_000_000 });
    expect(models[1]).toEqual({ id: "new" });
  });

  test("validateModelsDocument：结构完整性", () => {
    expect(validateModelsDocument({ providers: { p: { models: [{ id: "a" }] } } })).toBeNull();
    expect(validateModelsDocument({})).toBeNull();
    expect(validateModelsDocument("nope")).not.toBeNull();
    expect(validateModelsDocument({ providers: "nope" })).not.toBeNull();
    expect(validateModelsDocument({ providers: { p: { models: [{ noId: 1 }] } } })).not.toBeNull();
  });
});

// ---------------------------------------------------------------- 路由全链路（真实 HTTP 桩）

describe("POST /api/models/discover 全链路", () => {
  test("预览不落盘 → 导入写回 → GET /api/models 可见 → 重复发现不重复", async () => {
    const base = await startStub({ payload: LISTING, requireAuth: "Bearer sk-live" });
    const modelsPath = makeModelsPath({ providers: { zhipu: { baseUrl: `${base}/v1`, apiKey: "sk-live", models: [] } } });
    const app = makeApp(modelsPath);

    // 预览：不写盘
    const before = statSync(modelsPath).mtimeMs;
    const preview = await app.request("/api/models/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "zhipu" }),
    });
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as { discovered: string[]; added: string[]; written: boolean; unchanged: string[] };
    expect(previewBody.discovered).toEqual(["glm-5.3", "glm-5.3-4k", "glm-5.3-air"]);
    expect(previewBody.added).toEqual(["glm-5.3", "glm-5.3-4k", "glm-5.3-air"]);
    expect(previewBody.written).toBe(false);
    expect(statSync(modelsPath).mtimeMs).toBe(before);

    // 导入全部
    const imported = await app.request("/api/models/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "zhipu", import: "all" }),
    });
    expect(imported.status).toBe(200);
    const importedBody = (await imported.json()) as { written: boolean; imported: string[] };
    expect(importedBody.written).toBe(true);
    expect(importedBody.imported).toEqual(["glm-5.3", "glm-5.3-4k", "glm-5.3-air"]);

    // 导入后 GET /api/models（引擎未就绪 → 自定义直读降级）立即可见
    const listed = await app.request("/api/models");
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { models: Array<{ provider: string; id: string }> };
    for (const id of ["glm-5.3", "glm-5.3-4k", "glm-5.3-air"]) {
      expect(listedBody.models).toContainEqual({ provider: "zhipu", id });
    }

    // 重复发现不重复：再导入 all → added 空 → 不写盘（mtime 不变）
    const after1 = statSync(modelsPath).mtimeMs;
    const repeat = await app.request("/api/models/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "zhipu", import: "all" }),
    });
    const repeatBody = (await repeat.json()) as { written: boolean; added: string[] };
    expect(repeatBody.written).toBe(false);
    expect(repeatBody.added).toEqual([]);
    expect(statSync(modelsPath).mtimeMs).toBe(after1);

    // 落盘文件无 temp 残留，providers 结构完整
    const dir = join(modelsPath, "..");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const onDisk = JSON.parse(readFileSync(modelsPath, "utf8")) as { providers: Record<string, { models: Array<{ id: string }> }> };
    expect(validateModelsDocument(onDisk)).toBeNull();
    expect(onDisk.providers.zhipu.models.map((m) => m.id)).toEqual(["glm-5.3", "glm-5.3-4k", "glm-5.3-air"]);
  });

  test("保留既有：已配置模型条目字节不变，只补新增", async () => {
    const base = await startStub({ payload: { data: [{ id: "a" }, { id: "b" }] } });
    const modelsPath = makeModelsPath({
      providers: { p: { baseUrl: `${base}/v1`, models: [{ id: "a", reasoning: true, contextWindow: 200000, upstreamModelId: "a" }] } },
    });
    const report = await discoverProviderModels({ modelsPath, providerId: "p", importIds: "all" });
    expect(report.added).toEqual(["b"]);
    expect(report.unchanged).toEqual(["a"]);
    const onDisk = JSON.parse(readFileSync(modelsPath, "utf8")) as { providers: Record<string, { models: unknown[] }> };
    expect(onDisk.providers.p.models[0]).toEqual({ id: "a", reasoning: true, contextWindow: 200000, upstreamModelId: "a" });
    expect(onDisk.providers.p.models[1]).toEqual({ id: "b" });
  });

  test("子集导入与非法选择", async () => {
    const base = await startStub({ payload: LISTING });
    const modelsPath = makeModelsPath({ providers: { p: { baseUrl: `${base}/v1`, models: [] } } });
    const app = makeApp(modelsPath);

    const picked = await app.request("/api/models/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "p", import: ["glm-5.3-4k"] }),
    });
    expect(picked.status).toBe(200);
    const body = (await picked.json()) as { imported: string[] };
    expect(body.imported).toEqual(["glm-5.3-4k"]);

    const bad = await app.request("/api/models/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "p", import: ["glm-5.3-4k", "not-offered"] }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_import");
  });
});

describe("发现失败降级", () => {
  test("鉴权失败 401 → 502，文件 mtime 零改", async () => {
    const base = await startStub({ payload: LISTING, requireAuth: "Bearer right" });
    const modelsPath = makeModelsPath({ providers: { p: { baseUrl: `${base}/v1`, apiKey: "wrong" } } });
    const before = statSync(modelsPath).mtimeMs;
    const app = makeApp(modelsPath);
    const res = await app.request("/api/models/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "p" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("discover_upstream_failed");
    expect(body.error.message).toContain("401");
    expect(statSync(modelsPath).mtimeMs).toBe(before);
    // apiKey 不回显在错误信息
    expect(body.error.message).not.toContain("wrong");
  });

  test("不可达 provider → 502，文件零改；空列表报 discover_bad_listing", async () => {
    // 起后即关 = 真实连接拒绝（连接层失败，非 HTTP 错误）
    const deadBase = await startStub({ payload: [] });
    await closeStub(deadBase);
    const modelsPath = makeModelsPath({ providers: { offline: { baseUrl: `${deadBase}/v1` } } });
    const before = statSync(modelsPath).mtimeMs;
    await expect(discoverProviderModels({ modelsPath, providerId: "offline" })).rejects.toMatchObject({
      status: 502,
      code: "discover_upstream_failed",
    });
    expect(statSync(modelsPath).mtimeMs).toBe(before);

    // 合法空清单（{data:[]}）非错误：对齐引擎 discover，返回空报告零写盘
    const emptyBase = await startStub({ payload: { data: [] } });
    const emptyPath = makeModelsPath({ providers: { empty: { baseUrl: `${emptyBase}/v1` } } });
    const emptyBefore = statSync(emptyPath).mtimeMs;
    const emptyReport = await discoverProviderModels({ modelsPath: emptyPath, providerId: "empty" });
    expect(emptyReport).toMatchObject({ discovered: [], added: [], written: false });
    expect(statSync(emptyPath).mtimeMs).toBe(emptyBefore);

    // 无模型列表形态（对象无 data 字段）→ 502 discover_bad_listing
    const badBase = await startStub({ payload: { objects: [] } });
    const badPath = makeModelsPath({ providers: { bad: { baseUrl: `${badBase}/v1` } } });
    await expect(discoverProviderModels({ modelsPath: badPath, providerId: "bad" })).rejects.toMatchObject({
      status: 502,
      code: "discover_bad_listing",
    });
  });

  test("baseUrl 缺失/非 OpenAI 兼容 api/未知 provider → 400", async () => {
    const modelsPath = makeModelsPath({
      providers: {
        noUrl: {},
        weird: { baseUrl: "https://x/v1", api: "llama.cpp" },
      },
    });
    await expect(discoverProviderModels({ modelsPath, providerId: "noUrl" })).rejects.toMatchObject({
      status: 400,
      code: "invalid_baseurl",
    });
    await expect(discoverProviderModels({ modelsPath, providerId: "weird" })).rejects.toMatchObject({
      status: 400,
      code: "provider_not_compatible",
    });
    await expect(discoverProviderModels({ modelsPath, providerId: "ghost" })).rejects.toMatchObject({
      status: 400,
      code: "provider_not_found",
    });
  });

  test("非 JSON 响应 → 502 discover_upstream_failed", async () => {
    const base = await startStub({ text: "<html>not json</html>" });
    const modelsPath = makeModelsPath({ providers: { p: { baseUrl: `${base}/v1` } } });
    await expect(discoverProviderModels({ modelsPath, providerId: "p" })).rejects.toMatchObject({ status: 502 });
  });
});

describe("并发导入串行与 provider 清单", () => {
  test("两次并发导入交错不丢写：最终文件同时含两批新增且零 temp 残留", async () => {
    const base = await startStub({ payload: { data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] } });
    const modelsPath = makeModelsPath({ providers: { p: { baseUrl: `${base}/v1`, models: [] } } });
    const results = await Promise.all([
      discoverProviderModels({ modelsPath, providerId: "p", importIds: ["m1"] }),
      discoverProviderModels({ modelsPath, providerId: "p", importIds: ["m2"] }),
    ]);
    // 串行化后第二次 diff 仍能看到自己那批（第一批已落盘，不影响第二批的 added 判定：
    // 两批选中的 id 互不相同，恰好各自落盘一次）
    const written = results.filter((r) => r.written);
    expect(written.length).toBeGreaterThanOrEqual(1);
    const onDisk = JSON.parse(readFileSync(modelsPath, "utf8")) as { providers: Record<string, { models: Array<{ id: string }> }> };
    const ids = onDisk.providers.p.models.map((m) => m.id).sort();
    expect(ids).toEqual(["m1", "m2"]);
    const dir = join(modelsPath, "..");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("GET /api/models/discover 返回 provider 清单；文件缺失空清单；不存在的 models.json 读不崩", async () => {
    const base = await startStub({ payload: LISTING });
    const modelsPath = makeModelsPath({
      providers: {
        zhipu: { baseUrl: `${base}/v1`, models: [{ id: "glm-5.3" }] },
        bare: {},
      },
    });
    const app = makeApp(modelsPath);
    const res = await app.request("/api/models/discover");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: Array<{ id: string; baseUrl: string; modelCount: number }> };
    expect(body.providers).toContainEqual({ id: "zhipu", baseUrl: `${base}/v1`, api: null, modelCount: 1 });
    expect(body.providers).toContainEqual({ id: "bare", baseUrl: "", api: null, modelCount: 0 });

    const missing = makeModelsPath();
    if (existsSync(missing)) rmSync(missing);
    expect(listDiscoverableProviders(missing)).toEqual([]);
  });

  test("provider 必填校验", async () => {
    const modelsPath = makeModelsPath({ providers: {} });
    const app = makeApp(modelsPath);
    const res = await app.request("/api/models/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_provider");
  });
});
