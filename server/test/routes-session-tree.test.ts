/**
 * session-branching todo 3：GET /api/sessions/:id/tree + POST /api/sessions/:id/navigate
 * 路由层测试。
 * - tree 磁盘优先：多分支 fixture 直读（树形/childCount/activeLeafId=文件末条/全文不下发）
 * - 预览 160 字定死（超长文本截断）
 * - activeLeafId 双口径：在途取引擎 RPC 叶 + unreachableIds 压缩剪除回填；
 *   引擎叶对账失败退回文件末条（stale_state 兑底）
 * - 文件不在回退引擎 getTree RPC（嵌套树平铺）；网关无树通道 501 tree_unsupported
 * - navigate：happy（select 回 leafId+editorText、CAS expectedLeafId 原样透传）/
 *   resume 无 editorText / 引擎在途 409 already_processing / 坏 body 三连 400
 * - todo 9：POST /edit-assistant（改写副本成新叶，CAS 透传/outcome/entry 回传/坏 body
 *   400/409/501）+ POST /continue（从叶无新 prompt 续跑，CAS 透传/409/501）
 * - 鉴权：/api/* cookie 中间件，无 cookie 401
 */
import { describe, expect, test, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createSessionRoutes, TREE_PREVIEW_CHARS } from "../src/api/routes-session";
import { openMetaDb } from "../src/db/meta";
import { openConfigStore } from "../src/conf/config-store";
import { createProjectConfigStores } from "../src/api/config-migration";
import { createAuth } from "../src/auth/password";
import type { EngineGateway } from "../src/api/engine-runtime";
import type {
  EngineCommandInfo,
  EngineEntry,
  EngineModelInfo,
  EngineMessagesPage,
  EngineNavigateTreeInput,
  EngineNavigateTreeResult,
  EngineAssistantEditInput,
  EngineAssistantEditResult,
  EnginePermissionReply,
  EnginePromptInput,
  EngineQueueSnapshot,
  EngineQuestionFrame,
  EngineSessionSummary,
  EngineThinkingLevel,
  EngineTreeNode,
  EngineUsageStats,
} from "../src/adapter/engine-adapter";
import { ApiError } from "../src/api/http";

// 临时目录登记与统一清理（session-file.test 同口径）
const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── fixture：多分支会话文件（e4/mc 在 A 支，e5 是 e3 的兄弟分支）──────────────

const LONG_TEXT = "x".repeat(300);

