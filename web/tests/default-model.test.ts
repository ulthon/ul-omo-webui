// 新会话默认模型回退链单测（docs08-r5 任务 2）：
// - 回退链四情形：有项目偏好 / 无偏好有 defaults / 无 defaults 回落首项 / 列表空
// - 思考档同链：项目偏好 > defaults.thinkingLevel > null
// - 竞态守卫：快速切换 A→B，A 的迟到响应不污染 B 的选中态（模拟乱序响应）
// store 级断言（mock fetch，不起端口；bootstrap.test.ts 同款基建，无需 DOM）。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadProjectModels, openProject } from "@/lib/bootstrap";
import { useUiStore } from "@/stores/ui";
import { useSessionsStore } from "@/stores/sessions";

const ORIGINAL_FETCH = globalThis.fetch;

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

const MODELS = [
  { provider: "zai-coding-cn", id: "glm-4.6v", contextWindow: 200000, reasoning: false },
  { provider: "zai-coding-cn", id: "glm-5.3", contextWindow: 200000, reasoning: true },
];
const DEFAULTS = { provider: "zai-coding-cn", model: "glm-5.3-4k", thinkingLevel: "max" };

function project(path: string, extra: Record<string, unknown> = {}) {
  return { projectPath: path, preferredModel: null, lastOpenedAt: null, ...extra };
}

/** openProject 全链路由 mock：PATCH meta / sessions / models（models 响应可注入） */
function mockOpenProjectRoutes(modelsPayload: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "PATCH" && url === "/api/projects/meta") return okJson({ ok: true, project: null });
    if (method === "GET" && url.startsWith("/api/sessions")) return okJson({ project: null, archived: "all", sessions: [] });
    if (method === "GET" && url.startsWith("/api/models")) return okJson(modelsPayload);
    return new Response(JSON.stringify({ error: { code: "unmocked", message: url } }), { status: 500 });
  }) as typeof fetch;
}

beforeEach(() => {
  useUiStore.setState({
    currentProject: null,
    projects: [],
    models: [],
    modelsLoaded: false,
    favoriteModels: [],
    selectedModel: null,
    selectedThinkingLevel: null,
    modelPickerOpen: false,
    toast: null,
  });
  useSessionsStore.setState({ allMode: false });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("新会话默认模型回退链（docs08-r5 任务 2）", () => {
  test("有项目偏好：偏好优先，defaults 不覆盖模型；无思考档偏好时 defaults.thinkingLevel 补位", async () => {
    useUiStore.setState({ projects: [project("/p1", { preferredModel: "zai-coding-cn/glm-4.6v" })] });
    mockOpenProjectRoutes({ project: "/p1", models: MODELS, favorites: [], defaults: DEFAULTS });
    await openProject("/p1");
    const s = useUiStore.getState();
    expect(s.selectedModel).toBe("zai-coding-cn/glm-4.6v");
    expect(s.selectedThinkingLevel).toBe("max");
  });

  test("无偏好有 defaults：选中引擎默认模型与思考档（而非等列表首项）", async () => {
    useUiStore.setState({ projects: [project("/p1")] });
    mockOpenProjectRoutes({ project: "/p1", models: MODELS, favorites: [], defaults: DEFAULTS });
    await openProject("/p1");
    const s = useUiStore.getState();
    expect(s.selectedModel).toBe("zai-coding-cn/glm-5.3-4k");
    expect(s.selectedThinkingLevel).toBe("max");
  });

  test("无 defaults：回落列表首项，思考档保持 null", async () => {
    useUiStore.setState({ projects: [project("/p1")] });
    mockOpenProjectRoutes({ project: "/p1", models: MODELS, favorites: [], defaults: null });
    await openProject("/p1");
    const s = useUiStore.getState();
    expect(s.selectedModel).toBe("zai-coding-cn/glm-4.6v");
    expect(s.selectedThinkingLevel).toBeNull();
  });

  test("列表空且无 defaults：不选（与现状一致），modelsLoaded 标记确认为空", async () => {
    useUiStore.setState({ projects: [project("/p1")] });
    mockOpenProjectRoutes({ project: "/p1", models: [], favorites: [], defaults: null });
    await openProject("/p1");
    const s = useUiStore.getState();
    expect(s.selectedModel).toBeNull();
    expect(s.selectedThinkingLevel).toBeNull();
    expect(s.modelsLoaded).toBe(true);
  });

  test("defaults 缺 thinkingLevel：模型选中引擎默认，思考档保持 null", async () => {
    useUiStore.setState({ projects: [project("/p1")] });
    mockOpenProjectRoutes({
      project: "/p1",
      models: MODELS,
      favorites: [],
      defaults: { provider: "zai-coding-cn", model: "glm-5.3-4k", thinkingLevel: null },
    });
    await openProject("/p1");
    const s = useUiStore.getState();
    expect(s.selectedModel).toBe("zai-coding-cn/glm-5.3-4k");
    expect(s.selectedThinkingLevel).toBeNull();
  });

  test("项目思考档偏好优先于 defaults.thinkingLevel（不覆盖）", async () => {
    useUiStore.setState({ projects: [project("/p1", { preferredThinkingLevel: "low" })] });
    mockOpenProjectRoutes({ project: "/p1", models: MODELS, favorites: [], defaults: DEFAULTS });
    await openProject("/p1");
    expect(useUiStore.getState().selectedThinkingLevel).toBe("low");
  });
});

describe("loadProjectModels 竞态守卫（docs08-r5 任务 2）", () => {
  test("快速切换 A→B：B 先返回、A 迟到返回，B 的选中态与模型列表不被 A 污染", async () => {
    const gates: Record<string, (res: Response) => void> = {};
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const m = url.match(/project=([^&]+)/);
      const proj = m ? decodeURIComponent(m[1]) : "";
      return new Promise<Response>((resolve) => {
        gates[proj] = resolve;
      });
    }) as typeof fetch;

    const pa = loadProjectModels("/a"); // token 1
    const pb = loadProjectModels("/b"); // token 2（更新）
    const releaseB = gates["/b"];
    const releaseA = gates["/a"];
    if (!releaseB || !releaseA) throw new Error("竞态 mock：gate 未注册");
    // B 先返回：列表首项 glm-5.3
    releaseB(
      okJson({
        project: "/b",
        models: [
          { provider: "zai-coding-cn", id: "glm-5.3", contextWindow: 200000, reasoning: true },
          { provider: "zai-coding-cn", id: "glm-4.6v", contextWindow: 200000, reasoning: false },
        ],
        favorites: [],
        defaults: null,
      }),
    );
    await pb;
    expect(useUiStore.getState().selectedModel).toBe("zai-coding-cn/glm-5.3");
    // A 迟到返回：携带会改写选中态的 defaults，必须整体丢弃
    releaseA(
      okJson({
        project: "/a",
        models: MODELS,
        favorites: [],
        defaults: { provider: "zai-coding-cn", model: "glm-5.3-4k", thinkingLevel: "low" },
      }),
    );
    await pa;
    const s = useUiStore.getState();
    expect(s.selectedModel).toBe("zai-coding-cn/glm-5.3");
    expect(s.selectedThinkingLevel).toBeNull();
    expect(s.models[0]?.id).toBe("glm-5.3");
  });
});
