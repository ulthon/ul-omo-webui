// sessions select 内聚单测（会话根架构 W2 任务 6）：
// select(id) 跨项目选中由 store 自身完成两件事，顺序承重：
//   1) 先应用偏好链：appliedModels[sessionId] > 目标项目偏好 preferredModel/preferredThinkingLevel > null
//   2) 后无条件补拉 loadProjectModels（撤调用点 models.length===0 惰性门；取数途中旧列表保留，
//      回包后非空选中不被 bootstrap 回退链覆盖——引擎默认不得顶掉项目偏好）
// 同项目重选幂等（纯选中，不重拉、不重置偏好）；select(null) 只清选中与 URL，不碰模型/偏好；
// 全程不写 lastOpenedAt（轻量切换不改项目排序，session-list 同契约）。
// /api/models 以挂起 Promise 模拟：断言「偏好已应用而模型未回」的窗口态即顺序证据。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ModelInfo, ModelsResponse, ProjectMeta, SessionListItem } from "@/lib/api";
import { readSessionUrl } from "@/lib/session-url";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

// happy-dom 提供 window/history（session-url.test.ts 同款注册基建；writeSessionUrl 本体
// 带无 window 守卫，注册只为断言 URL 行为）
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

const ORIGINAL_FETCH = globalThis.fetch;

function makeSession(id: string, project: string): SessionListItem {
  return {
    id,
    path: `${project}/${id}.jsonl`,
    project,
    title: id,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
  };
}

/** /api/models 挂起响应桩：resolve 前请求悬置（窗口态可断言）；记录每次调用路径 */
let pendingModels: { path: string; resolve: (payload: ModelsResponse) => void } | null = null;
let listModelsCalls: string[] = [];

function mockModelsFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/models")) {
      listModelsCalls.push(url);
      return new Promise<Response>((resolve) => {
        pendingModels = {
          path: url,
          resolve: (payload) =>
            resolve(new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })),
        };
      });
    }
    return new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

interface SeedOptions {
  /** 项目偏好子集夹具：本路径只消费 projectPath/preferredModel/preferredThinkingLevel */
  projects?: { projectPath: string; preferredModel: string | null; preferredThinkingLevel?: string | null }[];
  applied?: Record<string, string>;
  models?: ModelInfo[];
  selectedModel?: string | null;
  selectedThinkingLevel?: string | null;
}

function seedStores(opts: SeedOptions = {}): void {
  useSessionsStore.setState({
    byProject: {
      "/p-a": [makeSession("sess-a", "/p-a")],
      "/p-b": [makeSession("sess-b", "/p-b")],
    },
    appliedModels: opts.applied ?? {},
    selectedId: null,
    aliasIds: {},
  });
  useUiStore.setState({
    projects: (opts.projects ?? []) as ProjectMeta[],
    currentProject: "/p-a",
    selectedModel: opts.selectedModel ?? "prov/a-stale",
    selectedThinkingLevel: opts.selectedThinkingLevel ?? "low",
    models: opts.models ?? [],
    modelsLoaded: false,
    favoriteModels: [],
    promptPresets: {},
  });
}

beforeEach(() => {
  pendingModels = null;
  listModelsCalls = [];
});

afterEach(() => {
  // 未决桩兜底回包，避免悬置 Promise 跨测试滞留
  if (pendingModels) {
    pendingModels.resolve({ project: null, models: [] });
    pendingModels = null;
  }
  globalThis.fetch = ORIGINAL_FETCH;
  useSessionsStore.setState({ byProject: {}, appliedModels: {}, selectedId: null, aliasIds: {} });
  useUiStore.setState({
    projects: [],
    currentProject: null,
    selectedModel: null,
    selectedThinkingLevel: null,
    models: [],
    modelsLoaded: false,
    favoriteModels: [],
    promptPresets: {},
  });
});