function msgEntry(id: string, parentId: string | null, role: "user" | "assistant", text: string): EngineEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-01-01T00:00:0${id.length}.000Z`,
    message: { role, content: [{ type: "text", text }] },
  };
}

const FIXTURE_ENTRIES: EngineEntry[] = [
  msgEntry("e1", null, "user", "你好，帮我看看这个问题"),
  msgEntry("e2", "e1", "assistant", "好的，我先分析一下"),
  msgEntry("e3", "e2", "user", "换个思路"),
  msgEntry("e4", "e3", "assistant", LONG_TEXT),
  { type: "model_change", id: "mc1", parentId: "e4", timestamp: "2026-01-01T00:00:09.000Z", model: "p/m" },
  msgEntry("e5", "e3", "user", "再试一次"),
];

function writeSessionFile(entries: EngineEntry[]): string {
  const dir = mkTemp("routes-tree-");
  const path = join(dir, "s.jsonl");
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "hdr-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/p" }),
    ...entries.map((e) => JSON.stringify(e)),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

/** 引擎嵌套树节点（测试构造用） */
function engineNode(entry: EngineEntry, children: EngineTreeNode[] = []): EngineTreeNode {
  return { entry, children };
}

// ── FakeGateway：仅实现本测试触及的面；树三面可编程 ──────────────────────

class FakeGateway implements EngineGateway {
  /** sessionPath 可选面返回值（指向不存在的文件 = 未落盘/别名回退引擎路径） */
  sessionPathResult = "unset";
  runningValue = false;
  treeGetResult: { tree: EngineTreeNode[]; leafId: string | null } = { tree: [], leafId: null };
  treeGetError: unknown = null;
  navigateResult: EngineNavigateTreeResult = { leafId: null, cancelled: false };
  navigateError: unknown = null;
  capturedNavigate: Array<{ id: string; input: EngineNavigateTreeInput }> = [];
  editResult: EngineAssistantEditResult = { outcome: "edited", leafId: null };
  editError: unknown = null;
  capturedEdit: Array<{ id: string; input: EngineAssistantEditInput }> = [];
  continueError: unknown = null;
  capturedContinue: Array<{ id: string; input?: { expectedLeafId?: string } }> = [];

  async sessionPath(_id: string): Promise<string> {
    return this.sessionPathResult;
  }
  async peekSessionRunning(_id: string): Promise<boolean> {
    return this.runningValue;
  }
  async treeGet(_id: string): Promise<{ tree: EngineTreeNode[]; leafId: string | null }> {
    if (this.treeGetError) throw this.treeGetError;
    return this.treeGetResult;
  }
  async treeNavigate(id: string, input: EngineNavigateTreeInput): Promise<EngineNavigateTreeResult> {
    this.capturedNavigate.push({ id, input });
    if (this.navigateError) throw this.navigateError;
    return this.navigateResult;
  }
  async treeEditAssistant(id: string, input: EngineAssistantEditInput): Promise<EngineAssistantEditResult> {
    this.capturedEdit.push({ id, input });
    if (this.editError) throw this.editError;
    return this.editResult;
  }
  async treeContinueFromLeaf(id: string, input?: { expectedLeafId?: string }): Promise<void> {
    this.capturedContinue.push({ id, input });
    if (this.continueError) throw this.continueError;
  }
  async sessionsList(): Promise<EngineSessionSummary[]> {
    return [];
  }
  async createSession(
    _project: string,
    _opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    throw new ApiError(500, "internal", "not expected");
  }
  async messages(_id: string, _cursor?: string): Promise<EngineMessagesPage> {
    return { entries: [], leafId: null, cursor: null };
  }
  // deno-lint-ignore require-await
  async prompt(
    _id: string,
    _input: {
      text: string;
      images?: EnginePromptInput["images"];
      model?: string;
      thinkingLevel?: EngineThinkingLevel;
      streamingBehavior?: EnginePromptInput["streamingBehavior"];
    },
  ): Promise<{ disposition: string }> {
    return { disposition: "started" };
  }
  async queueList(): Promise<EngineQueueSnapshot> {
    return { steering: [], followUp: [], ordered: [] };
  }
  async queueClear(): Promise<EngineQueueSnapshot> {
    return { steering: [], followUp: [], ordered: [] };
  }
  async abort(): Promise<void> {}
  async permissionRespond(_id: string, _requestId: string, _reply: EnginePermissionReply): Promise<void> {}
  async questionsList(_id: string): Promise<EngineQuestionFrame[]> {
    return [];
  }
  async usage(): Promise<EngineUsageStats> {
    return {
      sessionId: "s1",
      sessionFile: "/proj/s1.jsonl",
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      contextUsage: { tokens: 0, contextWindow: 1000000, percent: 0 },
    };
  }
  async modelsList(): Promise<EngineModelInfo[]> {
    return [];
  }
  async commandsList(_project: string): Promise<EngineCommandInfo[] | null> {
    return null;
  }
  async deleteSession(): Promise<{ sessionPath: string; fileExisted: boolean }> {
    return { sessionPath: "/proj/s1.jsonl", fileExisted: false };
  }
  async exportSessionHtml(): Promise<{ html: string; row: EngineSessionSummary }> {
    throw new ApiError(409, "session_not_persisted", "not expected");
  }
  async forkSession(): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }> {
    throw new ApiError(500, "internal", "not expected");
  }
  peekActiveSessionPaths(): Promise<string[] | null> {
    return Promise.resolve([]);
  }
  async restartProject(): Promise<void> {}
  async stopAll(): Promise<void> {}
}

function buildApp(engines: EngineGateway): Hono {
  const app = new Hono();
  const configs = openConfigStore({ globalDir: join(mkTemp("routes-tree-cfg-"), "global") });
  const meta = openMetaDb({ path: join(mkTemp("routes-tree-meta-"), "meta.db") });
  app.route("/", createSessionRoutes({ meta, engines, configs, projectConfigs: createProjectConfigStores(configs) }));
  return app;
}

function diskGateway(sessionPath: string): FakeGateway {
  const gateway = new FakeGateway();
  gateway.sessionPathResult = sessionPath;
  return gateway;
}

// ── GET /api/sessions/:id/tree ────────────────────────────────────────────

describe("GET /api/sessions/:id/tree（session-branching todo 3）", () => {
  test("磁盘直读：多分支 fixture 树形/childCount/activeLeafId=末条，全文不下发", async () => {
    const gateway = diskGateway(writeSessionFile(FIXTURE_ENTRIES));
    const res = await buildApp(gateway).request("/api/sessions/s1/tree");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      source: string;
      activeLeafId: string | null;
      nodes: Array<{ id: string; parentId: string | null; role: string; preview: string; timestamp: string; childCount: number }>;
      unreachableIds?: string[];
    };
    expect(body.sessionId).toBe("s1");
    expect(body.source).toBe("disk");
    // 文件序全量节点（header 行不计）
    expect(body.nodes.map((n) => n.id)).toEqual(["e1", "e2", "e3", "e4", "mc1", "e5"]);
    // parentId 链：e1 根、e3 有两个子（分支点）、e5 与 e4 同父
    expect(body.nodes[0]).toMatchObject({ id: "e1", parentId: null, role: "user", childCount: 1 });
    expect(body.nodes[2]).toMatchObject({ id: "e3", parentId: "e2", childCount: 2 });
    expect(body.nodes[3]).toMatchObject({ id: "e4", parentId: "e3", childCount: 1 });
    expect(body.nodes[5]).toMatchObject({ id: "e5", parentId: "e3", childCount: 0 });
    // 非 message 型：role 回退 entry.type、preview 空
    expect(body.nodes[4]).toMatchObject({ id: "mc1", role: "model_change", preview: "", childCount: 0 });
    // 空闲态（不在途）：activeLeafId = 文件末条 id
    expect(body.activeLeafId).toBe("e5");
    // 全文绝不下发（misleading_success_output：以响应体为准，非日志）
    expect(JSON.stringify(body).includes(LONG_TEXT)).toBe(false);
    // 引擎未参与：treeGet 未被调用
    expect(gateway.capturedNavigate).toHaveLength(0);
  });

  test(`预览截断：超长文本 preview 恰 ${TREE_PREVIEW_CHARS} 字`, async () => {
    const gateway = diskGateway(writeSessionFile(FIXTURE_ENTRIES));
    const res = await buildApp(gateway).request("/api/sessions/s1/tree");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: Array<{ id: string; preview: string }> };
    const e4 = body.nodes.find((n) => n.id === "e4")!;
    expect(e4.preview).toBe(LONG_TEXT.slice(0, TREE_PREVIEW_CHARS));
    expect(e4.preview.length).toBe(TREE_PREVIEW_CHARS);
  });

  test("activeLeafId 引擎口径：在途取 RPC 叶 + unreachableIds 压缩剪除回填", async () => {
    const gateway = diskGateway(writeSessionFile(FIXTURE_ENTRIES));
    gateway.runningValue = true;
    // 引擎在 A 支（叶 e4），且压缩后 mc1/e5 不在引擎树中
    gateway.treeGetResult = {
      tree: [engineNode(FIXTURE_ENTRIES[0]!, [engineNode(FIXTURE_ENTRIES[1]!, [engineNode(FIXTURE_ENTRIES[2]!, [engineNode(FIXTURE_ENTRIES[3]!)])])])],
      leafId: "e4",
    };
    const res = await buildApp(gateway).request("/api/sessions/s1/tree");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; activeLeafId: string | null; unreachableIds?: string[] };
    // 引擎叶优先于文件末条（流式中文件滞后，引擎是真相源）
    expect(body.activeLeafId).toBe("e4");
    expect(body.source).toBe("disk");
    // 磁盘有而引擎树无 = 不可达（文件序）
    expect(body.unreachableIds).toEqual(["mc1", "e5"]);
  });

  test("引擎叶对账失败退回文件末条（stale_state 兑底不炸读取）", async () => {
    const gateway = diskGateway(writeSessionFile(FIXTURE_ENTRIES));
    gateway.runningValue = true;
    gateway.treeGetError = new Error("rpc down");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await buildApp(gateway).request("/api/sessions/s1/tree");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { activeLeafId: string | null; unreachableIds?: string[] };
      expect(body.activeLeafId).toBe("e5");
      expect(body.unreachableIds).toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("引擎回退：文件不在走 getTree RPC，嵌套树平铺 childCount=children 长度", async () => {
    const gateway = new FakeGateway();
    // sessionPath 面在但文件不存在（未落盘/别名）
    gateway.sessionPathResult = join(mkTemp("routes-tree-missing-"), "missing.jsonl");
    gateway.treeGetResult = {
      tree: [
        engineNode(FIXTURE_ENTRIES[0]!, [engineNode(FIXTURE_ENTRIES[1]!, [engineNode(FIXTURE_ENTRIES[2]!)])]),
      ],
      leafId: "e3",
    };
    const res = await buildApp(gateway).request("/api/sessions/s1/tree");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      activeLeafId: string | null;
      nodes: Array<{ id: string; childCount: number; role: string; parentId: string | null }>;
    };
    expect(body.source).toBe("engine");
    expect(body.activeLeafId).toBe("e3");
    expect(body.nodes.map((n) => n.id)).toEqual(["e1", "e2", "e3"]);
    expect(body.nodes[0]).toMatchObject({ id: "e1", parentId: null, role: "user", childCount: 1 });
    expect(body.nodes[2]).toMatchObject({ id: "e3", childCount: 0 });
  });

  test("网关无树通道：501 tree_unsupported", async () => {
    const gateway = new FakeGateway();
    // 网关无 sessionPath 直读面（老 fake）且无 treeGet
    (gateway as Partial<EngineGateway>).sessionPath = undefined;
    (gateway as Partial<EngineGateway>).treeGet = undefined;
    const res = await buildApp(gateway).request("/api/sessions/s1/tree");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("tree_unsupported");
  });
});

// ── POST /api/sessions/:id/navigate ───────────────────────────────────────

describe("POST /api/sessions/:id/navigate（session-branching todo 3）", () => {
  test("happy：select 回 leafId+editorText，入参（含 CAS expectedLeafId）原样透传", async () => {
    const gateway = new FakeGateway();
    gateway.navigateResult = { leafId: "e3", cancelled: false, editorText: "回填原文" };
    const res = await buildApp(gateway).request("/api/sessions/s1/navigate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "e3", intent: "select", expectedLeafId: "e5" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; leafId: string | null; editorText?: string; cancelled?: boolean };
    expect(body).toEqual({ sessionId: "s1", leafId: "e3", editorText: "回填原文" });
    // CAS 透传断言：网关收到的入参与请求体逐字段一致
    expect(gateway.capturedNavigate).toEqual([
      { id: "s1", input: { entryId: "e3", intent: "select", expectedLeafId: "e5" } },
    ]);
  });

  test("resume 无 expectedLeafId：回执无 editorText 字段，透传缺省", async () => {
    const gateway = new FakeGateway();
    gateway.navigateResult = { leafId: "e2", cancelled: false };
    const res = await buildApp(gateway).request("/api/sessions/s1/navigate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "e2", intent: "resume" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { leafId: string | null; editorText?: string };
    expect(body.leafId).toBe("e2");
    expect("editorText" in body).toBe(false);
    const captured = gateway.capturedNavigate.at(-1)!;
    expect(captured.input).toEqual({ entryId: "e2", intent: "resume", expectedLeafId: undefined });
  });

  test("引擎在途 409 already_processing（错误码保持，fork 先例同款）", async () => {
    const gateway = new FakeGateway();
    gateway.navigateError = new ApiError(409, "already_processing", "该会话回合进行中，导航前请等待回合结束或 abort");
    const res = await buildApp(gateway).request("/api/sessions/s1/navigate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "e3", intent: "select" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("already_processing");
    expect(body.error.message).toContain("回合进行中");
  });

  test("坏 body 三连：缺 entryId/坏 intent/坏 expectedLeafId/非 JSON 各自独立错误码", async () => {
    const app = buildApp(new FakeGateway());
    const post = (raw: string) =>
      app.request("/api/sessions/s1/navigate", { method: "POST", headers: { "content-type": "application/json" }, body: raw });

    const noEntry = await post(JSON.stringify({ intent: "select" }));
    expect(noEntry.status).toBe(400);
    expect(((await noEntry.json()) as { error: { code: string } }).error.code).toBe("invalid_entry");

    const badIntent = await post(JSON.stringify({ entryId: "e3", intent: "jump" }));
    expect(badIntent.status).toBe(400);
    expect(((await badIntent.json()) as { error: { code: string } }).error.code).toBe("invalid_intent");

    const badLeaf = await post(JSON.stringify({ entryId: "e3", intent: "select", expectedLeafId: 42 }));
    expect(badLeaf.status).toBe(400);
    expect(((await badLeaf.json()) as { error: { code: string } }).error.code).toBe("invalid_leaf");

    const badJson = await post("not-json");
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { error: { code: string } }).error.code).toBe("invalid_json");
  });

  test("网关无导航通道：501 tree_unsupported", async () => {
    const gateway = new FakeGateway();
    (gateway as Partial<EngineGateway>).treeNavigate = undefined;
    const res = await buildApp(gateway).request("/api/sessions/s1/navigate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "e3", intent: "select" }),
    });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("tree_unsupported");
  });
});

// ── POST /api/sessions/:id/edit-assistant（todo 9：edit_assistant_message）──────

describe("POST /api/sessions/:id/edit-assistant（session-branching todo 9）", () => {
  test("happy：改写副本成新叶，outcome/leafId/entry 回传，CAS expectedLeafId 原样透传", async () => {
    const gateway = new FakeGateway();
    gateway.editResult = {
      outcome: "edited",
      leafId: "copy-graft-1",
      entry: FIXTURE_ENTRIES[1]!,
    };
    const res = await buildApp(gateway).request("/api/sessions/s1/edit-assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "e2", text: "编辑后的回复", expectedLeafId: "e5" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      outcome: string;
      leafId: string | null;
      entry?: EngineEntry;
    };
    expect(body.sessionId).toBe("s1");
    expect(body.outcome).toBe("edited");
    expect(body.leafId).toBe("copy-graft-1");
    expect(body.entry?.id).toBe("e2");
    // CAS 透传断言：网关收到的入参与请求体逐字段一致（误导性成功输出防线）
    expect(gateway.capturedEdit).toEqual([
      { id: "s1", input: { entryId: "e2", text: "编辑后的回复", expectedLeafId: "e5" } },
    ]);
  });

  test("坏 body：缺 entryId / 空 text / 坏 expectedLeafId 各自独立 400 错误码", async () => {
    const app = buildApp(new FakeGateway());
    const post = (raw: string) =>
      app.request("/api/sessions/s1/edit-assistant", { method: "POST", headers: { "content-type": "application/json" }, body: raw });

    const noEntry = await post(JSON.stringify({ text: "x" }));
    expect(noEntry.status).toBe(400);
    expect(((await noEntry.json()) as { error: { code: string } }).error.code).toBe("invalid_entry");

    const blankText = await post(JSON.stringify({ entryId: "e2", text: "   " }));
    expect(blankText.status).toBe(400);
    expect(((await blankText.json()) as { error: { code: string } }).error.code).toBe("invalid_text");

    const badLeaf = await post(JSON.stringify({ entryId: "e2", text: "x", expectedLeafId: 42 }));
    expect(badLeaf.status).toBe(400);
    expect(((await badLeaf.json()) as { error: { code: string } }).error.code).toBe("invalid_leaf");
  });

  test("引擎在途 409 already_processing（单驱动纪律，treeNavigate 同款）", async () => {
    const gateway = new FakeGateway();
    gateway.editError = new ApiError(409, "already_processing", "该会话回合进行中，编辑前请等待回合结束或 abort");
    const res = await buildApp(gateway).request("/api/sessions/s1/edit-assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "e2", text: "x" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("already_processing");
  });

  test("网关无编辑通道：501 tree_unsupported", async () => {
    const gateway = new FakeGateway();
    (gateway as Partial<EngineGateway>).treeEditAssistant = undefined;
    const res = await buildApp(gateway).request("/api/sessions/s1/edit-assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "e2", text: "x" }),
    });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("tree_unsupported");
  });
});

// ── POST /api/sessions/:id/continue（todo 9：continue_from_leaf）──────────

describe("POST /api/sessions/:id/continue（session-branching todo 9）", () => {
  test("happy：从叶无新 prompt 续跑，expectedLeafId 透传，回 sessionId", async () => {
    const gateway = new FakeGateway();
    const res = await buildApp(gateway).request("/api/sessions/s1/continue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedLeafId: "copy-graft-1" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ sessionId: "s1" });
    expect(gateway.capturedContinue).toEqual([{ id: "s1", input: { expectedLeafId: "copy-graft-1" } }]);
  });

  test("空体缺省：不带 expectedLeafId 也可续跑（宿主预留 CAS 通道缺省不发）", async () => {
    const gateway = new FakeGateway();
    const res = await buildApp(gateway).request("/api/sessions/s1/continue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(gateway.capturedContinue).toEqual([{ id: "s1", input: { expectedLeafId: undefined } }]);
  });

  test("引擎在途 409 already_processing；坏 expectedLeafId 400 invalid_leaf", async () => {
    const gateway = new FakeGateway();
    gateway.continueError = new ApiError(409, "already_processing", "该会话回合进行中，续跑前请等待回合结束或 abort");
    const res = await buildApp(gateway).request("/api/sessions/s1/continue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("already_processing");

    const badLeaf = await buildApp(new FakeGateway()).request("/api/sessions/s1/continue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedLeafId: "" }),
    });
    expect(badLeaf.status).toBe(400);
    expect(((await badLeaf.json()) as { error: { code: string } }).error.code).toBe("invalid_leaf");
  });

  test("网关无续跑通道：501 tree_unsupported", async () => {
    const gateway = new FakeGateway();
    (gateway as Partial<EngineGateway>).treeContinueFromLeaf = undefined;
    const res = await buildApp(gateway).request("/api/sessions/s1/continue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("tree_unsupported");
  });
});

// ── 鉴权（/api/* cookie 中间件，auth.test 同款装配）────────────────────────

describe("tree/navigate 鉴权", () => {
  test("无 cookie：GET /tree 与 POST /navigate 均 401", async () => {
    const dataDir = mkTemp("routes-tree-auth-");
    const auth = createAuth(dataDir, "test-pass");
    const app = new Hono();
    app.use("/api/*", auth.middleware);
    app.route("/", buildApp(new FakeGateway()));
    const tree = await app.request("/api/sessions/s1/tree");
    expect(tree.status).toBe(401);
    const nav = await app.request("/api/sessions/s1/navigate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "e3", intent: "select" }),
    });
    expect(nav.status).toBe(401);
  });
});
