// 标签定义与挂载端点单测（todo 3）：聚焦 HTTP 语义层——定义两源合并/整替/
// 重名 400、挂载整替/去重/回显、GET /api/sessions tags 字段注入与 tag OR
// 过滤（单项目 + 聚合两模式）、孤儿挂载如实返回、自由挂载。config-store
// 读写与 meta sessionTag 行为已由 config-store.test.ts / meta-notes-tags.test.ts
// 锁定，此处不重复。全部 mkdtemp 隔离，绝不触碰真实配置与库。
import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import type {
  EngineMessagesPage,
  EngineModelInfo,
  EnginePermissionReply,
  EngineQuestionFrame,
  EnginePromptInput,
  EngineSessionSummary,
  EngineThinkingLevel,
  EngineUsageStats,
  EngineQueueSnapshot,
} from "../src/adapter/engine-adapter";
import type { EngineGateway } from "../src/api/engine-runtime";
import { openConfigStore } from "../src/conf/config-store";
import { openMetaDb } from "../src/db/meta";
import { createSessionRoutes } from "../src/api/routes-session";
import { createTagsRoutes } from "../src/api/routes-tags";

// ---------------------------------------------------------------- fake gateway

function summary(partial: Partial<EngineSessionSummary> & { id: string; path: string }): EngineSessionSummary {
  return {
    cwd: "/proj",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
    ...partial,
  };
}

/** 会话列表路由需要引擎会话清单；标签路由自身不触引擎（误用以异常暴露）。 */
class FakeGateway implements EngineGateway {
  registeredProjects: string[] = [];
  sessionsByProject: Record<string, EngineSessionSummary[]> = {};

  listProjectPaths(): string[] {
    return this.registeredProjects;
  }

  async sessionsList(project: string): Promise<EngineSessionSummary[]> {
    return this.sessionsByProject[project] ?? [];
  }

  async peekActiveSessionPaths(): Promise<string[] | null> {
    return null;
  }

  async createSession(
    _project: string,
    _opts: { provider?: string; modelId?: string; thinkingLevel?: EngineThinkingLevel },
  ): Promise<{ id: string; sessionPath: string; durable: boolean }> {
    throw new Error("tags routes must not create sessions");
  }
  async messages(_id: string, _cursor?: string): Promise<EngineMessagesPage> {
    throw new Error("tags routes must not read messages");
  }
  async prompt(_id: string, _input: EnginePromptInput): Promise<{ disposition: string }> {
    throw new Error("tags routes must not prompt");
  }
  async abort(): Promise<void> {}
  async queueList(): Promise<EngineQueueSnapshot> {
    throw new Error("queue routes must not be touched here");
  }
  async queueClear(): Promise<EngineQueueSnapshot> {
    throw new Error("queue routes must not be touched here");
  }
  async permissionRespond(_id: string, _requestId: string, _reply: EnginePermissionReply): Promise<void> {}
  async questionsList(_id: string): Promise<EngineQuestionFrame[]> {
    return [];
  }
  async usage(): Promise<EngineUsageStats> {
    throw new Error("tags routes must not read usage");
  }
  async modelsList(): Promise<EngineModelInfo[]> {
    throw new Error("tags routes must not list models");
  }
  async deleteSession(): Promise<{ sessionPath: string; fileExisted: boolean }> {
    throw new Error("tags routes must not delete sessions");
  }
  async exportSessionHtml(): Promise<{ html: string; row: EngineSessionSummary }> {
    throw new Error("tags routes must not export");
  }
  async forkSession(): Promise<{ id: string; sessionPath: string; durable: boolean; text: string }> {
    throw new Error("tags routes must not fork");
  }
  async restartProject(): Promise<void> {}
  async commandsList(): Promise<null> {
    return null;
  }
  async stopAll(): Promise<void> {}
}