describe("select 跨项目内聚（W2 任务 6）", () => {
  test("跨项目选中：模型回包前选中即应用目标项目偏好（偏好先行于补拉，回包不覆盖非空选中）", async () => {
    mockModelsFetch();
    seedStores({
      projects: [{ projectPath: "/p-b", preferredModel: "prov/b-model", preferredThinkingLevel: "high" }],
    });
    useSessionsStore.getState().select("sess-b");
    // select 同步返回、/api/models 仍挂起：偏好已落——顺序承重的直接证据
    const ui = useUiStore.getState();
    expect(ui.selectedModel).toBe("prov/b-model");
    expect(ui.selectedThinkingLevel).toBe("high");
    expect(ui.currentProject).toBe("/p-b");
    expect(useSessionsStore.getState().selectedId).toBe("sess-b");
    // 无条件补拉（撤 models.length===0 惰性门；初始 models 为空此处本会拉，改用
    // 非空 models 场景不成立——无条件性由下面 resolve 后 models 落库佐证）
    expect(listModelsCalls.length).toBe(1);
    expect(listModelsCalls[0]).toContain("/api/models?project=%2Fp-b");
    expect(pendingModels).not.toBeNull();
    // 回包带引擎默认 + 列表首项（均可顶掉偏好的候选）：非空选中不被回退链覆盖
    pendingModels!.resolve({
      project: "/p-b",
      models: [{ provider: "prov", id: "list-first", contextWindow: null, reasoning: false }],
      defaults: { provider: "prov", model: "engine-default", thinkingLevel: "deep" },
    });
    await expect
      .poll(() => useUiStore.getState().models.length, { interval: 10, timeout: 2000 })
      .toBe(1);
    expect(useUiStore.getState().selectedModel).toBe("prov/b-model");
    expect(useUiStore.getState().selectedThinkingLevel).toBe("high");
  });

  test("appliedModels 命中：会话生效模型压过目标项目偏好，思考档置 null 交回退链；补拉仍发生", async () => {
    mockModelsFetch();
    seedStores({
      applied: { "sess-b": "prov/applied-model" },
      projects: [{ projectPath: "/p-b", preferredModel: "prov/b-model", preferredThinkingLevel: "high" }],
    });
    useSessionsStore.getState().select("sess-b");
    expect(useUiStore.getState().selectedModel).toBe("prov/applied-model");
    // appliedModels 无思考档信息：置 null 交回退链兜底，不跨会话携带残留
    expect(useUiStore.getState().selectedThinkingLevel).toBeNull();
    expect(listModelsCalls.length).toBe(1);
    pendingModels!.resolve({
      project: "/p-b",
      models: [],
      defaults: { provider: "prov", model: "engine-default", thinkingLevel: "deep" },
    });
    await expect
      .poll(() => useUiStore.getState().modelsLoaded, { interval: 10, timeout: 2000 })
      .toBe(true);
    // 回包后生效模型仍胜出（非空选中不回退）；思考档由引擎默认补位（回退链语义）
    expect(useUiStore.getState().selectedModel).toBe("prov/applied-model");
  });

  test("同项目重选幂等：不重拉模型、不重置偏好（用户手选保留），重复选中亦然", () => {
    mockModelsFetch();
    seedStores({
      projects: [{ projectPath: "/p-a", preferredModel: "prov/a-model", preferredThinkingLevel: "high" }],
      models: [{ provider: "prov", id: "loaded", contextWindow: null, reasoning: false }],
      selectedModel: "user/picked",
      selectedThinkingLevel: "mid",
    });
    useSessionsStore.getState().select("sess-a");
    useSessionsStore.getState().select("sess-a");
    expect(listModelsCalls).toEqual([]);
    const ui = useUiStore.getState();
    expect(ui.selectedModel).toBe("user/picked");
    expect(ui.selectedThinkingLevel).toBe("mid");
    expect(ui.currentProject).toBe("/p-a");
    expect(useSessionsStore.getState().selectedId).toBe("sess-a");
  });

  test("select(null)：只清选中与 URL，模型/偏好/项目一律不碰，不触发补拉", async () => {
    mockModelsFetch();
    seedStores({
      projects: [{ projectPath: "/p-b", preferredModel: "prov/b-model", preferredThinkingLevel: "high" }],
    });
    useSessionsStore.getState().select("sess-b");
    pendingModels!.resolve({
      project: "/p-b",
      models: [{ provider: "prov", id: "loaded", contextWindow: null, reasoning: false }],
      favorites: [],
    });
    await expect
      .poll(() => useUiStore.getState().modelsLoaded, { interval: 10, timeout: 2000 })
      .toBe(true);
    const modelsBefore = useUiStore.getState().models;
    useSessionsStore.getState().select(null);
    expect(useSessionsStore.getState().selectedId).toBeNull();
    expect(readSessionUrl()).toBeNull();
    expect(useUiStore.getState().models).toBe(modelsBefore);
    expect(useUiStore.getState().selectedModel).toBe("prov/b-model");
    expect(useUiStore.getState().currentProject).toBe("/p-b");
    expect(listModelsCalls.length).toBe(1);
  });
});
