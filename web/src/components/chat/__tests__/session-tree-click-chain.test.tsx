// @ts-nocheck
// task-10 缺陷 G 集成回归（attempt-5 判别实验全链复刻）：ChatView 真实挂载（无
// hand-mocked props——浮层按 chat-view 生产方式经 treeOpen 态挂载，onSwitchLeaf 由
// chat-view 注入 pager 同款回调）→ 点可达 assistant 叶 → 断言真实 api.navigate
// 出网体（fetch 层拦截：entryId=resolveBranchLeaf 解析叶 + intent=resume +
// expectedLeafId 本地叶 CAS）且 store 落定（viewLeafId=回执叶 / navigating 拆防 /
// 浮层关闭回消息流）。
// 盲区背景（缺陷 G）：浮层单测注入 onSwitchLeaf 桩点击即绿、store 单测直调即绿，
// 集成链（点击 → chat-view 回调 → resolveBranchLeaf → store 前置门 → 真实
// request 层出网）此前零覆盖——判别实验中该链断在浮层侧（零 navigate 请求）。
// 环境（session-tree-overlay.test / user-scroll-disengage 惯例）：@happy-dom 全局
// 注册 + 被测模块动态 import（晚于全局注册）+ createRoot + act；网络统一 fetch 桩
// （api 模块真实加载，请求经真实 request() 层只拦 fetch——断言即真实出网体）；
// ResizeObserver / scrollTo 桩保 MessageList 虚拟列表挂载；微任务冲刷收口零定时器
//（flaky_tests 防护）。
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
window.matchMedia = ((query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// 虚拟列表挂载桩（user-scroll-disengage 先例：scrollTo 逐元素打补丁；这里全局兜底）
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element !== "undefined" && typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = () => {};
}
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ChatView } = await import("@/components/chat/chat-view");
const { useMessagesStore } = await import("@/stores/messages");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");

const SID = "s-g-chain";

/** 三分支 fixture（镜像 QA construct 拓扑：u1 三子分支，各分支 user→assistant 终点，
 *  分支一 assistant 下挂簿记 custom 子——复刻 asst1 有子树的行盒场景） */
function msgEntry(id: string, parentId: string | null, role: string, text: string) {
  return { id, parentId, type: "message", message: { role, content: [{ type: "text", text }] } };
}
const ENTRIES = [
  msgEntry("u1", null, "user", "请只回复一句话：分支一完成"),
  msgEntry("a1", "u1", "assistant", "分支一完成"),
  { id: "c1", parentId: "a1", type: "custom", customType: "usage" },
  msgEntry("u2", "u1", "user", "请只回复一句话：分支二完成"),
  msgEntry("a2", "u2", "assistant", "分支二完成"),
  msgEntry("u3", "u1", "user", "请只回复一句话：分支三完成"),
  msgEntry("a3", "u3", "assistant", "分支三完成"),
];
function treeNode(id: string, parentId: string | null, role: string, childCount = 0) {
  return {
    id,
    parentId,
    role,
    preview: `preview-${id}`,
    timestamp: "2026-11-14T23:59:51.000Z",
    childCount,
  };
}
const TREE = {
  sessionId: SID,
  source: "engine" as const,
  nodes: [
    treeNode("u1", null, "user", 3),
    treeNode("a1", "u1", "assistant", 1),
    treeNode("c1", "a1", "custom"),
    treeNode("u2", "u1", "user"),
    treeNode("a2", "u2", "assistant"),
    treeNode("u3", "u1", "user"),
    treeNode("a3", "u3", "assistant"),
  ],
  activeLeafId: "a3",
  unreachableIds: [],
};

const realFetch = globalThis.fetch;
/** fetch 桩：按路径路由，navigate 记录出网体（真实 request() 层之上拦截） */
function installFetch() {
  const nav: Array<{ url: string; body: any }> = [];
  globalThis.fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    const json = (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    const u = new URL(url, "http://localhost");
    const p = u.pathname;
    const scope = `/api/sessions/${SID}`;
    if (method === "POST" && p === `${scope}/navigate`) {
      const body = JSON.parse(init?.body ?? "{}");
      nav.push({ url: p, body });
      return json({ sessionId: SID, leafId: body.entryId });
    }
    if (method === "GET" && p === `${scope}/tree`) return json(TREE);
    if (method === "GET" && p === `${scope}/messages`)
      return json({ sessionId: SID, entries: ENTRIES, cursor: "a3", leafId: "a3", hasMore: false, oldestId: null });
    if (method === "GET" && p === `${scope}/model-changes`) return json({ sessionId: SID, entries: [] });
    if (method === "GET" && p === `${scope}/questions`) return json({ sessionId: SID, questions: [] });
    if (method === "GET" && p === `${scope}/queue`) return json({ sessionId: SID, steering: [], followUp: [], ordered: [] });
    if (method === "GET" && p === `${scope}/draft`) return json({ sessionId: SID, draft: null });
    if (method === "POST" && p === `${scope}/read`) return json({ ok: true, sessionId: SID, meta: null });
    if (method === "GET" && p === "/api/sessions") return json({ project: null, archived: "false", sessions: [] });
    if (method === "GET" && p === "/api/settings") return json({ settings: {} });
    if (method === "GET" && p === "/api/usage") return json({ sessionId: SID, usage: {} });
    return json({ ok: true });
  };
  return nav;
}

