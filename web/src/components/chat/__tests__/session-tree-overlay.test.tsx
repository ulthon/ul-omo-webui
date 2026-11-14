// @ts-nocheck
// 会话分支树全屏层单测（session-branching todo 7）：fixture 树渲染/当前路径高亮/
// 离径半透明/不可达不导航且点击出轻提示（task-10 缺陷 E-2）/点击可达叶调
// switchLeaf（resume 意图，缺陷 E-1）并关闭/Esc 关闭/压缩事件失效
// 重拉/空树与缺 activeLeafId malformed 防护/i18n 键存在。
// task-10 缺陷 G 补充：缩进改 paddingLeft（扁平行，按钮撑满 li 命中盒）+
// 卡内非按钮点击不关浮层（卡片层 stopPropagation）回归。
// 环境说明同 branch-pager.test.tsx：@ts-nocheck + 动态 import + @happy-dom 全局注册
// + createRoot + dispatchEvent；portal 渲染进 document.body，断言查全文档。
// fetchTree/onSwitchLeaf 注入（switchLeaf deps 同款先例），免 mock api 模块；
// 压缩失效经 store compacting 位真实订阅驱动，零定时器（flaky_tests 防护），
// 异步拉取以 act(async) 微任务冲刷收口（无真实等待）。
import { describe, expect, test, vi, afterEach } from "vitest";
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

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SessionTreeOverlay } = await import("@/components/chat/session-tree-overlay");
const { useMessagesStore } = await import("@/stores/messages");
const { useUiStore } = await import("@/stores/ui");
const { t: tSnap } = await import("@/i18n/i18n");

const SID = "s-tree-1";

function node(id, parentId, overrides = {}) {
  return {
    id,
    parentId,
    role: "user",
    preview: `preview-${id}`,
    timestamp: "2026-11-14T10:00:00.000Z",
    childCount: 0,
    ...overrides,
  };
}

/** 分支 fixture：u1 → a1 → {u2, u2x}；u2 为当前叶路径（u1←a1←u2），u2x 离径；
 *  u1 有 2 子（分支点徽标）；u9 被压缩（parentId=a1，unreachable） */
function fixture() {
  return {
    sessionId: SID,
    source: "disk",
    nodes: [
      node("u1", null, { childCount: 2 }),
      node("a1", "u1", { role: "assistant", childCount: 2 }),
      node("u2", "a1"),
      node("u2x", "a1"),
      node("u9", "a1"),
    ],
    activeLeafId: "u2",
    unreachableIds: ["u9"],
  };
}

const mounted = [];

function mount(props) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(SessionTreeOverlay, props));
  });
  mounted.push({ host, root });
  return { host, root };
}