const tmp = mkdtempSync(join(tmpdir(), "senpi-tags-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// 每个用例独立子目录（bun test 同文件共享模块态，防串数据）。
// 与生产组合根同构：session 路由 + tags 路由挂同一 app。
let seq = 0;
function setup() {
  seq += 1;
  const caseDir = mkdtempSync(join(tmp, `case-${seq}-`));
  const globalDir = join(caseDir, "global");
  const projectDir = mkdtempSync(join(caseDir, "proj-"));
  const hostRoot = join(caseDir, "host");
  const configs = openConfigStore({ globalDir, projectRoot: hostRoot });
  const meta = openMetaDb({ path: join(caseDir, "meta.db") });
  const engines = new FakeGateway();
  engines.sessionsByProject[projectDir] = [
    summary({ id: "s1", path: `${projectDir}/s1.jsonl`, cwd: projectDir }),
    summary({ id: "s2", path: `${projectDir}/s2.jsonl`, cwd: projectDir }),
  ];
  const app = new Hono();
  app.route("/", createSessionRoutes({ meta, engines }));
  app.route("/", createTagsRoutes({ meta, engines, configs }));
  const tagsPath = join(globalDir, "tags.json");
  const register = (dir: string) => meta.updateProjectMeta(dir, { lastOpenedAt: new Date().toISOString() });
  const seedMetaRow = (id: string) => meta.updateSessionMeta(id, {});
  return { app, meta, engines, globalDir, projectDir, tagsPath, register, seedMetaRow };
}

const putJson = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------- GET /api/tags

describe("GET /api/tags", () => {
  test("无数据返回两源空数组（无 project 参数时 project 源为空）", async () => {
    const { app } = setup();
    const res = await app.request("/api/tags");
    expect(res.status).toBe(200);
    const empty = await res.json();
    expect(empty.global).toEqual([]);
    expect(empty.project).toEqual([]);
    expect(empty.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  test("两源合并：global 与 project 各自返回互不污染", async () => {
    const { app, projectDir, register } = setup();
    register(projectDir);
    await putJson(app, "/api/tags", { scope: "global", tags: [{ name: "全局标签", sort: 1 }] });
    await putJson(app, "/api/tags", { scope: "project", project: projectDir, tags: [{ name: "项目标签", sort: 1 }] });
    const res = await app.request(`/api/tags?project=${encodeURIComponent(projectDir)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.global).toEqual([{ name: "全局标签", sort: 1 }]);
    expect(body.project).toEqual([{ name: "项目标签", sort: 1 }]);
    // 不带 project 参数时 project 源为空数组，global 不受影响
    const resNoProject = await app.request("/api/tags");
    expect((await resNoProject.json()).project).toEqual([]);
  });

  test("读不要求已注册：目录存在未注册时 GET 仍可读两源", async () => {
    const { app, projectDir } = setup();
    await putJson(app, "/api/tags", { scope: "global", tags: [{ name: "g", sort: 0 }] });
    const res = await app.request(`/api/tags?project=${encodeURIComponent(projectDir)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).global).toEqual([{ name: "g", sort: 0 }]);
  });
});

// ---------------------------------------------------------------- PUT /api/tags global

describe("PUT /api/tags global scope", () => {
  test("整替并按 sort 升序回显，GET 回读一致", async () => {
    const { app } = setup();
    const res = await putJson(app, "/api/tags", {
      scope: "global",
      tags: [
        { name: "后插入", sort: 2 },
        { name: "先插入", sort: 1 },
      ],
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()).tags;
    expect(echoed).toEqual([
      { name: "先插入", sort: 1 },
      { name: "后插入", sort: 2 },
    ]);
    const readBack = await app.request("/api/tags");
    expect((await readBack.json()).global).toEqual(echoed);
  });

  test("整替幂等：两次 PUT 同内容结果一致且不追加", async () => {
    const { app } = setup();
    const payload = {
      scope: "global",
      tags: [
        { name: "work", sort: 1 },
        { name: "life", sort: 2 },
      ],
    };
    const first = await putJson(app, "/api/tags", payload);
    const second = await putJson(app, "/api/tags", payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
  });

  test("重名标签 400 invalid_tags", async () => {
    const { app } = setup();
    const res = await putJson(app, "/api/tags", {
      scope: "global",
      tags: [
        { name: "dup", sort: 1 },
        { name: "dup", sort: 2 },
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_tags");
  });

  test("空 name 与非数组、sort 非数字 400", async () => {
    const { app } = setup();
    const emptyName = await putJson(app, "/api/tags", { scope: "global", tags: [{ name: "", sort: 1 }] });
    expect(emptyName.status).toBe(400);
    expect((await emptyName.json()).error.code).toBe("invalid_tags");
    const notArray = await putJson(app, "/api/tags", { scope: "global", tags: "work" });
    expect(notArray.status).toBe(400);
    const badSort = await putJson(app, "/api/tags", { scope: "global", tags: [{ name: "ok", sort: "x" }] });
    expect(badSort.status).toBe(400);
  });

  test("非法 scope 400 invalid_scope", async () => {
    const { app } = setup();
    const res = await putJson(app, "/api/tags", { scope: "workspace", tags: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_scope");
  });
});

// ---------------------------------------------------------------- PUT /api/tags project

describe("PUT /api/tags project scope", () => {
  test("缺 project 或未注册 400 project_not_found", async () => {
    const { app, projectDir } = setup();
    const missing = await putJson(app, "/api/tags", { scope: "project", tags: [] });
    expect(missing.status).toBe(400);
    const unregistered = await putJson(app, "/api/tags", {
      scope: "project",
      project: projectDir,
      tags: [{ name: "x", sort: 1 }],
    });
    expect(unregistered.status).toBe(400);
    expect((await unregistered.json()).error.code).toBe("project_not_found");
  });

  test("注册后整替成功写项目文件，且保留项目配置其它字段", async () => {
    const { app, projectDir, register } = setup();
    register(projectDir);
    // 预置项目配置：preferredModel + snippets + 旧 tags，验证 tags 整替是部分更新
    const configPath = join(projectDir, ".ul-omo-webui.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        tags: [{ name: "旧标签", sort: 1 }],
        snippets: [{ content: "保留我", sort: 1 }],
        preferredModel: "zhipu/glm-4.6",
      }),
    );
    const res = await putJson(app, "/api/tags", {
      scope: "project",
      project: projectDir,
      tags: [{ name: "新标签", sort: 3 }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).tags).toEqual([{ name: "新标签", sort: 3 }]);
    const readBack = await app.request(`/api/tags?project=${encodeURIComponent(projectDir)}`);
    const body = await readBack.json();
    expect(body.project).toEqual([{ name: "新标签", sort: 3 }]);
    // 部分更新语义：snippets/preferredModel 不被 tags 写动
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      snippets: unknown[];
      preferredModel: string;
    };
    expect(raw.snippets).toEqual([{ content: "保留我", sort: 1 }]);
    expect(raw.preferredModel).toBe("zhipu/glm-4.6");
  });
});

// ---------------------------------------------------------------- GET /api/sessions tags 注入与过滤

describe("GET /api/sessions tags 字段注入", () => {
  test("每行带 tags:[{scope,name}]（库内 scope,name 稳定序），无挂载为空数组", async () => {
    const { app, meta, projectDir } = setup();
    meta.setSessionTags("s1", [
      { scope: "project", name: "life" },
      { scope: "global", name: "work" },
    ]);
    const body = await (await app.request(`/api/sessions?project=${encodeURIComponent(projectDir)}`)).json();
    const s1 = body.sessions.find((s: { id: string }) => s.id === "s1");
    const s2 = body.sessions.find((s: { id: string }) => s.id === "s2");
    expect(s1.tags).toEqual([
      { scope: "global", name: "work" },
      { scope: "project", name: "life" },
    ]);
    expect(s2.tags).toEqual([]);
  });

  test("孤儿挂载如实返回：定义删除后关联仍在 GET 中照返", async () => {
    const { app, meta, projectDir } = setup();
    await putJson(app, "/api/tags", { scope: "global", tags: [{ name: "work", sort: 1 }] });
    meta.setSessionTags("s1", [{ scope: "global", name: "work" }]);
    // 定义整替为空（模拟前端删除该标签定义），挂载关系不动
    await putJson(app, "/api/tags", { scope: "global", tags: [{ name: "other", sort: 1 }] });
    const body = await (await app.request(`/api/sessions?project=${encodeURIComponent(projectDir)}`)).json();
    expect(body.sessions.find((s: { id: string }) => s.id === "s1").tags).toEqual([
      { scope: "global", name: "work" },
    ]);
  });
});

describe("GET /api/sessions tag 过滤（单项目）", () => {
  test("OR 矩阵：0 参数全返回；1 标签单命中；2 标签并集；无命中空", async () => {
    const { app, meta, projectDir } = setup();
    meta.setSessionTags("s1", [{ scope: "global", name: "work" }]);
    meta.setSessionTags("s2", [{ scope: "project", name: "life" }]);

    const base = `/api/sessions?project=${encodeURIComponent(projectDir)}`;
    let body = await (await app.request(base)).json();
    expect(body.sessions.map((s: { id: string }) => s.id).sort()).toEqual(["s1", "s2"]);

    body = await (await app.request(`${base}&tag=work`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s1"]);

    body = await (await app.request(`${base}&tag=work&tag=life`)).json();
    expect(body.sessions.map((s: { id: string }) => s.id).sort()).toEqual(["s1", "s2"]);

    body = await (await app.request(`${base}&tag=none`)).json();
    expect(body.sessions).toEqual([]);
  });

  test("跨 scope 命中：过滤按 name 无关 scope（挂载与定义解耦）", async () => {
    const { app, meta, projectDir } = setup();
    // s1 挂 global scope 的 "shared"；用 project scope 的同名标签过滤仍命中
    meta.setSessionTags("s1", [{ scope: "global", name: "shared" }]);
    const body = await (
      await app.request(`/api/sessions?project=${encodeURIComponent(projectDir)}&tag=shared`)
    ).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s1"]);
  });
});

describe("GET /api/sessions tag 过滤（聚合模式）", () => {
  test("跨项目命中挂载会话，未挂载项目会话被滤掉；无命中返回空", async () => {
    const { app, meta, engines, projectDir } = setup();
    const otherDir = mkdtempSync(join(tmp, "agg-other-"));
    try {
      engines.registeredProjects = [projectDir, otherDir];
      engines.sessionsByProject[otherDir] = [
        summary({ id: "o1", path: `${otherDir}/o1.jsonl`, cwd: otherDir }),
      ];
      meta.setSessionTags("s1", [{ scope: "global", name: "work" }]);

      let body = await (await app.request("/api/sessions?tag=work")).json();
      expect(body.project).toBeNull();
      expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["s1"]);

      body = await (await app.request("/api/sessions?tag=none")).json();
      expect(body.sessions).toEqual([]);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- PUT /api/sessions/:id/tags

describe("PUT /api/sessions/:id/tags", () => {
  test("任意 id 直接写入（无会话存在性校验）：meta 无行也可挂载，回显整替结果", async () => {
    const { app } = setup();
    // 新建会话在打开前没有 meta_session 行，打标必须不被 404 堵死
    const ghost = "f0000000-0000-4000-f000-00000000000f";
    const first = await putJson(app, `/api/sessions/${ghost}/tags`, {
      tags: [{ scope: "global", name: "work" }],
    });
    expect(first.status).toBe(200);
    expect((await first.json()).tags).toEqual([{ scope: "global", name: "work" }]);
    // 挂载事实独立可整替（垃圾 id 代价 = 不可见行，单用户 UI 驱动可接受）
    const replaced = await putJson(app, `/api/sessions/${ghost}/tags`, { tags: [] });
    expect(replaced.status).toBe(200);
    expect((await replaced.json()).tags).toEqual([]);
  });

  test("挂载成功回显整替结果（scope,name 稳定序），GET sessions 反映", async () => {
    const { app, seedMetaRow, projectDir } = setup();
    seedMetaRow("s1");
    const res = await putJson(app, "/api/sessions/s1/tags", {
      tags: [
        { scope: "project", name: "life" },
        { scope: "global", name: "work" },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).tags).toEqual([
      { scope: "global", name: "work" },
      { scope: "project", name: "life" },
    ]);
    const body = await (await app.request(`/api/sessions?project=${encodeURIComponent(projectDir)}`)).json();
    expect(body.sessions.find((s: { id: string }) => s.id === "s1").tags).toEqual([
      { scope: "global", name: "work" },
      { scope: "project", name: "life" },
    ]);
  });

  test("整替：删一增一后旧关联消失；同输入幂等", async () => {
    const { app, seedMetaRow } = setup();
    seedMetaRow("s1");
    await putJson(app, "/api/sessions/s1/tags", {
      tags: [
        { scope: "global", name: "a" },
        { scope: "global", name: "b" },
      ],
    });
    const replaced = await putJson(app, "/api/sessions/s1/tags", {
      tags: [
        { scope: "global", name: "b" },
        { scope: "global", name: "c" },
      ],
    });
    expect(replaced.status).toBe(200);
    const replacedBody = (await replaced.json()) as { tags: { scope: string; name: string }[] };
    expect(replacedBody).toEqual({ tags: [{ scope: "global", name: "b" }, { scope: "global", name: "c" }] });
    // 幂等：同输入重复 PUT 回显一致
    const again = await putJson(app, "/api/sessions/s1/tags", {
      tags: [
        { scope: "global", name: "b" },
        { scope: "global", name: "c" },
      ],
    });
    expect(await again.json()).toEqual(replacedBody);
  });

  test("数组内重复项去重后写：同 (scope,name) 折叠，不同 scope 同名保留", async () => {
    const { app, seedMetaRow } = setup();
    seedMetaRow("s1");
    const res = await putJson(app, "/api/sessions/s1/tags", {
      tags: [
        { scope: "global", name: "work" },
        { scope: "global", name: "work" },
        { scope: "project", name: "work" },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).tags).toEqual([
      { scope: "global", name: "work" },
      { scope: "project", name: "work" },
    ]);
  });

  test("自由挂载：定义不存在的标签可直接挂载", async () => {
    const { app, seedMetaRow } = setup();
    seedMetaRow("s1");
    const res = await putJson(app, "/api/sessions/s1/tags", { tags: [{ scope: "global", name: "未定义" }] });
    expect(res.status).toBe(200);
    expect((await res.json()).tags).toEqual([{ scope: "global", name: "未定义" }]);
  });

  test("malformed：tags 非数组、item 非法 scope、空 name 全 400", async () => {
    const { app, seedMetaRow } = setup();
    seedMetaRow("s1");
    const notArray = await putJson(app, "/api/sessions/s1/tags", { tags: "work" });
    expect(notArray.status).toBe(400);
    const badScope = await putJson(app, "/api/sessions/s1/tags", { tags: [{ scope: "team", name: "x" }] });
    expect(badScope.status).toBe(400);
    expect((await badScope.json()).error.code).toBe("invalid_tags");
    const emptyName = await putJson(app, "/api/sessions/s1/tags", { tags: [{ scope: "global", name: "" }] });
    expect(emptyName.status).toBe(400);
  });
});

// ---------------------------------------------------------------- 标签 v2：color/display（todo 20）

describe("PUT /api/tags v2 color/display", () => {
  test("合法 color/display 整替落盘，GET 回读一致且 tags.json 首写即 version 2", async () => {
    const { app, tagsPath } = setup();
    const res = await putJson(app, "/api/tags", {
      scope: "global",
      tags: [
        { name: "自定义色", sort: 1, color: "#334455", display: "text" },
        { name: "半覆盖", sort: 2, display: "grid" },
        { name: "纯自动", sort: 3 },
      ],
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()).tags;
    expect(echoed).toEqual([
      { name: "自定义色", sort: 1, color: "#334455", display: "text" },
      { name: "半覆盖", sort: 2, display: "grid" },
      { name: "纯自动", sort: 3 },
    ]);
    const readBack = await (await app.request("/api/tags")).json();
    expect(readBack.global).toEqual(echoed);
    const raw = JSON.parse(readFileSync(tagsPath, "utf8")) as { version: number };
    expect(raw.version).toBe(2);
  });

  test("非法 color 400 invalid_tags（格式错/非字符串/八位 hex）", async () => {
    const { app } = setup();
    for (const color of ["red", "334455", "#3344", "#33445599", 42, null]) {
      const res = await putJson(app, "/api/tags", {
        scope: "global",
        tags: [{ name: "x", sort: 1, color }],
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_tags");
    }
  });

  test("非法 display 400 invalid_tags（非 text/grid 值）", async () => {
    const { app } = setup();
    const res = await putJson(app, "/api/tags", {
      scope: "global",
      tags: [{ name: "x", sort: 1, display: "dot" }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_tags");
  });

  test("大写 hex 合法（#RRGGBB 大小写不敏感）", async () => {
    const { app } = setup();
    const res = await putJson(app, "/api/tags", {
      scope: "global",
      tags: [{ name: "大写", sort: 1, color: "#A1B2C3" }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).tags).toEqual([{ name: "大写", sort: 1, color: "#A1B2C3" }]);
  });

  test("v1 文件读兼容：旧文件 PUT 后升 version 2 且 v2 字段保留（读后存不丢色）", async () => {
    const { app, tagsPath } = setup();
    mkdirSync(dirname(tagsPath), { recursive: true });
    writeFileSync(
      tagsPath,
      JSON.stringify({ version: 1, tags: [{ name: "旧标签", sort: 1 }] }),
    );
    const res = await putJson(app, "/api/tags", {
      scope: "global",
      tags: [
        { name: "旧标签", sort: 1 },
        { name: "新色", sort: 2, color: "#112233", display: "grid" },
      ],
    });
    expect(res.status).toBe(200);
    const raw = JSON.parse(readFileSync(tagsPath, "utf8")) as {
      version: number;
      tags: Array<{ name: string; color?: string; display?: string }>;
    };
    expect(raw.version).toBe(2);
    expect(raw.tags).toEqual([
      { name: "旧标签", sort: 1 },
      { name: "新色", sort: 2, color: "#112233", display: "grid" },
    ]);
  });

  test("项目 scope：color/display 整替写项目文件且回读一致（read-modify-write 不剥字段）", async () => {
    const { app, projectDir, register } = setup();
    register(projectDir);
    const res = await putJson(app, "/api/tags", {
      scope: "project",
      project: projectDir,
      tags: [{ name: "项目色", sort: 1, color: "#aabbcc", display: "text" }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).tags).toEqual([{ name: "项目色", sort: 1, color: "#aabbcc", display: "text" }]);
    const readBack = await (await app.request(`/api/tags?project=${encodeURIComponent(projectDir)}`)).json();
    expect(readBack.project).toEqual([{ name: "项目色", sort: 1, color: "#aabbcc", display: "text" }]);
  });
});

// --------------------------------------------- 挂载删除审计（docs08 2026-10-23/24 批次任务 10）

describe("PUT /api/sessions/:id/tags 挂载删除审计", () => {
  test("整替移除的挂载逐条写审计行（会话 id、tag、时间、source）", async () => {
    const { app, meta } = setup();
    await putJson(app, "/api/sessions/s1/tags", {
      tags: [
        { scope: "global", name: "保留" },
        { scope: "global", name: "被删" },
        { scope: "project", name: "也删" },
      ],
    });
    const res = await putJson(app, "/api/sessions/s1/tags", {
      tags: [{ scope: "global", name: "保留" }],
      source: "tag-manage-dialog:orphan-clean",
    });
    expect(res.status).toBe(200);
    const rows = meta.listTagMountAudit("s1");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.scope}:${r.name}`).sort()).toEqual(["global:被删", "project:也删"]);
    for (const row of rows) {
      expect(row.sessionId).toBe("s1");
      expect(row.source).toBe("tag-manage-dialog:orphan-clean");
      expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);
    }
  });

  test("审计行落库持久：重开库仍可读（stale state：不因连接关闭丢失）", async () => {
    const dir = mkdtempSync(join(tmp, "audit-reopen-"));
    const dbPath = join(dir, "meta.db");
    const meta = openMetaDb({ path: dbPath });
    const app = new Hono();
    const configs = openConfigStore({ globalDir: join(dir, "global"), projectRoot: join(dir, "host") });
    app.route("/", createTagsRoutes({ meta, engines: new FakeGateway(), configs }));
    await putJson(app, "/api/sessions/s9/tags", { tags: [{ scope: "global", name: "旧" }] });
    await putJson(app, "/api/sessions/s9/tags", { tags: [], source: "tag-dropdown" });
    meta.close();
    const reopened = openMetaDb({ path: dbPath });
    const rows = reopened.listTagMountAudit("s9");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: "s9", scope: "global", name: "旧", source: "tag-dropdown" });
    reopened.close();
  });

  test("无 source 缺省 api；仅新增/无变化不产生审计行", async () => {
    const { app, meta } = setup();
    await putJson(app, "/api/sessions/s2/tags", { tags: [{ scope: "global", name: "a" }] });
    expect(meta.listTagMountAudit("s2")).toHaveLength(0);
    // 仅新增
    await putJson(app, "/api/sessions/s2/tags", { tags: [{ scope: "global", name: "a" }, { scope: "global", name: "b" }] });
    expect(meta.listTagMountAudit("s2")).toHaveLength(0);
    // 幂等同内容
    await putJson(app, "/api/sessions/s2/tags", { tags: [{ scope: "global", name: "a" }, { scope: "global", name: "b" }] });
    expect(meta.listTagMountAudit("s2")).toHaveLength(0);
    // 删除且无 source → 缺省 "api"
    await putJson(app, "/api/sessions/s2/tags", { tags: [{ scope: "global", name: "a" }] });
    const rows = meta.listTagMountAudit("s2");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "global", name: "b", source: "api" });
  });
});

// --------------------------------------------- r9 乐观锁：revision 与 baseRevision

describe("GET /api/tags revision（r9 乐观锁）", () => {
  test("revision 为 40 位 sha1 hex：跨调用稳定，任一源写入后变化", async () => {
    const { app } = setup();
    const rev1 = (await (await app.request("/api/tags")).json()).revision;
    expect(rev1).toMatch(/^[0-9a-f]{40}$/);
    const rev2 = (await (await app.request("/api/tags")).json()).revision;
    expect(rev2).toBe(rev1);
    await putJson(app, "/api/tags", { scope: "global", tags: [{ name: "g", sort: 1 }] });
    const rev3 = (await (await app.request("/api/tags")).json()).revision;
    expect(rev3).toMatch(/^[0-9a-f]{40}$/);
    expect(rev3).not.toBe(rev1);
  });

  test("两源拼接口径：global 与 project 任一源变更都改变带 project 的 revision", async () => {
    const { app, projectDir, register } = setup();
    register(projectDir);
    const revWithProject = async () =>
      (await (await app.request(`/api/tags?project=${encodeURIComponent(projectDir)}`)).json()).revision;
    const empty = await revWithProject();
    await putJson(app, "/api/tags", { scope: "global", tags: [{ name: "g", sort: 1 }] });
    const afterGlobal = await revWithProject();
    expect(afterGlobal).not.toBe(empty);
    await putJson(app, "/api/tags", {
      scope: "project",
      project: projectDir,
      tags: [{ name: "p", sort: 1 }],
    });
    expect(await revWithProject()).not.toBe(afterGlobal);
  });
});

describe("PUT /api/tags baseRevision 乐观锁（Manual-QA：app.request 真 PUT 双打）", () => {
  test("global：对端先写一版，本端携旧 revision 第二打 → 409 tag_conflict 不落盘，携新 revision 重试成功", async () => {
    const { app } = setup();
    // 第一打：写入初始集（无 baseRevision，老客户端语义），回读 rev0
    const first = await putJson(app, "/api/tags", { scope: "global", tags: [{ name: "a", sort: 1 }] });
    expect(first.status).toBe(200);
    const rev0 = (await (await app.request("/api/tags")).json()).revision;
    // 对端写入新集，revision 前移
    const peer = await putJson(app, "/api/tags", {
      scope: "global",
      tags: [
        { name: "a", sort: 1 },
        { name: "b", sort: 2 },
      ],
    });
    expect(peer.status).toBe(200);
    // 第二打携旧 revision（Manual-QA 核心：真 PUT ×2，第二个携旧 revision）
    const stale = await putJson(app, "/api/tags", {
      scope: "global",
      tags: [{ name: "c", sort: 1 }],
      baseRevision: rev0,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("tag_conflict");
    // 409 不落盘：对端写入原样保留（部分写即覆盖丢失，绝不允许）
    expect((await (await app.request("/api/tags")).json()).global.map((e: { name: string }) => e.name)).toEqual([
      "a",
      "b",
    ]);
    // 携最新 revision 重试成功落盘
    const rev1 = (await (await app.request("/api/tags")).json()).revision;
    const retry = await putJson(app, "/api/tags", {
      scope: "global",
      tags: [{ name: "c", sort: 1 }],
      baseRevision: rev1,
    });
    expect(retry.status).toBe(200);
    expect((await (await app.request("/api/tags")).json()).global.map((e: { name: string }) => e.name)).toEqual(["c"]);
  });

  test("未传 baseRevision 保持旧语义直写（老客户端兼容）；空串同义", async () => {
    const { app } = setup();
    expect((await putJson(app, "/api/tags", { scope: "global", tags: [{ name: "x", sort: 1 }] })).status).toBe(200);
    expect(
      (await putJson(app, "/api/tags", { scope: "global", tags: [{ name: "y", sort: 2 }], baseRevision: "" })).status,
    ).toBe(200);
  });

  test("project：携旧 revision 409 不写；携最新 revision 200", async () => {
    const { app, projectDir, register } = setup();
    register(projectDir);
    const qs = `?project=${encodeURIComponent(projectDir)}`;
    await putJson(app, "/api/tags", { scope: "project", project: projectDir, tags: [{ name: "p1", sort: 1 }] });
    const rev0 = (await (await app.request(`/api/tags${qs}`)).json()).revision;
    await putJson(app, "/api/tags", { scope: "project", project: projectDir, tags: [{ name: "p2", sort: 1 }] });
    const stale = await putJson(app, "/api/tags", {
      scope: "project",
      project: projectDir,
      tags: [{ name: "p3", sort: 1 }],
      baseRevision: rev0,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("tag_conflict");
    expect(
      (await (await app.request(`/api/tags${qs}`)).json()).project.map((e: { name: string }) => e.name),
    ).toEqual(["p2"]);
    const rev1 = (await (await app.request(`/api/tags${qs}`)).json()).revision;
    const ok = await putJson(app, "/api/tags", {
      scope: "project",
      project: projectDir,
      tags: [{ name: "p3", sort: 1 }],
      baseRevision: rev1,
    });
    expect(ok.status).toBe(200);
  });
});
