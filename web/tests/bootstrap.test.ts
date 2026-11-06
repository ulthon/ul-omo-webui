// bootstrap 空态启动单测（会话根架构 W3 任务 11）：引导仅拉项目列表 + 设置 kv——
// 不自动打开任何项目（零写请求、零 sessions/models 请求），不选中会话（selectedId
// 保持 null，W3 任务 12 起活动项目由选中会话派生，无独立全局项目态）。URL ?session=
// 恢复仍由 shell 承担（session-url.test.ts 覆盖），模型列表按需于首次选中时加载
// （冷启动教训）。自动打开链路（含死项目守卫）已随本任务整体退役。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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

/** 标准两读路由：projects / settings（bootstrap 主流程固定拉取，空态收束后别无他读） */
function baseRoutes(projects: unknown[]): (url: string, method: string) => Response | undefined {
  return (url, method) => {
    if (method !== "GET") return undefined;
    if (url === "/api/projects") return okJson({ projects });
    if (url === "/api/settings") return okJson({ settings: {} });
    return undefined;
  };
}

// 前序测试文件的 error toast（3.2s timer 未到期即跨文件残留）会污染 store，
// 状态重置必须放在每个测试之前而非之后
beforeEach(() => {
  useUiStore.setState({
    drawerOpen: false,
    projects: [],
    models: [],
    modelsLoaded: false,
    selectedModel: null,
    selectedThinkingLevel: null,
    modelPickerOpen: false,
    externalLinks: { gitUrl: null, filesUrl: null },
    toast: null,
  });
  useSessionsStore.setState({ allMode: false, selectedId: null });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.info = ORIGINAL_INFO;
});

describe("bootstrap 空态启动（W3 任务 11）", () => {
  test("有可解析项目 → 仅两读（projects/settings）：零写请求、零 sessions、零 models，selectedId 保持 null", async () => {
    const log: RecordedRequest[] = [];
    mockFetch(log, baseRoutes([
      { projectPath: ALIVE, preferredModel: null },
    ]));

    await bootstrap();

    // 引导固定两读即止：自动打开链路（写请求 / sessions / models）全无
    expect(log.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/projects", "GET /api/settings"]);
    expect(log.some((r) => r.method !== "GET")).toBe(false);
    // 空态：无会话选中、无 toast；模型不预载（冷启动教训：首次选中才加载）
    expect(useSessionsStore.getState().selectedId).toBeNull();
    expect(useUiStore.getState().projects).toHaveLength(1);
    expect(useUiStore.getState().modelsLoaded).toBe(false);
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  test("上次项目 missing:true → 同样空态（自动打开与死项目守卫一并退役，无 console.info）", async () => {
    const log: RecordedRequest[] = [];
    const infos: unknown[][] = [];
    console.info = (...args: unknown[]) => {
      infos.push(args);
    };
    mockFetch(log, baseRoutes([
      { projectPath: DEAD, preferredModel: null, missing: true },
    ]));

    await bootstrap();

    expect(log.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/projects", "GET /api/settings"]);
    expect(useSessionsStore.getState().selectedId).toBeNull();
    expect(useUiStore.getState().toasts).toEqual([]);
    // 死项目守卫随自动打开退役：不再探测、不再记录
    expect(infos).toHaveLength(0);
  });

  test("无 ?session= 空态：selectedId 保持 null（不自动打开任何项目）", async () => {
    const log: RecordedRequest[] = [];
    mockFetch(log, baseRoutes([
      { projectPath: ALIVE, preferredModel: null },
    ]));

    await bootstrap();

    // 空态：会话未选中（URL ?session= 恢复是唯一自动恢复，由 shell 承担）；
    // 引导仅两读，无任何写请求与 models/sessions 拉取
    expect(log.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/projects", "GET /api/settings"]);
    expect(useSessionsStore.getState().selectedId).toBeNull();
  });
});
