// 偏好防抖持久化单测（W2 todo 8）：模型 / 思考档两条 latest-wins PATCH 路径。
// delayMs 形参注入 1ms，真实定时器下用短 sleep 断言"连续选择只落最后一次"。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cancelPendingPreferencePersist,
  scheduleModelPreferencePersist,
  scheduleThinkingPreferencePersist,
} from "@/lib/preferences";
import { useUiStore } from "@/stores/ui";

const ORIGINAL_FETCH = globalThis.fetch;

interface PatchRecord {
  body: Record<string, unknown>;
}

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/** 记录全部 PATCH /api/projects/meta 请求体 */
function mockPatchLog(log: PatchRecord[], status = 200): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "PATCH") {
      log.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { code: "internal", message: "boom" } }), { status });
      }
    }
    return okJson({ ok: true, project: null });
  }) as typeof fetch;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  useUiStore.setState({
    currentProject: "/p1",
    projects: [{ projectPath: "/p1", preferredModel: null, lastOpenedAt: null }],
    selectedModel: null,
    selectedThinkingLevel: null,
    toast: null,
  });
});

afterEach(() => {
  cancelPendingPreferencePersist();
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("模型偏好防抖（latest-wins）", () => {
  test("连续两次选择只落最后一次", async () => {
    const log: PatchRecord[] = [];
    mockPatchLog(log);
    useUiStore.setState({ selectedModel: "p/first" });
    scheduleModelPreferencePersist(1);
    useUiStore.setState({ selectedModel: "p/second" });
    scheduleModelPreferencePersist(1);
    await sleep(30);
    expect(log).toHaveLength(1);
    expect(log[0].body).toMatchObject({ path: "/p1", preferredModel: "p/second" });
    // 本地 projects 镜像同步
    expect(useUiStore.getState().projects[0].preferredModel).toBe("p/second");
  });

  test("无项目或无选择时不发 PATCH", async () => {
    const log: PatchRecord[] = [];
    mockPatchLog(log);
    useUiStore.setState({ currentProject: null, selectedModel: "p/m" });
    scheduleModelPreferencePersist(1);
    useUiStore.setState({ currentProject: "/p1", selectedModel: null });
    scheduleModelPreferencePersist(1);
    await sleep(30);
    expect(log).toHaveLength(0);
  });

  test("PATCH 失败弹错误 toast（401 之外）", async () => {
    const log: PatchRecord[] = [];
    mockPatchLog(log, 500);
    useUiStore.setState({ selectedModel: "p/m" });
    scheduleModelPreferencePersist(1);
    await sleep(30);
    expect(log).toHaveLength(1);
    expect(useUiStore.getState().toast?.kind).toBe("error");
  });
});

describe("思考档偏好防抖（latest-wins）", () => {
  test("连续两次选择只落最后一次，字段为 preferredThinkingLevel", async () => {
    const log: PatchRecord[] = [];
    mockPatchLog(log);
    useUiStore.setState({ selectedThinkingLevel: "low" });
    scheduleThinkingPreferencePersist(1);
    useUiStore.setState({ selectedThinkingLevel: "max" });
    scheduleThinkingPreferencePersist(1);
    await sleep(30);
    expect(log).toHaveLength(1);
    expect(log[0].body).toMatchObject({ path: "/p1", preferredThinkingLevel: "max" });
    expect(useUiStore.getState().projects[0].preferredThinkingLevel).toBe("max");
  });

  test("未选档（null）时不发 PATCH", async () => {
    const log: PatchRecord[] = [];
    mockPatchLog(log);
    scheduleThinkingPreferencePersist(1);
    await sleep(30);
    expect(log).toHaveLength(0);
  });

  test("模型偏好与思考档互不干扰（各自防抖、各落各字段）", async () => {
    const log: PatchRecord[] = [];
    mockPatchLog(log);
    useUiStore.setState({ selectedModel: "p/m", selectedThinkingLevel: "high" });
    scheduleModelPreferencePersist(1);
    scheduleThinkingPreferencePersist(1);
    await sleep(30);
    expect(log).toHaveLength(2);
    const modelPatch = log.map((r) => r.body).find((b) => "preferredModel" in b);
    const thinkingPatch = log.map((r) => r.body).find((b) => "preferredThinkingLevel" in b);
    expect(modelPatch).toMatchObject({ preferredModel: "p/m" });
    expect(thinkingPatch).toMatchObject({ preferredThinkingLevel: "high" });
  });
});
