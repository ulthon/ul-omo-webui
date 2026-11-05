// 标题生成触发矩阵与端点测试（W2 todo 8 / Scope 决策 9）：
// - TitleGenService 级：触发条件矩阵（renamed/name/generatedTitle/仅 user）、
//   别名 sessionId 经 jsonl header 解析落库、失败不重试、in-flight 幂等、回调不炸
// - 端点级：POST generate-title 成功写 renamedTitle（含被 name 压住的会话）/ 502 带原因
// - 链序：resolveSessionTitle 五层 + export 文件名同链
// - engine-runtime 接线：事件路径归属校验、合成 watchdog 触发、crashSettle 排除
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Hono } from "hono";
import {
  EngineRuntimeRegistry,
  type EngineGateway,
  type EngineRuntimeOptions,
} from "../src/api/engine-runtime";
import type { EngineSessionSummary } from "../src/adapter/engine-adapter";
import { ApiError } from "../src/api/http";
import { createSessionRoutes, resolveSessionTitle } from "../src/api/routes-session";
import { openMetaDb, type MetaDb } from "../src/db/meta";
import {
  EN_TITLE_MAX,
  SESSION_TAIL_CHARS,
  TITLE_LANGUAGE_KV_KEY,
  TITLE_PROMPTS,
  TitleGenService,
  type RoundSettleInfo,
} from "../src/title-gen";

// golden 字符串（防常量引用同义反复：断言不引用 TITLE_PROMPTS，源码常量另测逐字对照）
const GOLDEN_PROMPT_ZH = "为以下对话生成一个不超过 16 个字的中文短标题，只输出标题本身";
const GOLDEN_PROMPT_EN = "Generate a short session title of at most 60 characters, output only the title";

// ---------------------------------------------------------------- fixture 工具

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function tmpMeta(): MetaDb {
  return openMetaDb({ path: join(tmpDir("tg-meta-"), "meta.db") });
}

/** 直构会话 jsonl（w5-27 方法，零 token）：header durable id + 首条 user/assistant */
function writeSessionJsonl(
  dir: string,
  name: string,
  durableId: string,
  opts?: { onlyUser?: boolean; noUser?: boolean; cwd?: string },
): string {
  const lines: Array<Record<string, unknown>> = [
    { type: "session", version: 3, id: durableId, timestamp: "2026-10-11T00:00:00.000Z", cwd: opts?.cwd ?? dir },
  ];
  if (!opts?.noUser) {
    lines.push({ type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: [{ type: "text", text: "帮我看看 tsconfig 的 strict 选项" }] } });
  }
  if (!opts?.onlyUser && !opts?.noUser) {
    lines.push({ type: "message", id: "a1", parentId: "u1", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "strict 是一组类型检查开关的总称" }] } });
  }
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

/** fixture agentDir：auth.json 带 prov-x 凭证 */
function writeAgentDir(): string {
  const dir = tmpDir("tg-agent-");
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "prov-x": { type: "api_key", key: "k-test" } }));
  return dir;
}

type FetchCall = { url: string; init?: RequestInit };
/** fetch mock 签名（实现按 string url 调用；完整 typeof fetch 仅在注入边界 cast 一次） */
type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

function okFetch(): FetchMock {
  return () => Promise.resolve(Response.json({ choices: [{ message: { content: '"并发去重与幂等写入"' } }] }));
}