let mountedRoot = null;
function mountChat() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(ChatView));
  });
  mountedRoot = { host, root };
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) await act(async () => {});
}

function click(selector: string) {
  const el = document.querySelector(selector);
  expect(el, `selector missing: ${selector}`).not.toBeNull();
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("缺陷 G 集成：ChatView → 树浮层 → 可达叶点击 → navigate 出网全链", () => {
  let nav;
  beforeEach(() => {
    useMessagesStore.setState({ bySession: {} });
    useSessionsStore.setState({ selectedId: SID, runStates: {}, byProject: {} });
    useUiStore.setState({ toasts: [] });
    nav = installFetch();
  });
  afterEach(() => {
    if (mountedRoot) {
      act(() => mountedRoot.root.unmount());
      mountedRoot.host.remove();
      mountedRoot = null;
    }
    globalThis.fetch = realFetch;
  });

  test("(1) 点可达 assistant 叶（QA asst1 同型：叶下挂簿记子树）：真实出网 resume+解析叶，store 落定，浮层关闭", async () => {
    mountChat();
    await flush();
    // 会话加载落定：树入口在场且未锁（前置门开放——判别实验同态）
    const treeBtn = document.querySelector('[data-testid="session-tree-button"]');
    expect(treeBtn).not.toBeNull();
    expect(treeBtn.disabled).toBe(false);
    click('[data-testid="session-tree-button"]');
    await flush();
    expect(document.querySelector('[data-testid="session-tree-overlay"]')).not.toBeNull();
    // 缺陷 G 结构前提（happy-dom 无命中测试，结构等价断言）：行 li 只含自身按钮
    const li = document.querySelector('[data-node-id="a1"]');
    expect(Array.from(li.children).some((c) => c.tagName === "UL")).toBe(false);
    // 点可达 assistant 叶 a1（判别实验的 overlay 侧动作；子树 c1 簿记不夺走命中）
    click('[data-node-id="a1"] button');
    await flush();
    // 真实出网体：恰一次 navigate，entryId=a1（resume 语义叶=目标本身，簿记子不参与解析
    // ——resolveBranchLeaf 子树末 assistant 即 a1），intent=resume，CAS=本地叶 a3
    expect(nav.length).toBe(1);
    expect(nav[0].url).toBe(`/api/sessions/${SID}/navigate`);
    expect(nav[0].body).toEqual({ entryId: "a1", intent: "resume", expectedLeafId: "a3" });
    // store 落定（判别实验断言的另一半：store 侧确实被调用且完成全序）
    const slot = useMessagesStore.getState().bySession[SID];
    expect(slot.viewLeafId).toBe("a1");
    expect(slot.navigating).toBe(false);
    // 浮层关闭回消息流（treeOpen 态随 onClose 翻转）
    expect(document.querySelector('[data-testid="session-tree-overlay"]')).toBeNull();
  });

  test("(2) 点可达 user 分支节点：与 pager 同一解析语义（resolveBranchLeaf 落分支终点 assistant）", async () => {
    mountChat();
    await flush();
    click('[data-testid="session-tree-button"]');
    await flush();
    // u2 是 user 节点：树点击与 pager 兄弟切换共用 onSwitchSibling —— 解析出分支二
    // 终点 a2（绝无 select(u2) 编辑位陷阱，task-10 缺陷 E-1 语义）
    click('[data-node-id="u2"] button');
    await flush();
    expect(nav.length).toBe(1);
    expect(nav[0].body).toEqual({ entryId: "a2", intent: "resume", expectedLeafId: "a3" });
    expect(useMessagesStore.getState().bySession[SID].viewLeafId).toBe("a2");
  });
});
