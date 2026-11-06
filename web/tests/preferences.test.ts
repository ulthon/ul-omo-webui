// 偏好防抖持久化单测（W2 todo 8）：模型 / 思考档两条 latest-wins PATCH 路径。
// delayMs 形参注入 1ms，真实定时器下用短 sleep 断言“连续选择只落最后一次”；
// 跨防抖切换会话的写入目标语义（会话根架构 W1 任务 4）用 fake timers 推进
// 生产默认 600ms 档断言（无真实等待）。项目目标由选中会话派生，beforeEach 播种
// byProject+selectedId 使派生结果等于原意图。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  PREFERENCE_DEBOUNCE_MS,
  cancelPendingPreferencePersist,
  scheduleModelPreferencePersist,
  scheduleThinkingPreferencePersist,
} from "@/lib/preferences";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import type { SessionListItem } from "@/lib/api";

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

/** 单会话行（project/id 注入，供 projectOfSession 派生反查） */
function sessionRow(project: string, id: string): SessionListItem {
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
    messageCount: 1,
    firstMessage: "hi",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  // 派生源播种：选中会话 sess-a 属 /p1（任务 4 起项目目标由选中会话派生）
  useSessionsStore.setState({
    byProject: { "/p1": [sessionRow("/p1", "sess-a")] },
    selectedId: "sess-a",
  });
  // W1 t5 审计：项目目标已由上方 sessions 播种派生，全局字段退役不播种
  useUiStore.setState({
    projects: [{ projectPath: "/p1", preferredModel: null }],
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

  test("无选中会话（派生 null）或无选择时不发 PATCH", async () => {
    const log: PatchRecord[] = [];
    mockPatchLog(log);
    useSessionsStore.setState({ selectedId: null });
    useUiStore.setState({ selectedModel: "p/m" });
    scheduleModelPreferencePersist(1);
    useSessionsStore.setState({ selectedId: "sess-a" });
    useUiStore.setState({ selectedModel: null });
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
    expect(useUiStore.getState().toasts.at(-1)?.kind).toBe("error");
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

describe("跨防抖会话切换（会话根架构 W1 任务 4）", () => {
  test("防抖触发前切换会话：PATCH 落新选中会话派生的项目，模型取触发时值", async () => {
    vi.useFakeTimers();
    try {
      const log: PatchRecord[] = [];
      mockPatchLog(log);
      // 会话 sess-a 属 /p1、sess-b 属 /p2；初始选中 sess-a
      useSessionsStore.setState({
        byProject: {
          "/p1": [sessionRow("/p1", "sess-a")],
          "/p2": [sessionRow("/p2", "sess-b")],
        },
        selectedId: "sess-a",
      });
      useUiStore.setState({
        projects: [
          { projectPath: "/p1", preferredModel: null },
          { projectPath: "/p2", preferredModel: null },
        ],
      });
      // 会话 A 下选择模型，排定生产默认 600ms 防抖
      useUiStore.setState({ selectedModel: "p/one" });
      scheduleModelPreferencePersist();
      // 600ms 到期前：切到会话 B（项目 /p2）并再次选择——目标项目与取值都以触发时为准
      useSessionsStore.setState({ selectedId: "sess-b" });
      useUiStore.setState({ selectedModel: "p/two" });
      await vi.advanceTimersByTimeAsync(PREFERENCE_DEBOUNCE_MS);
      expect(log).toHaveLength(1);
      expect(log[0].body).toMatchObject({ path: "/p2", preferredModel: "p/two" });
      // 本地 projects 镜像同步落在新派生项目 /p2 上，/p1 不受扰
      expect(useUiStore.getState().projects).toEqual([
        { projectPath: "/p1", preferredModel: null },
        { projectPath: "/p2", preferredModel: "p/two" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
