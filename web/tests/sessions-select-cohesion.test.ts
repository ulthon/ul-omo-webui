// sessions select 内聚单测（会话根架构 W2 任务 6；W3 任务 12 活动项目派生口径）：
// select(id) 跨项目选中由 store 自身完成两件事，顺序承重：
//   1) 先应用偏好链：appliedModels[sessionId] > 目标项目偏好 preferredModel/preferredThinkingLevel > null
//   2) 后无条件补拉 loadProjectModels（撤调用点 models.length===0 惰性门；取数途中旧列表保留，
//      回包后非空选中不被 bootstrap 回退链覆盖——引擎默认不得顶掉项目偏好）
// 活动项目 = 选中会话派生（useActiveProject 同判据）：同项目重选幂等（纯选中，不重拉、
// 不重置偏好）；select(null) 只清选中与 URL，不碰模型/偏好；
// 全程不写项目排序字段（轻量切换不改项目排序，session-list 同契约）。
// /api/models 以挂起 Promise 模拟：断言「偏好已应用而模型未回」的窗口态即顺序证据。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ModelInfo, ModelsResponse, ProjectMeta, SessionListItem } from "@/lib/api";
import { readSessionUrl } from "@/lib/session-url";
import { projectOfSession, useSessionsStore } from "@/stores/sessions";
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
/** 其余端点（含 /api/sessions 聚合）的通用回包体：默认空列表，竞态用例可编程注入行 */
let genericPayload: Record<string, unknown> = {};

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
    return new Response(JSON.stringify(genericPayload), { status: 200, headers: { "content-type": "application/json" } });
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
    // 活动项目派生源：预选中 sess-a（∈/p-a）=「当前活动项目 /p-a」的等价布景（W3 任务 12）
    selectedId: "sess-a",
    aliasIds: {},
  });
  useUiStore.setState({
    projects: (opts.projects ?? []) as ProjectMeta[],
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
  genericPayload = { sessions: [] };
});

afterEach(() => {
  // 未决桩兜底回包，避免悬置 Promise 跨测试滞留
  if (pendingModels) {
    pendingModels.resolve({ project: null, models: [] });
    pendingModels = null;
  }
  globalThis.fetch = ORIGINAL_FETCH;
  useSessionsStore.setState({ byProject: {}, appliedModels: {}, selectedId: null, aliasIds: {}, allMode: false });
  useUiStore.setState({
    projects: [],
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
    // 活动项目随选中派生（useActiveProject 同判据）：选中 sess-b 后活动项目即 /p-b
    expect(projectOfSession(useSessionsStore.getState().byProject, useSessionsStore.getState().selectedId)).toBe("/p-b");
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

  test("appliedModels 命中：会话生效模型压过目标项目偏好，思考档取项目偏好（第四链修复：不置 null，防切模型回落引擎默认洗掉手选）；补拉仍发生", async () => {
    mockModelsFetch();
    seedStores({
      applied: { "sess-b": "prov/applied-model" },
      projects: [{ projectPath: "/p-b", preferredModel: "prov/b-model", preferredThinkingLevel: "high" }],
    });
    useSessionsStore.getState().select("sess-b");
    expect(useUiStore.getState().selectedModel).toBe("prov/applied-model");
    // 第四链（2026-11-09 日志实证）：appliedModels 无思考档，但置 null 会让切模型
    // 的 prompt 不带档→引擎回落自身默认并记 explicit，手选被洗；取项目偏好兜位。
    expect(useUiStore.getState().selectedThinkingLevel).toBe("high");
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
    expect(listModelsCalls.length).toBe(1);
  });
});

describe("URL 恢复与列表填充竞态补偿（F2 F-1）", () => {
  test("select 早于列表回包（行不在 store 早退）：聚合填充使选中可解析时补跑决策核恰一次，二次刷新不重拉", async () => {
    mockModelsFetch();
    // 恢复时序布景：bootstrap 空态启动后 URL 恢复 select 先落，而侧栏挂载触发的聚合
    // 列表请求尚未回包（byProject 空）——select 走「行不在 store」早退，决策核不跑。
    // allMode=true 与 SessionList 挂载即聚合口径一致（refreshSessions 走 setAllSessions）。
    useSessionsStore.setState({ byProject: {}, selectedId: null, aliasIds: {}, appliedModels: {}, allMode: true });
    useUiStore.setState({
      projects: [{ projectPath: "/p-x", preferredModel: "prov/x-model", preferredThinkingLevel: "high" }] as ProjectMeta[],
      selectedModel: null,
      selectedThinkingLevel: null,
      models: [],
      modelsLoaded: false,
      favoriteModels: [],
      promptPresets: {},
    });
    // 聚合回包编程注入：含恢复目标 sess-x（∈/p-x）的行
    genericPayload = { sessions: [makeSession("sess-x", "/p-x")] };
    useSessionsStore.getState().select("sess-x");
    expect(useSessionsStore.getState().selectedId).toBe("sess-x");
    // 早退窗口态：偏好未应用、模型未补拉（无补偿源时的缺陷面）
    expect(useUiStore.getState().selectedModel).toBeNull();
    expect(useUiStore.getState().selectedThinkingLevel).toBeNull();
    expect(listModelsCalls).toEqual([]);
    // 聚合回包落地：selectedId 由不可解析转为可解析 → 补跑决策核（偏好应用 + 模型补拉）
    await useSessionsStore.getState().refreshSessions();
    expect(useUiStore.getState().selectedModel).toBe("prov/x-model");
    expect(useUiStore.getState().selectedThinkingLevel).toBe("high");
    expect(listModelsCalls.length).toBe(1);
    expect(listModelsCalls[0]).toContain("/api/models?project=%2Fp-x");
    // 补偿幂等：selectedId 此前已可解析，第二次填充不再触发决策核/重拉
    await useSessionsStore.getState().refreshSessions();
    expect(listModelsCalls.length).toBe(1);
  });

  test("选中先于填充但填充不含该行：仍不可解析，不触发决策核（行到达的那次才补跑）", async () => {
    mockModelsFetch();
    useSessionsStore.setState({ byProject: {}, selectedId: null, aliasIds: {}, appliedModels: {}, allMode: true });
    useUiStore.setState({
      projects: [{ projectPath: "/p-x", preferredModel: "prov/x-model", preferredThinkingLevel: "high" }] as ProjectMeta[],
      selectedModel: null,
      selectedThinkingLevel: null,
      models: [],
      modelsLoaded: false,
      favoriteModels: [],
      promptPresets: {},
    });
    useSessionsStore.getState().select("sess-x");
    // 第一拍回包只含其它项目：恢复目标仍不可解析，决策核不得误触发
    genericPayload = { sessions: [makeSession("sess-y", "/p-y")] };
    await useSessionsStore.getState().refreshSessions();
    expect(useUiStore.getState().selectedModel).toBeNull();
    expect(listModelsCalls).toEqual([]);
    // 第二拍回包含目标行：此时才补跑
    genericPayload = { sessions: [makeSession("sess-y", "/p-y"), makeSession("sess-x", "/p-x")] };
    await useSessionsStore.getState().refreshSessions();
    expect(useUiStore.getState().selectedModel).toBe("prov/x-model");
    expect(listModelsCalls.length).toBe(1);
  });
});
