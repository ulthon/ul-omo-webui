// @ts-nocheck
// use-context-usage 叶导航落定触发单测（session-branching todo 6 ⑥，F21：contextUsage
// 基于当前叶必变，导航落定沿必须重拉）：挂载初拉一次；同会话 leafNavSeq 自增即重拉
// （可重复触发）；换会话由打开快照路径负责，他会话 seq 不带动重拉（边沿岔道）。
// 环境说明同 topbar-site-name.test.tsx：@ts-nocheck + 被测模块动态 import +
// @happy-dom 全局注册 + api 整模块代理 mock（topbar-mobile-declutter 先例）。
// 无真定时器：promise 驱动 + act 内微任务 flush。
import { describe, expect, test, vi, beforeEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

// api 整模块代理 mock（同 topbar 先例）：方法名缓存同一 vi.fn
const apiFns = new Map();
vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (!apiFns.has(key))
          apiFns.set(
            key,
            vi.fn(() =>
              Promise.resolve({
                global: [],
                project: [],
                projects: [],
                sessions: [],
                items: [],
                list: [],
                usage: { tokens: { input: 1, output: 2 }, contextUsage: { tokens: 120, contextWindow: 1000, percent: 12 } },
              }),
            ),
          );
        return apiFns.get(key);
      },
    },
  ),
  ApiError: class ApiError extends Error {},
  shortModelName: (m: string) => m,
}));
vi.mock("@/lib/bootstrap", () => ({ loadProjectModels: vi.fn(() => Promise.resolve({})) }));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useContextUsage } = await import("../use-context-usage");
const { api } = await import("@/lib/api");
const { useMessagesStore } = await import("@/stores/messages");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");

const getUsageFn = () => apiFns.get("getUsage");
const calls = () => getUsageFn().mock.calls.map((c) => c[0]);

function resetStores() {
  useMessagesStore.setState({ bySession: {}, replayRecovering: false });
  useSessionsStore.setState({ runStates: {}, appliedModels: {}, byProject: {}, selectedId: null });
  useUiStore.setState({ models: [], modelsLoaded: false, selectedModel: null });
}

function seedSlot(sessionId, leafNavSeq) {
  useMessagesStore.getState().setEntries(sessionId, [], null, null);
  useMessagesStore.setState((s) => ({
    bySession: { ...s.bySession, [sessionId]: { ...s.bySession[sessionId], leafNavSeq } },
  }));
}

async function mount(sessionId) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let statsRef = null;
  function Probe() {
    const { stats } = useContextUsage(sessionId);
    statsRef = stats;
    return createElement("div", null, String(stats?.context?.percent ?? "-"));
  }
  await act(async () => {
    root.render(createElement(Probe));
    await Promise.resolve();
  });
  return {
    host,
    statsRef: () => statsRef,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

beforeEach(() => {
  resetStores();
  void api.getUsage; // 触达代理 mock 惰性填充，再清历史
  getUsageFn().mockClear();
});

describe("use-context-usage 叶导航落定触发（todo 6 ⑥）", () => {
  test("(1) 挂载初拉一次；同会话 leafNavSeq 自增沿重拉（可重复）", async () => {
    seedSlot("s1", 0);
    const m = await mount("s1");
    expect(calls()).toEqual(["s1"]); // 打开快照初拉
    // 叶导航落定沿（switchLeaf 整替落地 leafNavSeq 0→1 同构）
    await act(async () => {
      seedSlot("s1", 1);
      await Promise.resolve();
    });
    expect(calls()).toEqual(["s1", "s1"]);
    expect(m.statsRef().context.percent).toBe(12); // 现读快照已更新
    // 二次导航再次触发（边沿可重复，非一次性闩）
    await act(async () => {
      seedSlot("s1", 2);
      await Promise.resolve();
    });
    expect(calls()).toEqual(["s1", "s1", "s1"]);
    await m.unmount();
  });

  test("(2) 换会话不因他会话 seq 带动重拉：新会话挂载仅初拉一次", async () => {
    seedSlot("s1", 3); // 旧会话已有导航史
    const m1 = await mount("s1");
    expect(calls()).toEqual(["s1"]);
    await m1.unmount();
    // 新会话（导航史 seq=5>0）挂载：初拉一次，边沿岔道不追加
    seedSlot("s2", 5);
    const m2 = await mount("s2");
    expect(calls()).toEqual(["s1", "s2"]);
    await m2.unmount();
  });

  test("(3) 非落定沿不拉：重渲染（无关 store 字段变化）不触发 getUsage", async () => {
    seedSlot("s1", 0);
    const m = await mount("s1");
    expect(calls()).toEqual(["s1"]);
    // 无关写槽（如 receiptModel 变化引发重渲染）不产生新调用
    await act(async () => {
      useMessagesStore.setState((s) => ({
        bySession: { ...s.bySession, s1: { ...s.bySession.s1, receiptModel: "zhipu/glm-5.3" } },
      }));
      await Promise.resolve();
    });
    expect(calls()).toEqual(["s1"]);
    await m.unmount();
  });
});
