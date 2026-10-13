// bootstrap 死项目守卫单测（W1 缺陷 #2）：上次项目目录已不存在（GET /api/projects 标
// missing:true）时自动恢复静默跳过——零 PATCH、零 openProject 副作用（无 sessions/models
// 请求、currentProject 不变、无 toast），仅 console.info 记录；可解析项目照常恢复
// （请求序列与既有行为一致）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bootstrap } from "@/lib/bootstrap";
import { useUiStore } from "@/stores/ui";
import { useSessionsStore } from "@/stores/sessions";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_INFO = console.info;

interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
}

/** 替换全局 fetch：记录每个请求（方法+URL+body），未命中路由返回 500 unmocked */
function mockFetch(log: RecordedRequest[], handler?: (url: string, method: string) => Response | undefined): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    log.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const res = handler?.(url, method);
    if (res) return res;
    return new Response(JSON.stringify({ error: { code: "unmocked", message: url } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

const ALIVE = "/tmp/senpi-bootstrap-alive";
const DEAD = "/tmp/senpi-bootstrap-dead";

/** 标准三读路由：projects / agents / settings（bootstrap 主流程固定拉取） */
function baseRoutes(projects: unknown[]): (url: string, method: string) => Response | undefined {
  return (url, method) => {
    if (method !== "GET") return undefined;
    if (url === "/api/projects") return okJson({ projects });
    if (url === "/api/agents") return okJson({ capabilities: { agentsList: true }, agents: [], degraded: false, reason: "" });
    if (url === "/api/settings") return okJson({ settings: {} });
    return undefined;
  };
}

// 前序测试文件的 error toast（3.2s timer 未到期即跨文件残留）会污染 store，
// 状态重置必须放在每个测试之前而非之后
beforeEach(() => {
  useUiStore.setState({
    drawerOpen: false,
    currentProject: null,
    projects: [],
    models: [],
    modelsLoaded: false,
    agentsDegraded: false,
    selectedModel: null,
    externalLinks: { gitUrl: null, filesUrl: null },
    toast: null,
  });
  useSessionsStore.setState({ allMode: false });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.info = ORIGINAL_INFO;
});

describe("bootstrap 死项目守卫", () => {
  test("上次项目 missing:true → 零 PATCH、零 openProject 副作用，console.info 记录路径", async () => {
    const log: RecordedRequest[] = [];
    const infos: unknown[][] = [];
    console.info = (...args: unknown[]) => {
      infos.push(args);
    };
    mockFetch(log, baseRoutes([
      { projectPath: DEAD, preferredAgent: null, preferredModel: null, lastOpenedAt: "2026-01-01T00:00:00.000Z", missing: true },
    ]));

    await bootstrap();

    // 只剩 bootstrap 固定三读；PATCH（openProject 的 lastOpenedAt 更新）、sessions、models 全无
    expect(log.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/projects", "GET /api/agents", "GET /api/settings"]);
    expect(log.some((r) => r.method === "PATCH")).toBe(false);
    // UI 态无副作用：当前项目未设、无 toast
    expect(useUiStore.getState().currentProject).toBeNull();
    expect(useUiStore.getState().toast).toBeNull();
    expect(useUiStore.getState().projects).toHaveLength(1);
    // 静默跳过仅留一条 console.info，含指定前缀与路径
    expect(infos).toHaveLength(1);
    expect(infos[0][0]).toBe("[senpi-webui] 上次项目路径已不存在，跳过自动打开:");
    expect(infos[0][1]).toBe(DEAD);
  });

  test("上次项目可解析 → 既有恢复行为不变：PATCH lastOpenedAt + openProject 全链路", async () => {
    const log: RecordedRequest[] = [];
    const infos: unknown[][] = [];
    console.info = (...args: unknown[]) => {
      infos.push(args);
    };
    mockFetch(log, (url, method) => {
      const base = baseRoutes([
        { projectPath: ALIVE, preferredAgent: null, preferredModel: null, lastOpenedAt: "2026-01-01T00:00:00.000Z" },
      ])(url, method);
      if (base) return base;
      if (method === "PATCH" && url === "/api/projects/meta") {
        return okJson({ ok: true, project: null });
      }
      if (method === "GET" && url.startsWith("/api/sessions?")) {
        return okJson({ project: ALIVE, archived: "false", sessions: [] });
      }
      if (method === "GET" && url.startsWith("/api/models")) {
        return okJson({ project: ALIVE, models: [] });
      }
      return undefined;
    });

    await bootstrap();

    // 请求序列与改动前自动恢复逐项一致：三读 → PATCH → sessions → models
    expect(log.map((r) => `${r.method} ${r.url.split("?")[0]}`)).toEqual([
      "GET /api/projects",
      "GET /api/agents",
      "GET /api/settings",
      "PATCH /api/projects/meta",
      "GET /api/sessions",
      "GET /api/models",
    ]);
    const patchBody = log.find((r) => r.method === "PATCH")?.body as { path?: string; lastOpenedAt?: string } | undefined;
    expect(patchBody).toMatchObject({ path: ALIVE });
    expect(typeof patchBody?.lastOpenedAt).toBe("string");
    expect(useUiStore.getState().currentProject).toBe(ALIVE);
    expect(infos).toHaveLength(0);
  });

  test("missing 的是较旧项目而非 latest → latest 正常恢复（守卫只看目标项目）", async () => {
    const log: RecordedRequest[] = [];
    mockFetch(log, (url, method) => {
      const base = baseRoutes([
        { projectPath: DEAD, preferredAgent: null, preferredModel: null, lastOpenedAt: "2026-01-01T00:00:00.000Z", missing: true },
        { projectPath: ALIVE, preferredAgent: null, preferredModel: null, lastOpenedAt: "2026-02-01T00:00:00.000Z" },
      ])(url, method);
      if (base) return base;
      if (method === "PATCH" && url === "/api/projects/meta") return okJson({ ok: true, project: null });
      if (method === "GET" && url.startsWith("/api/sessions?")) return okJson({ project: ALIVE, archived: "false", sessions: [] });
      if (method === "GET" && url.startsWith("/api/models")) return okJson({ project: ALIVE, models: [] });
      return undefined;
    });

    await bootstrap();

    // latest（ALIVE，lastOpenedAt 更新）未受 DEAD 的 missing 影响，照常恢复
    expect(log.some((r) => r.method === "PATCH")).toBe(true);
    expect(useUiStore.getState().currentProject).toBe(ALIVE);
  });
});
