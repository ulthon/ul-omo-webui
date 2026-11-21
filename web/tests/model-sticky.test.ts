// 手选模型粘性单测（模型粘性批 2026-11-18）：日志实证四次 user_change 的 from 全为
// 旧模型——切换被排队剥离（api.prompt 排队铁律不带 model）后，水合对齐/切会话决策核
// 把选中值反复洗回已应用模型，用户感知「切了但没换」。粘性语义：显式手选（selectModel）
// 对该会话保持，水合与跨项目决策核不再回洗；生效（setAppliedModel 同值）或再次手选时
// 解除/覆盖；选回已生效模型时无粘性需求（清除）；异端切走（生效其他模型）不冲粘性。
import { afterEach, describe, expect, test } from "vitest";
import type { SessionListItem, WireEntry } from "@/lib/api";
import { selectModel } from "@/lib/model-cycle";
import { useMessagesStore } from "@/stores/messages";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

const PROJECT_A = "/proj/a";
const PROJECT_B = "/proj/b";

function makeSession(id: string, project: string): SessionListItem {
  return {
    id,
    path: `/store/sessions/${id}.jsonl`,
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

function modelChangeEntry(id: string, provider: string, modelId: string): WireEntry {
  return { type: "model_change", id, provider, modelId };
}

afterEach(() => {
  useUiStore.setState({ selectedModel: null, selectedThinkingLevel: null, projects: [] });
  useSessionsStore.setState({
    selectedId: null,
    byProject: {},
    runStates: {},
    runStateAt: {},
    appliedModels: {},
    modelStickies: {},
  });
  useMessagesStore.setState({ bySession: {} });
});

describe("手选模型粘性", () => {
  test("手选记粘性：水合 model_change 对齐不再洗回旧模型", () => {
    useSessionsStore.setState({ selectedId: "s1", appliedModels: { s1: "p/old" } });
    useUiStore.setState({ selectedModel: "p/old" });
    selectModel("p/new");
    expect(useSessionsStore.getState().modelStickies["s1"]).toBe("p/new");
    // 水合到达（切页回来重取）：条目仍是旧模型——粘性挡住回洗（排队剥模型期间的关键防线）
    useMessagesStore.getState().setEntries("s1", [modelChangeEntry("e1", "p", "old")], null, null);
    expect(useSessionsStore.getState().appliedModels["s1"]).toBe("p/old");
    expect(useUiStore.getState().selectedModel).toBe("p/new");
  });

  test("无粘性时水合照旧对齐（回归守卫：基线对齐语义不变）", () => {
    useSessionsStore.setState({ selectedId: "s1", appliedModels: {} });
    useUiStore.setState({ selectedModel: "p/other" });
    useMessagesStore.getState().setEntries("s1", [modelChangeEntry("e1", "p", "old")], null, null);
    expect(useUiStore.getState().selectedModel).toBe("p/old");
  });

  test("生效即解除粘性：setAppliedModel 同值清除", () => {
    useSessionsStore.setState({
      selectedId: "s1",
      appliedModels: { s1: "p/old" },
      modelStickies: { s1: "p/new" },
    });
    useUiStore.setState({ selectedModel: "p/new" });
    useSessionsStore.getState().setAppliedModel("s1", "p/new");
    expect(useSessionsStore.getState().modelStickies["s1"]).toBeUndefined();
    expect(useSessionsStore.getState().appliedModels["s1"]).toBe("p/new");
  });

  test("异端切走（生效其他模型）不冲粘性：手选意图保留", () => {
    useSessionsStore.setState({
      selectedId: "s1",
      appliedModels: { s1: "p/old" },
      modelStickies: { s1: "p/new" },
    });
    useUiStore.setState({ selectedModel: "p/new" });
    useSessionsStore.getState().setAppliedModel("s1", "p/elsewhere");
    expect(useSessionsStore.getState().modelStickies["s1"]).toBe("p/new");
  });

  test("跨项目切回：决策核粘性优先于生效模型/项目偏好", () => {
    useUiStore.setState({
      selectedModel: "p/old",
      projects: [
        { projectPath: PROJECT_A, preferredModel: "p/old" },
        { projectPath: PROJECT_B, preferredModel: "p/b" },
      ],
    });
    useSessionsStore.setState({
      selectedId: "s1",
      byProject: {
        [PROJECT_A]: [makeSession("s1", PROJECT_A)],
        [PROJECT_B]: [makeSession("s2", PROJECT_B)],
      },
      appliedModels: { s1: "p/old" },
    });
    selectModel("p/new");
    // 切到 B：无粘性无生效 → 项目偏好（既有链路不变）
    useSessionsStore.getState().select("s2");
    expect(useUiStore.getState().selectedModel).toBe("p/b");
    // 切回 A：旧逻辑回洗 applied（p/old），粘性应保持 p/new
    useSessionsStore.getState().select("s1");
    expect(useUiStore.getState().selectedModel).toBe("p/new");
  });

  test("选回已生效模型：粘性清除（无粘性需求）", () => {
    useSessionsStore.setState({
      selectedId: "s1",
      appliedModels: { s1: "p/old" },
      modelStickies: { s1: "p/new" },
    });
    useUiStore.setState({ selectedModel: "p/new" });
    selectModel("p/old");
    expect(useSessionsStore.getState().modelStickies["s1"]).toBeUndefined();
    expect(useUiStore.getState().selectedModel).toBe("p/old");
  });
});