afterEach(() => {
  // 全文档查询隔离：逐测试卸载 portal 浮层，防先前用例残留在 body 中被 querySelector 误命中
  for (const { host, root } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

/** 微任务冲刷：挂载/置位后的异步 fetch 落定进 act（无真实定时器） */
async function flush() {
  await act(async () => {});
}

function clickNode(id) {
  act(() => {
    document
      .querySelector(`[data-testid="session-tree-node"][data-node-id="${id}"] button`)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function q(selector) {
  return document.querySelector(selector);
}

function setCompacting(value) {
  act(() => {
    useMessagesStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [SID]: { ...(s.bySession[SID] ?? {}), compacting: value },
      },
    }));
  });
}

describe("SessionTreeOverlay（todo 7）", () => {
  test("(1) fixture 树渲染：缩进（paddingLeft，缺陷 G 扁平行）/role 徽标/预览/时间戳/分支点子数徽标", async () => {
    const fetchTree = vi.fn(async () => fixture());
    mount({ sessionId: SID, fetchTree, onClose: () => {} });
    await flush();
    expect(q('[data-testid="session-tree-overlay"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="session-tree-node"]').length).toBe(5);
    const u1 = q('[data-node-id="u1"] button');
    // 分支点徽标（childCount>1）
    const badge = u1.querySelector('[data-testid="session-tree-branch-count"]');
    expect(badge.textContent).toBe(tSnap("chat.tree.branchCount", { n: 2 }).replace("{n}", "2"));
    // 缩进（缺陷 G：marginLeft→paddingLeft，按钮 w-full 撑满 li 命中盒）：子代缩进大于根代
    const a1 = q('[data-node-id="a1"] button');
    expect(parseInt(a1.style.paddingLeft)).toBeGreaterThan(parseInt(u1.style.paddingLeft));
    expect(parseInt(u1.style.paddingLeft)).toBe(8); // 根行与 px-2 等宽（视觉不变）
    // role 徽标与预览文本（misleading_success_output 防护：断言渲染结构非日志）
    expect(a1.textContent).toContain("assistant");
    expect(a1.textContent).toContain("preview-a1");
    expect(a1.textContent).toContain("2026");
  });

  test("(2) 当前路径高亮：路径节点带高亮类 + 「当前分支」标注", async () => {
    mount({ sessionId: SID, fetchTree: async () => fixture(), onClose: () => {} });
    await flush();
    const u2 = q('[data-node-id="u2"] button');
    expect(u2.className).toContain("bg-muted/60");
    expect(u2.textContent).toContain(tSnap("chat.tree.currentLeaf"));
  });

  test("(3) 离径分支半透明：opacity-50 且无高亮类、仍可点击", async () => {
    mount({ sessionId: SID, fetchTree: async () => fixture(), onClose: () => {} });
    await flush();
    const u2x = q('[data-node-id="u2x"] button');
    expect(u2x.className).toContain("opacity-50");
    expect(u2x.className).not.toContain("bg-muted/60");
    expect(u2x.disabled).toBe(false);
  });

  test("(4) 不可达节点不导航 + 「已压缩」提示；点击出轻提示不关浮层（task-10 缺陷 E-2：禁用态事件穿透静默吞改可反馈）", async () => {
    const onClose = vi.fn();
    const onSwitchLeaf = vi.fn();
    mount({ sessionId: SID, fetchTree: async () => fixture(), onClose, onSwitchLeaf });
    await flush();
    const u9 = q('[data-node-id="u9"] button');
    expect(u9.disabled).toBe(false); // 不再 disabled：禁用按钮点击事件穿透只关浮层零反馈
    expect(u9.getAttribute("aria-disabled")).toBe("true");
    expect(u9.textContent).toContain(tSnap("chat.tree.compacted"));
    clickNode("u9");
    expect(onSwitchLeaf).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // 每次用户发起的切换尝试必须出网或出反馈：不可达点击出轻提示
    expect(
      useUiStore.getState().toasts.some((x) => x.text === tSnap("chat.tree.compactedBlocked")),
    ).toBe(true);
  });

  test("(5) 点击可达叶：switchLeaf 带正确 entryId 调用，浮层关闭回消息流", async () => {
    const onClose = vi.fn();
    const onSwitchLeaf = vi.fn();
    const { useState } = await import("react");
    // 真实父组件契约：onClose 后浮层卸载（open 态 harness）
    function Harness(props) {
      const [open, setOpen] = useState(true);
      return open
        ? createElement(SessionTreeOverlay, {
            ...props,
            onClose: () => {
              props.onClose();
              setOpen(false);
            },
          })
        : null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ host, root });
    act(() => {
      root.render(createElement(Harness, { sessionId: SID, fetchTree: async () => fixture(), onClose, onSwitchLeaf }));
    });
    await flush();
    clickNode("u2x");
    expect(onSwitchLeaf).toHaveBeenCalledTimes(1);
    expect(onSwitchLeaf).toHaveBeenCalledWith("u2x");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="session-tree-overlay"]')).toBeNull();
  });

  test("(6) Esc 关闭浮层", async () => {
    const onClose = vi.fn();
    mount({ sessionId: SID, fetchTree: async () => fixture(), onClose });
    await flush();
    expect(q('[data-testid="session-tree-overlay"]')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("(7) 压缩事件失效重拉：store compacting 置位/结束后 fetch 再调用", async () => {
    const fetchTree = vi.fn(async () => fixture());
    mount({ sessionId: SID, fetchTree, onClose: () => {} });
    await flush();
    expect(fetchTree).toHaveBeenCalledTimes(1);
    setCompacting(true);
    expect(fetchTree).toHaveBeenCalledTimes(2);
    setCompacting(false);
    expect(fetchTree).toHaveBeenCalledTimes(3);
  });

  test("(8) i18n 键存在（快照取词非键名回退）", () => {
    const keys = [
      "chat.tree.open",
      "chat.tree.title",
      "chat.tree.close",
      "chat.tree.compacted",
      "chat.tree.compactedBlocked",
      "chat.tree.currentLeaf",
      "chat.tree.branchCount",
      "chat.tree.empty",
      "chat.tree.loadFailed",
    ];
    for (const key of keys) {
      expect(tSnap(key)).not.toBe(key);
    }
  });

  test("(9) malformed：空树渲染空态不白屏；缺 activeLeafId 无高亮无崩溃", async () => {
    mount({
      sessionId: SID,
      fetchTree: async () => ({ sessionId: SID, source: "disk", nodes: [], activeLeafId: null }),
      onClose: () => {},
    });
    await flush();
    expect(document.body.textContent).toContain(tSnap("chat.tree.empty"));
    const fetchTree = async () => ({
      sessionId: SID,
      source: "disk",
      nodes: fixture().nodes,
      activeLeafId: null,
    });
    mount({ sessionId: SID, fetchTree, onClose: () => {} });
    await flush();
    expect(q('[data-node-id="u2"] button').className).not.toContain("bg-muted/60");
  });

  // ── task-10 缺陷 E 回归（attempt-3）──

  test("(10) 缺陷 E-2 回归：编辑位空视图态下点可达叶仍出切换（带 leaf id，浮层关闭）", async () => {
    // E-1 残留态复刻：activeLeafId 落在零消息路径的算记嫁接位（消息流空、无 pager）
    const editPos = {
      sessionId: SID,
      source: "disk",
      nodes: [
        node("bk-seed", null, { role: "custom" }),
        node("graft", "bk-seed", { role: "custom" }),
        node("u1", "graft"),
        node("asst1", "u1", { role: "assistant" }),
      ],
      activeLeafId: "graft",
    };
    const onClose = vi.fn();
    const onSwitchLeaf = vi.fn();
    const { useState } = await import("react");
    function Harness(props) {
      const [open, setOpen] = useState(true);
      return open
        ? createElement(SessionTreeOverlay, {
            ...props,
            onClose: () => {
              props.onClose();
              setOpen(false);
            },
          })
        : null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ host, root });
    act(() => {
      root.render(createElement(Harness, { sessionId: SID, fetchTree: async () => editPos, onClose, onSwitchLeaf }));
    });
    await flush();
    // 当前分支标记落在嫁接位（零消息路径），点可达叶 asst1 → 切换出网路径在场
    expect(q('[data-node-id="graft"] button').textContent).toContain(tSnap("chat.tree.currentLeaf"));
    clickNode("asst1");
    expect(onSwitchLeaf).toHaveBeenCalledTimes(1);
    expect(onSwitchLeaf).toHaveBeenCalledWith("asst1");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="session-tree-overlay"]')).toBeNull();
  });

  test("(11) 缺省包装器意图（缺陷 E-1）：可达叶点击走 store switchLeaf 且带 resume（绝无 select(user) 编辑位陷阱）", async () => {
    const real = useMessagesStore.getState().switchLeaf;
    const spy = vi.fn(async () => ({ ok: true, leafId: "x" }));
    act(() => {
      useMessagesStore.setState({ switchLeaf: spy });
    });
    try {
      mount({ sessionId: SID, fetchTree: async () => fixture(), onClose: () => {} });
      await flush();
      clickNode("u2x"); // user 节点也直点：resume 语义下叶=点击条目本身，非编辑位
      expect(spy).toHaveBeenCalledTimes(1);
      const [sid, entryId, deps, intent] = spy.mock.calls[0];
      expect(sid).toBe(SID);
      expect(entryId).toBe("u2x");
      expect(typeof deps.navigate).toBe("function");
      expect(typeof deps.fetchFull).toBe("function");
      expect(intent).toBe("resume");
    } finally {
      act(() => {
        useMessagesStore.setState({ switchLeaf: real });
      });
    }
  });

  // ── task-10 缺陷 G 回归（attempt-5）──

  test("(12) 缺陷 G 回归：卡内非按钮点击（死区）不关浮层不丢动作——卡片层 stopPropagation + 扁平行命中盒", async () => {
    const onClose = vi.fn();
    const onSwitchLeaf = vi.fn();
    mount({ sessionId: SID, fetchTree: async () => fixture(), onClose, onSwitchLeaf });
    await flush();
    // 旧行为复现锚：点卡体（头部/行间隙同属卡内非按钮区）冒泡到遮罩根 onClick=onClose
    // 静默关浮层——修复后卡片层 stopPropagation，点卡体不再关闭
    act(() => {
      q('[data-testid="session-tree-body"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(q('[data-testid="session-tree-overlay"]')).not.toBeNull();
    // 扁平行结构锁（happy-dom 无命中测试，结构等价断言）：行 li 只含自身按钮一个
    // 元素子节点（无子树 ul），按钮 w-full 撑满 li 命中盒（行中心点击必落按钮）
    const li = q('[data-node-id="a1"]');
    const elementChildren = Array.from(li.children).filter((c) => c.tagName === "UL");
    expect(elementChildren.length).toBe(0); // 无嵌套子树：li 盒=按钮盒
    expect(li.querySelector("button")).not.toBeNull();
    expect(li.querySelector("button").className).toContain("w-full");
    // 点遮罩本身仍关闭（遮罩根 onClick 保留，仅卡内被拦截）
    act(() => {
      q('[data-testid="session-tree-overlay"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
