// bootstrap 空态启动单测（会话根架构 W3 任务 11）：引导仅拉项目列表 + 设置 kv——
// 不自动打开最新项目（零 PATCH lastOpenedAt、零 sessions/models 请求、currentProject
// 保持 null），不选中会话（selectedId 保持 null）。URL ?session= 恢复仍由 shell 承担
// （session-url.test.ts 覆盖），模型列表按需于首次选中时加载（冷启动教训）。
// openProject/pickLatestProject/死项目守卫已随本任务整体退役。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
    currentProject: null,
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
  test("有可解析项目 → 仅两读（projects/settings）：零 PATCH、零 sessions、零 models，currentProject 保持 null", async () => {
    const log: RecordedRequest[] = [];
    mockFetch(log, baseRoutes([
      { projectPath: ALIVE, preferredModel: null, lastOpenedAt: "2026-01-01T00:00:00.000Z" },
    ]));

    await bootstrap();

    // 引导固定两读即止：自动打开链路（PATCH lastOpenedAt / sessions / models）全无
    expect(log.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/projects", "GET /api/settings"]);
    expect(log.some((r) => r.method !== "GET")).toBe(false);
    // 空态：当前项目未设、无 toast；模型不预载（冷启动教训：首次选中才加载）
    expect(useUiStore.getState().currentProject).toBeNull();
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
      { projectPath: DEAD, preferredModel: null, lastOpenedAt: "2026-01-01T00:00:00.000Z", missing: true },
    ]));

    await bootstrap();

    expect(log.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/projects", "GET /api/settings"]);
    expect(useUiStore.getState().currentProject).toBeNull();
    expect(useUiStore.getState().toasts).toEqual([]);
    // 死项目守卫随自动打开退役：不再探测、不再记录
    expect(infos).toHaveLength(0);
  });

  test("无 ?session= 空态：selectedId 保持 null 且 setCurrentProject 零调用（不自动打开任何项目）", async () => {
    const log: RecordedRequest[] = [];
    const setCurrentProject = vi.spyOn(useUiStore.getState(), "setCurrentProject");
    mockFetch(log, baseRoutes([
      { projectPath: ALIVE, preferredModel: null, lastOpenedAt: "2026-01-01T00:00:00.000Z" },
    ]));

    await bootstrap();

    // 空态双断言：项目自动打开零调用 + 会话未选中（URL ?session= 恢复是唯一自动恢复，由 shell 承担）
    expect(setCurrentProject).not.toHaveBeenCalled();
    expect(useUiStore.getState().currentProject).toBeNull();
    expect(useSessionsStore.getState().selectedId).toBeNull();
    setCurrentProject.mockRestore();
  });
});