function makeService(opts: {
  row: { path: string; name?: string } | null;
  fetchImpl?: FetchMock;
  meta?: MetaDb;
  agentDir?: string;
}) {
  const meta = opts.meta ?? tmpMeta();
  const fetchCalls: FetchCall[] = [];
  const fetchImpl: FetchMock =
    opts.fetchImpl ??
    ((url, init) => {
      fetchCalls.push({ url, init });
      return okFetch()(url, init);
    });
  const service = new TitleGenService({
    meta,
    agentDir: opts.agentDir ?? writeAgentDir(),
    resolveSessionRow: () => Promise.resolve(opts.row),
    baseUrl: "http://title.test/v1/chat/completions",
    model: "prov-x/test-model",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { service, meta, fetchCalls };
}

const settle = (sessionId: string, sessionPath: string): RoundSettleInfo => ({ sessionId, sessionPath });

// ---------------------------------------------------------------- 触发矩阵（service 级）

describe("TitleGenService.handleRoundSettled（自动触发矩阵）", () => {
  test("正常：别名 sessionId 经 jsonl header 解析 durable id 落库，HTTP 形态正确", async () => {
    const dir = tmpDir("tg-case-");
    const path = writeSessionJsonl(dir, "s1.jsonl", "dur-fixed");
    const { service, meta, fetchCalls } = makeService({ row: { path } });
    await service.handleRoundSettled("/proj", settle("alias-holder-uuid", path), "agent_end");
    expect(meta.getSessionGeneratedTitle("dur-fixed")).toBe("并发去重与幂等写入"); // 引号被清洗
    expect(meta.getSessionGeneratedTitle("alias-holder-uuid")).toBeNull(); // 键不是别名
    expect(fetchCalls).toHaveLength(1);
    const init = fetchCalls[0].init as RequestInit;
    const body = JSON.parse(String(init.body)) as { model: string; messages: Array<{ content: string }> };
    expect(body.model).toBe("test-model"); // 裸 id（剥离 provider 前缀）
    // 缺省语言 zh：golden 逐字断言 + 导出常量对照（两种语言各一份，防同义反复）
    expect(body.messages[0].content.startsWith(GOLDEN_PROMPT_ZH)).toBe(true);
    expect(TITLE_PROMPTS.zh).toBe(GOLDEN_PROMPT_ZH);
    expect(TITLE_PROMPTS.en).toBe(GOLDEN_PROMPT_EN);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k-test");
    expect(fetchCalls[0].url).toBe("http://title.test/v1/chat/completions");
    rmSync(dir, { recursive: true, force: true });
  });

  test("meta_kv titlegen.language=en：自动路径发英文 prompt（golden en 逐字）", async () => {
    const dir = tmpDir("tg-case-");
    const path = writeSessionJsonl(dir, "s1-en.jsonl", "dur-lang-en");
    const metaEn = tmpMeta();
    metaEn.setKv(TITLE_LANGUAGE_KV_KEY, "en");
    const { service, fetchCalls } = makeService({ row: { path }, meta: metaEn });
    await service.handleRoundSettled("/proj", settle("alias-en", path), "agent_end");
    const init = fetchCalls[0].init as RequestInit;
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    expect(body.messages[0].content.startsWith(GOLDEN_PROMPT_EN)).toBe(true);
    expect(body.messages[0].content.startsWith(GOLDEN_PROMPT_ZH)).toBe(false);
    // 语言每次调用时解析：改回 kv 后下一会话即回中文（设置变更不重启生效）
    metaEn.setKv(TITLE_LANGUAGE_KV_KEY, "zh");
    const path2 = writeSessionJsonl(dir, "s2-zh.jsonl", "dur-lang-zh");
    const svc2 = makeService({ row: { path: path2 }, meta: metaEn });
    await svc2.service.handleRoundSettled("/proj", settle("alias-zh", path2), "agent_end");
    const init2 = svc2.fetchCalls[0].init as RequestInit;
    const body2 = JSON.parse(String(init2.body)) as { messages: Array<{ content: string }> };
    expect(body2.messages[0].content.startsWith(GOLDEN_PROMPT_ZH)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("有 renamedTitle 不自动", async () => {
    const dir = tmpDir("tg-case-");
    const path = writeSessionJsonl(dir, "s1.jsonl", "dur-r");
    const { service, meta, fetchCalls } = makeService({ row: { path } });
    meta.setSessionRenamedTitle("dur-r", "手工名");
    await service.handleRoundSettled("/proj", settle("x", path), "agent_end");
    expect(fetchCalls).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("有引擎 name 不自动（终端 --name 会话标题永不可见）", async () => {
    const dir = tmpDir("tg-case-");
    const path = writeSessionJsonl(dir, "s1.jsonl", "dur-n");
    const { service, fetchCalls } = makeService({ row: { path, name: "eng-name" } });
    await service.handleRoundSettled("/proj", settle("x", path), "agent_end");
    expect(fetchCalls).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("已生成不重复（generatedTitle 挡）", async () => {
    const dir = tmpDir("tg-case-");
    const path = writeSessionJsonl(dir, "s1.jsonl", "dur-g");
    const { service, meta, fetchCalls } = makeService({ row: { path } });
    meta.setSessionGeneratedTitle("dur-g", "已有");
    await service.handleRoundSettled("/proj", settle("x", path), "agent_end");
    expect(fetchCalls).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("仅 user 消息（中断回合）不触发；会话行缺失静默放弃", async () => {
    const dir = tmpDir("tg-case-");
    const path = writeSessionJsonl(dir, "s1.jsonl", "dur-u", { onlyUser: true });
    const { service, fetchCalls } = makeService({ row: { path } });
    await service.handleRoundSettled("/proj", settle("x", path), "agent_end");
    expect(fetchCalls).toHaveLength(0);
    const missing = makeService({ row: null });
    await missing.service.handleRoundSettled("/proj", settle("x", "/nope.jsonl"), "agent_end"); // 不抛
    expect(missing.fetchCalls).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("失败后同会话不重试（attempted）；回调自身不 reject（不影响进程与后续回合）", async () => {
    const dir = tmpDir("tg-case-");
    const path = writeSessionJsonl(dir, "s1.jsonl", "dur-f");
    const fetchCalls: FetchCall[] = [];
    const failFetch: FetchMock = (url, init) => {
      fetchCalls.push({ url, init });
      return Promise.resolve(new Response("boom", { status: 500 }) as unknown as Response);
    };
    const { service, meta } = makeService({ row: { path }, fetchImpl: failFetch });
    // 不 reject（Bun 未处理 rejection 会退出进程，此断言即「不影响进程」）
    await service.handleRoundSettled("/proj", settle("x", path), "agent_end");
    expect(meta.getSessionGeneratedTitle("dur-f")).toBeNull();
    // 其他会话照常可服务（后续回合不受影响）
    const path2 = writeSessionJsonl(dir, "s2.jsonl", "dur-ok");
    const { service: service2, meta: meta2 } = makeService({ row: { path: path2 } });
    await service2.handleRoundSettled("/proj", settle("y", path2), "agent_end");
    expect(meta2.getSessionGeneratedTitle("dur-ok")).toBe("并发去重与幂等写入");
    // 同会话第二次 settle：attempted 挡，不再发 HTTP
    await service.handleRoundSettled("/proj", settle("x", path), "agent_settled");
    expect(fetchCalls).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("同一回合多次 settle 只触发一次（generatedTitle + in-flight 双保险）", async () => {
    const dir = tmpDir("tg-case-");
    const path = writeSessionJsonl(dir, "s1.jsonl", "dur-d");
    const { service, fetchCalls } = makeService({ row: { path } });
    await Promise.all([
      service.handleRoundSettled("/proj", settle("x", path), "agent_end"),
      service.handleRoundSettled("/proj", settle("x", path), "agent_settled"),
      service.handleRoundSettled("/proj", settle("x", path), "agent_idle"),
    ]);
    expect(fetchCalls).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("凭证缺失：warn 不崩（不 reject）", async () => {
    const dir = tmpDir("tg-case-");
    const path = writeSessionJsonl(dir, "s1.jsonl", "dur-k");
    const { service } = makeService({ row: { path }, agentDir: tmpDir("tg-noauth-") });
    await service.handleRoundSettled("/proj", settle("x", path), "agent_end"); // 不抛
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- 手动路径（service + 端点）

describe("TitleGenService.generateForSession（手动）", () => {
  test("成功写 renamedTitle（含被引擎 name 压住的会话）并返回标题", async () => {
    const dir = tmpDir("tg-case-");
    const path = writeSessionJsonl(dir, "s1.jsonl", "dur-m");
    const { service, meta } = makeService({ row: { path, name: "eng-name" } });
    const title = await service.generateForSession("dur-m");
    expect(title).toBe("并发去重与幂等写入");
    expect(meta.getSessionMeta("dur-m")?.renamedTitle).toBe("并发去重与幂等写入");
    rmSync(dir, { recursive: true, force: true });
  });

  test("HTTP 失败抛错带原因、无 user 消息/文件缺失/会话不存在抛错", async () => {
    const dir = tmpDir("tg-case-");
    const path = writeSessionJsonl(dir, "s1.jsonl", "dur-e");
    const failFetch: FetchMock = () => Promise.resolve(new Response("超时", { status: 504 }));
    const { service } = makeService({ row: { path }, fetchImpl: failFetch });
    await expectAsyncError(() => service.generateForSession("dur-e"), "HTTP 504");
    const noUser = writeSessionJsonl(dir, "s2.jsonl", "dur-e2", { noUser: true });
    const svc2 = makeService({ row: { path: noUser } }).service;
    await expectAsyncError(() => svc2.generateForSession("dur-e2"), "没有用户消息");
    const svcNone = makeService({ row: null }).service;
    await expectAsyncError(() => svcNone.generateForSession("dur-none"), "会话不存在");
    const svc3 = makeService({ row: { path: join(dir, "missing.jsonl") } }).service;
    await expectAsyncError(() => svc3.generateForSession("dur-e3"), "不可读");
    rmSync(dir, { recursive: true, force: true });
  });
});

/** 断言 promise 以含指定片段的 Error reject（bun test 无 rejects 时代的直白写法） */
async function expectAsyncError(fn: () => Promise<unknown>, fragment: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught instanceof Error && caught.message.includes(fragment)).toBe(true);
}

// ---------------------------------------------------------------- 端点级

function summaryRow(partial: Partial<EngineSessionSummary> & { id: string; path: string }): EngineSessionSummary {
  return {
    cwd: "/proj", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z",
    messageCount: 2, firstMessage: "帮我看看 tsconfig", ...partial,
  };
}

class FakeGateway implements Partial<EngineGateway> {
  rows: EngineSessionSummary[] = [];
  exportRow: { html: string; row: EngineSessionSummary } | Error | null = null;
  async sessionsList(): Promise<EngineSessionSummary[]> {
    return this.rows;
  }
  async peekActiveSessionPaths(): Promise<string[] | null> {
    return null;
  }
  async exportSessionHtml(): Promise<{ html: string; row: EngineSessionSummary }> {
    if (this.exportRow instanceof Error) throw this.exportRow;
    if (!this.exportRow) throw new ApiError(404, "session_not_found", "not canned");
    return this.exportRow;
  }
}

describe("POST /api/sessions/:id/generate-title 端点", () => {
  test("成功 200 {title} 且 renamedTitle 生效（覆盖引擎 name 层级）", async () => {
    const dir = tmpDir("tg-case-");
    const projDir = tmpDir("tg-endpoint-proj-"); // validateProjectInput 做 realpath，须真实存在
    const path = writeSessionJsonl(dir, "s1.jsonl", "dur-ep");
    const meta = tmpMeta();
    const engines = new FakeGateway();
    engines.rows = [summaryRow({ id: "dur-ep", path, cwd: projDir, name: "eng-name" })];
    const { service } = makeService({ row: { path, name: "eng-name" }, meta });
    const app = new Hono();
    app.route("/", createSessionRoutes({ meta, engines: engines as unknown as EngineGateway, titleGen: service }));
    const res = await app.request("/api/sessions/dur-ep/generate-title", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe("并发去重与幂等写入");
    // 列表标题链：renamedTitle 压过引擎 name
    const list = await app.request(`/api/sessions?project=${encodeURIComponent(projDir)}`);
    const row = ((await list.json()) as { sessions: Array<{ id: string; title: string }> }).sessions[0];
    expect(row.title).toBe("并发去重与幂等写入");
    rmSync(dir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  test("服务端语言设置 en：手动入口发英文 prompt 且 en 档 60 字符清洗", async () => {
    const dir = tmpDir("tg-case-");
    const path = writeSessionJsonl(dir, "s1-ep-en.jsonl", "dur-ep-en");
    const meta = tmpMeta();
    meta.setKv(TITLE_LANGUAGE_KV_KEY, "en");
    const engines = new FakeGateway();
    const fetchCalls: FetchCall[] = [];
    const enFetch: FetchMock = (url, init) => {
      fetchCalls.push({ url, init });
      return Promise.resolve(Response.json({ choices: [{ message: { content: "b".repeat(70) } }] }));
    };
    const { service } = makeService({ row: { path }, meta, fetchImpl: enFetch });
    const app = new Hono();
    app.route("/", createSessionRoutes({ meta, engines: engines as unknown as EngineGateway, titleGen: service }));
    const res = await app.request("/api/sessions/dur-ep-en/generate-title", { method: "POST" });
    expect(res.status).toBe(200);
    // en 档 60 字符截断（计划铖定 EN_TITLE_MAX）
    expect(((await res.json()) as { title: string }).title).toBe("b".repeat(EN_TITLE_MAX));
    // 手动入口读服务端设置：请求体 prompt 为英文 golden（不收客户端语言参数）
    const init = fetchCalls[0].init as RequestInit;
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    expect(body.messages[0].content.startsWith(GOLDEN_PROMPT_EN)).toBe(true);
    expect(meta.getSessionMeta("dur-ep-en")?.renamedTitle).toBe("b".repeat(EN_TITLE_MAX));
    rmSync(dir, { recursive: true, force: true });
  });

  test("失败 502 带原因；服务未接线 502", async () => {
    const dir = tmpDir("tg-case-");
    const path = writeSessionJsonl(dir, "s1.jsonl", "dur-502");
    const meta = tmpMeta();
    const engines = new FakeGateway();
    const failFetch: FetchMock = () => Promise.resolve(new Response("bad gateway", { status: 502 }));
    const { service } = makeService({ row: { path }, fetchImpl: failFetch });
    const app = new Hono();
    app.route("/", createSessionRoutes({ meta, engines: engines as unknown as EngineGateway, titleGen: service }));
    const res = await app.request("/api/sessions/dur-502/generate-title", { method: "POST" });
    expect(res.status).toBe(502);
    const err = (await res.json()) as { error: { code: string; message: string } };
    expect(err.error.code).toBe("title_gen_failed");
    expect(err.error.message).toContain("HTTP 502");
    const bare = new Hono();
    bare.route("/", createSessionRoutes({ meta, engines: engines as unknown as EngineGateway }));
    const res2 = await bare.request("/api/sessions/dur-502/generate-title", { method: "POST" });
    expect(res2.status).toBe(502);
    expect(((await res2.json()) as { error: { code: string } }).error.code).toBe("title_gen_unavailable");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- 链序与 export 同链

describe("resolveSessionTitle 链序与 export 文件名", () => {
  test("五层链序：renamedTitle > name > generatedTitle > firstMessage 截 80 > 兜底", () => {
    const parts = { renamedTitle: null, name: null, generatedTitle: null, firstMessage: "" };
    expect(resolveSessionTitle(parts)).toBe("(空会话)");
    expect(resolveSessionTitle({ ...parts, firstMessage: "一".repeat(90) })).toBe("一".repeat(80));
    expect(resolveSessionTitle({ ...parts, generatedTitle: "生成标题" })).toBe("生成标题");
    expect(resolveSessionTitle({ ...parts, generatedTitle: "生成标题", name: "eng" })).toBe("eng");
    expect(resolveSessionTitle({ ...parts, generatedTitle: "生成标题", name: "eng", renamedTitle: "手改" })).toBe("手改");
    // export 兜底为空串（后续 || id 回退）
    expect(resolveSessionTitle(parts, "")).toBe("");
  });

  test("export 文件名走同一链（generatedTitle 层生效）", async () => {
    const dir = tmpDir("tg-case-");
    const meta = tmpMeta();
    const engines = new FakeGateway();
    engines.exportRow = { html: "<html></html>", row: summaryRow({ id: "dur-x", path: `${dir}/x.jsonl` }) };
    const app = new Hono();
    app.route("/", createSessionRoutes({ meta, engines: engines as unknown as EngineGateway }));
    meta.setSessionGeneratedTitle("dur-x", "自动生成的标题");
    let res = await app.request("/api/sessions/dur-x/export");
    expect(res.headers.get("content-disposition")).toContain(encodeURIComponent("自动生成的标题.html"));
    meta.setSessionRenamedTitle("dur-x", "手动覆盖");
    res = await app.request("/api/sessions/dur-x/export");
    expect(res.headers.get("content-disposition")).toContain(encodeURIComponent("手动覆盖.html"));
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- engine-runtime 接线矩阵

/** 最小 fake RpcClient（T3 新契约形态）：引擎即会话，每会话一路径键控实例。
 * open 按路径 echo（createSession/ensure 的绑定 open 与显式参数 open 同路径 attach
 * 幂等，旧契约的 openScript 应答队列已无生存面）；list_sessions 回本引擎唯一
 * 会话行（durable 权威来源）。durableId 由 FakeManager 按预生成路径注入序分配
 * （空串 = 未认领别名流）。 */
let fakeAnonHandleSeq = 0;
class FakeRpcClient {
  readonly eventListeners: Array<(e: { type: string; [k: string]: unknown }) => void> = [];
  readonly handle: string;
  isStreaming = false;
  constructor(
    readonly sessionPath: string,
    readonly durableId: string,
    private readonly cwd: string,
  ) {
    this.handle = durableId ? `rpc-${durableId}` : `rpc-anon-${++fakeAnonHandleSeq}`;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async setClientInfo(): Promise<void> {}
  send(): Promise<{ success: boolean }> {
    return Promise.resolve({ success: true });
  }
  async openSession(options: { sessionPath?: string }): Promise<{ sessionId: string; state: { sessionId: string; sessionFile: string } }> {
    // 顶层 sessionId = routing handle（wire 事件同源）；state.sessionId = 引擎认领
    // 身份（未认领时即 handle 本身）；sessionFile echo 实际 open 的路径
    return {
      sessionId: this.handle,
      state: { sessionId: this.durableId || this.handle, sessionFile: options.sessionPath ?? this.sessionPath },
    };
  }
  async closeSession(): Promise<void> {}
  async listSessions(): Promise<Array<Record<string, unknown>>> {
    const row: Record<string, unknown> = {
      sessionId: this.handle,
      sessionPath: this.sessionPath,
      cwd: this.cwd,
      status: "open",
    };
    if (this.durableId) row.durableSessionId = this.durableId;
    return [row];
  }
  async getEntries(): Promise<{ entries: never[]; leafId: null }> {
    return { entries: [], leafId: null };
  }
  async fork(): Promise<never> {
    throw new Error("not canned");
  }
  async prompt(): Promise<string> {
    return "started";
  }
  async abort(): Promise<void> {}
  onEvent(listener: (e: { type: string; [k: string]: unknown }) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners.splice(this.eventListeners.indexOf(listener), 1);
    };
  }
  async sendExtensionUIResponse(): Promise<void> {}
  async getAvailableModels(): Promise<never[]> {
    return [];
  }
  async getAvailableThinkingLevels(): Promise<never[]> {
    return [];
  }
  async getSessionStats(): Promise<Record<string, unknown>> {
    return {};
  }
  async getMedia(): Promise<never> {
    throw new Error("not canned");
  }
  /** checkSettle 经 cast 直接调用 */
  async getState(): Promise<{ isStreaming: boolean }> {
    return { isStreaming: this.isStreaming };
  }
  emit(event: { type: string; [k: string]: unknown }): void {
    for (const l of this.eventListeners) l(event);
  }
}

class FakeManager {
  /** 路径 → 引擎（T1 键迁移：每会话一台，ensure 按目标路径解析） */
  readonly rpcs = new Map<string, FakeRpcClient>();
  /** createSession 预生成路径（运行期才可知）的 durable 注入队列：ensureRunning 造
   * 路径专属引擎实例时按到达序消费（空串 = 未认领别名流）。 */
  readonly pregenDurables: string[] = [];
  private listeners: Array<(e: { type: string; [k: string]: unknown }) => void> = [];
  onEvent(listener: (e: { type: string; [k: string]: unknown }) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners.splice(this.listeners.indexOf(listener), 1);
    };
  }
  emit(event: { type: string; [k: string]: unknown }): void {
    for (const l of this.listeners) l(event);
  }
  async ensureRunning(sessionPath: string, projectPath: string): Promise<void> {
    if (!this.rpcs.has(sessionPath)) {
      this.rpcs.set(sessionPath, new FakeRpcClient(sessionPath, this.pregenDurables.shift() ?? "", projectPath));
    }
  }
  getStatus(): { state: string } {
    return { state: "ready" };
  }
  getClient(sessionPath: string): FakeRpcClient | undefined {
    return this.rpcs.get(sessionPath);
  }
  async stop(): Promise<void> {}
  async stopAll(): Promise<void> {}
  reportPermissionAnswered(): void {}
}

interface RegistryHarness {
  registry: EngineRuntimeRegistry;
  manager: FakeManager;
  settledCalls: Array<{ projectPath: string; info: RoundSettleInfo; reason: string }>;
  syntheticEvents: Array<Record<string, unknown>>;
  projectPath: string;
  agentDir: string;
}

function buildRegistry(extra?: Partial<EngineRuntimeOptions>): RegistryHarness {
  const projectPath = tmpDir("tg-proj-");
  const agentDir = tmpDir("tg-agent-");
  const manager = new FakeManager();
  const settledCalls: Array<{ projectPath: string; info: RoundSettleInfo; reason: string }> = [];
  const syntheticEvents: Array<Record<string, unknown>> = [];
  const registry = new EngineRuntimeRegistry(manager as never, {
    listProjects: () => [projectPath],
    agentDir,
    publishSyntheticEvent: (_p, event) => {
      syntheticEvents.push(event);
    },
    onRoundSettled: (pp, info, reason) => {
      settledCalls.push({ projectPath: pp, info, reason });
    },
    settlePollMs: 15,
    settleGraceMs: 25,
    ...extra,
  });
  return { registry, manager, settledCalls, syntheticEvents, projectPath, agentDir };
}

/** 建会话 → 落盘回执 → 首回合（T3 新契约形态）：会话路径由运行时预生成（uuid 落
 * agent 会话库，createSession 回带），fixture 在该路径补写会话头模拟引擎落盘
 * （durable 存在性复核与真实引擎同源读盘）。 */
async function startRound(
  h: RegistryHarness,
  fixture: { durable: string },
): Promise<{ id: string; path: string; client: FakeRpcClient }> {
  h.manager.pregenDurables.push(fixture.durable);
  const created = await h.registry.createSession(h.projectPath, {});
  writeSessionJsonl(dirname(created.sessionPath), basename(created.sessionPath), fixture.durable, { cwd: h.projectPath });
  await h.registry.prompt(created.id, { text: "hi" });
  const client = h.manager.getClient(created.sessionPath);
  if (!client) throw new Error("ensure 未按预生成路径造引擎");
  return { id: created.id, path: created.sessionPath, client };
}

/** 有界条件等待（禁真睡：条件驱动 + 硬截止，不用固定时长赌定时器） */
async function waitForCondition(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error("waitForCondition deadline exceeded");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("EngineRuntimeRegistry.onRoundSettled 接线", () => {
  test("事件路径触发：wire handle 解析 durable 落 settleInfo；同回合多事件只触发一次", async () => {
    const h = buildRegistry();
    const a = await startRound(h, { durable: "dur-a" });
    a.client.emit({ type: "agent_end", sessionId: `rpc-${"dur-a"}` });
    expect(h.settledCalls).toEqual([{ projectPath: h.projectPath, info: { sessionId: a.id, sessionPath: a.path }, reason: "agent_end" }]);
    // 后续同回合事件：回合行已清位，不重复触发
    a.client.emit({ type: "agent_settled", sessionId: "rpc-dur-a" });
    a.client.emit({ type: "agent_idle", sessionId: "rpc-dur-a" });
    expect(h.settledCalls).toHaveLength(1);
    rmSync(h.projectPath, { recursive: true, force: true });
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  test("wire sessionId 不匹配只清位不触发（并发错触防护）", async () => {
    const h = buildRegistry();
    const a = await startRound(h, { durable: "dur-a" });
    const b = await startRound(h, { durable: "dur-b" });
    // A 的收尾 handle 打到 B 的引擎：归属校验不过 → B 只清位不触发；T3 引擎即会话，
    // 兄弟回合挂各自引擎监听器下，A 的回合不受 B 引擎上的错触事件影响
    b.client.emit({ type: "agent_end", sessionId: `rpc-${"dur-a"}` });
    expect(h.settledCalls).toHaveLength(0);
    const states = await h.registry.peekRunStates(h.projectPath);
    expect([...states!.keys()]).toEqual([a.path]);
    expect(states!.get(a.path)).toBe("running");
    rmSync(h.projectPath, { recursive: true, force: true });
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  test("别名 sessionId 事件路径放行（durable 解析不出 = 归属未证明不排除）", async () => {
    const h = buildRegistry();
    // 无预生成 durable 注入：引擎未认领 → createSession 退化为 handle 别名
    const created = await h.registry.createSession(h.projectPath, {});
    expect(created.durable).toBe(false);
    await h.registry.prompt(created.id, { text: "hi" });
    const client = h.manager.getClient(created.sessionPath);
    if (!client) throw new Error("ensure 未按预生成路径造引擎");
    client.emit({ type: "agent_end", sessionId: created.id }); // wire handle 即别名
    expect(h.settledCalls).toHaveLength(1);
    expect(h.settledCalls[0].info.sessionId).toBe(created.id); // 别名原样透传，title-gen 经 jsonl 解析
    expect(h.settledCalls[0].info.sessionPath).toBe(created.sessionPath);
    rmSync(h.projectPath, { recursive: true, force: true });
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  test("合成 watchdog 触发（reason=settle_watchdog），synthetic 事件不回归", async () => {
    const h = buildRegistry();
    const w = await startRound(h, { durable: "dur-w" });
    w.client.isStreaming = false; // get_state 复核空闲 → 宽限后合成
    await waitForCondition(() => h.settledCalls.length > 0);
    expect(h.settledCalls).toEqual([
      { projectPath: h.projectPath, info: { sessionId: w.id, sessionPath: w.path }, reason: "settle_watchdog" },
    ]);
    expect(h.syntheticEvents).toHaveLength(1);
    expect(h.syntheticEvents[0]).toMatchObject({ type: "agent_settled", synthetic: true, sessionId: w.id, reason: "settle_watchdog" });
    rmSync(h.projectPath, { recursive: true, force: true });
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  test("crashSettle 不触发 onRoundSettled（engine_crash 排除），synthetic 事件不回归", async () => {
    const h = buildRegistry();
    const c = await startRound(h, { durable: "dur-c" });
    // 事件缺 sessionPath → 项目级兜底全结（T3 保留的旧口径）
    h.manager.emit({ type: "process_crashed", projectPath: h.projectPath });
    expect(h.settledCalls).toHaveLength(0);
    expect(h.syntheticEvents).toHaveLength(1);
    expect(h.syntheticEvents[0]).toMatchObject({ type: "agent_settled", synthetic: true, sessionId: c.id, reason: "engine_crash" });
    rmSync(h.projectPath, { recursive: true, force: true });
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  test("resolveSessionRow：durable/别名都解析出 path，未知返回 null，不触发 spawn", async () => {
    const h = buildRegistry();
    const r = await startRound(h, { durable: "dur-r2" });
    expect(await h.registry.resolveSessionRow(r.id)).toMatchObject({ path: r.path, id: r.id });
    const alias = await h.registry.resolveSessionRow(`rpc-${"dur-r2"}`);
    expect(alias).toBeNull(); // handle 非 API 身份（durable 会话未注册别名）
    expect(await h.registry.resolveSessionRow("nope")).toBeNull();
    rmSync(h.projectPath, { recursive: true, force: true });
    rmSync(h.agentDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- r10 todo 2：手动路径取尾 / 自动路径仍取首

/** 首尾话题不同的长会话：header + 开头苹果主题 + 超尾窗填充 + 结尾香蕉主题 */
function writeLongHeadTailJsonl(dir: string, name: string, durableId: string): string {
  const mk = (id: string, role: string, text: string) =>
    JSON.stringify({ type: "message", id, parentId: null, timestamp: "t", message: { role, content: [{ type: "text", text }] } });
  const filler = mk("f", "user", "填充内容。".repeat(400));
  const pad = Math.ceil((SESSION_TAIL_CHARS * 2) / filler.length);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: durableId, timestamp: "2026-10-11T00:00:00.000Z", cwd: dir }),
    mk("u0", "user", "开头主题苹果"),
    mk("a0", "assistant", "苹果是水果"),
  ];
  for (let i = 0; i < pad; i++) lines.push(filler);
  lines.push(mk("u9", "user", "结尾主题香蕉"), mk("a9", "assistant", "香蕉也是水果"));
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, lines.join("\n"));
  return path;
}

function promptOf(call: FetchCall): string {
  const body = JSON.parse((call.init as RequestInit).body as string) as { messages: Array<{ content: string }> };
  return body.messages[0].content;
}

describe("r10 todo 2（手动标题取尾）", () => {
  test("手动路径：prompt 含尾部话题、不含开头话题；结果仍写 renamedTitle", async () => {
    const dir = tmpDir("tg-tail-");
    const path = writeLongHeadTailJsonl(dir, "long.jsonl", "dur-long");
    const { service, meta, fetchCalls } = makeService({ row: { path } });
    const title = await service.generateForSession("whatever");
    expect(title).toBe("并发去重与幂等写入");
    // renamedTitle 经 getSessionMeta 读取（meta 无独立 getter）
    expect(meta.getSessionMeta("dur-long")?.renamedTitle).toBe("并发去重与幂等写入");
    const prompt = promptOf(fetchCalls[0]);
    expect(prompt).toContain("结尾主题香蕉");
    expect(prompt).not.toContain("开头主题苹果");
    expect(prompt).not.toContain("苹果");
  });

  test("自动路径不变：仍读首部，prompt 含开头话题", async () => {
    const dir = tmpDir("tg-auto-");
    const path = writeLongHeadTailJsonl(dir, "long.jsonl", "dur-auto");
    const { service, fetchCalls } = makeService({ row: { path } });
    await service.handleRoundSettled("/proj", settle("alias", path), "agent_end");
    expect(fetchCalls).toHaveLength(1);
    const prompt = promptOf(fetchCalls[0]);
    expect(prompt).toContain("开头主题苹果");
    expect(prompt).not.toContain("结尾主题香蕉");
  });

  test("手动路径空会话/无 user 消息：降级报错不崩", async () => {
    const dir = tmpDir("tg-empty-");
    const emptyPath = join(dir, "empty.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(emptyPath, "");
    const { service } = makeService({ row: { path: emptyPath } });
    await expect(service.generateForSession("x")).rejects.toThrow("会话文件不可读或未落盘");
    const onlyAssistant = join(dir, "no-user.jsonl");
    writeFileSync(
      onlyAssistant,
      JSON.stringify({ type: "session", version: 3, id: "dur-nu", timestamp: "t", cwd: dir }) +
        "\n" +
        JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "只有助手" }] } }),
    );
    const svc2 = makeService({ row: { path: onlyAssistant } });
    await expect(svc2.service.generateForSession("x")).rejects.toThrow("会话还没有用户消息");
  });
});
