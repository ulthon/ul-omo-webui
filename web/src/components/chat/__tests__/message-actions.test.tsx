// @ts-nocheck
// 消息级操作单测（session-branching todo 8）：findForkTargetEntry parentId 链上溯
// （F17 跨支串台修复）、菜单项能力位门控、三个动作体调用序列（从此此处分支不
// 自动发送 / 编辑重发 putDraft 单源回填 / 重试双路径切换）、组件 trigger smoke。
// 动作体依赖注入（message-actions-data），无网络无真定时器；环境说明同
// branch-pager.test.tsx：@ts-nocheck + 动态 import + @happy-dom 全局注册。
import { describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
vi.mock("@/i18n/i18n", () => ({ useT: () => (key: string) => key, useLocaleStore: () => "zh-CN" }));
vi.mock("@/lib/api", () => ({
  api: {
    navigate: vi.fn(),
    listMessages: vi.fn(),
    putDraft: vi.fn(),
    prompt: vi.fn(),
    forkSession: vi.fn(),
  },
}));

const { findForkTargetEntry, messageMenuItems, runBranchFromHere, runEditResend, runRetry } = await import(
  "@/components/chat/message-actions-data"
);
const { MessageActions } = await import("@/components/chat/message-actions");
const { useMessagesStore } = await import("@/stores/messages");
const { capabilities } = await import("@/lib/capabilities");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

function msg(id, parentId, role = "user", text = id) {
  return { type: "message", id, parentId, message: { role, content: [{ type: "text", text }] } };
}

describe("findForkTargetEntry（F17 修复：parentId 链上溯）", () => {
  test("(1) 多分支平铺：assistant 沿本支祖先链取 user，不串数组序更早的他支 user", () => {
    // 树：u1 → a1 → {u2 → a2}（分支一）；{u2x → a2x}（分支二）。
    // 平铺序 a2 在 a2x 之前：旧数组序向前扫描从 a2x 出发会撞到 u2（他支）。
    const entries = [
      msg("u1", null),
      msg("a1", "u1", "assistant"),
      msg("u2", "a1"),
      msg("u2x", "a1"),
      msg("a2", "u2", "assistant"),
      msg("a2x", "u2x", "assistant"),
    ];
    expect(findForkTargetEntry(entries, "a2x", "assistant")?.id).toBe("u2x");
    expect(findForkTargetEntry(entries, "a2", "assistant")?.id).toBe("u2");
  });

  test("(2) user 取自身；entryId 不在场返回 null", () => {
    const entries = [msg("u1", null), msg("a1", "u1", "assistant")];
    expect(findForkTargetEntry(entries, "u1", "user")?.id).toBe("u1");
    expect(findForkTargetEntry(entries, "ghost", "assistant")).toBeNull();
  });

  test("(3) 上溯穿过非 user 中间条目（assistant ← tool ← user）命中链上 user", () => {
    const tool = { type: "tool", id: "t1", parentId: "u1" };
    const entries = [msg("u1", null), tool, msg("a1", "t1", "assistant")];
    expect(findForkTargetEntry(entries, "a1", "assistant")?.id).toBe("u1");
  });

  test("(4) parentId 环（全 assistant）不死循环返回 null；(5) parentId 指向不在场条目（未加载窗）止步返回 null", () => {
    const cyclic = [msg("a", "b", "assistant"), msg("b", "a", "assistant")];
    expect(findForkTargetEntry(cyclic, "a", "assistant")).toBeNull();
    const partial = [msg("u0", null), msg("a1", "missing", "assistant")];
    expect(findForkTargetEntry(partial, "a1", "assistant")).toBeNull();
  });
});

describe("messageMenuItems（能力位门控）", () => {
  test("(6) treeNavigation=true + user：四项齐（复制/从此此处分支/编辑重发/重试）", () => {
    expect(messageMenuItems({ role: "user", treeNavigation: true })).toEqual([
      "copy",
      "branchFromHere",
      "editResend",
      "retry",
    ]);
  });

  test("(7) assistant 条目不渲染两项；(8) treeNavigation=false（IS-8 降级）只剩复制+重试", () => {
    expect(messageMenuItems({ role: "assistant", treeNavigation: true })).toEqual(["copy", "retry"]);
    expect(messageMenuItems({ role: "user", treeNavigation: false })).toEqual(["copy", "retry"]);
  });
});

/** fake deps：记录全部调用（误导性成功输出防线——断言调用序列本身，非日志） */
function fakeDeps(overrides = {}) {
  const calls = [];
  const d = {
    switchLeaf: vi.fn(async (sid, eid) => {
      calls.push(`switchLeaf:${sid}:${eid}`);
      return overrides.switchLeafResult ?? { ok: true, leafId: "lf1" };
    }),
    navigate: vi.fn(async (body) => {
      calls.push(`navigate:${body.intent}:${body.entryId}`);
      return { sessionId: "s1", leafId: "lf1" };
    }),
    fetchFull: vi.fn(async () => {
      calls.push("fetchFull");
      return { entries: [], leafId: "lf1", cursor: "lf1" };
    }),
    putDraft: vi.fn(async (sid, content) => {
      calls.push(`putDraft:${sid}:${content}`);
    }),
    bumpDraftRefill: vi.fn((sid) => {
      calls.push(`bump:${sid}`);
    }),
    prompt: vi.fn(async (sid, body) => {
      calls.push(`prompt:${sid}:${body.text}`);
      if (overrides.promptThrows) throw overrides.promptThrows;
    }),
    forkSession: vi.fn(async (sid, body) => {
      calls.push(`fork:${sid}:${body.entryId}:${body.position}`);
      if (overrides.forkThrows) throw overrides.forkThrows;
      return { session: { id: "fork1" }, text: "fork 原文" };
    }),
    selectSession: vi.fn((sid) => {
      calls.push(`select:${sid}`);
    }),
    refreshSessions: vi.fn(() => {
      calls.push("refresh");
    }),
    pushError: vi.fn((sid, message) => {
      calls.push(`pushError:${message}`);
    }),
    showToast: vi.fn((text) => {
      calls.push(`toast:${text}`);
    }),
    retryFailedMessage: vi.fn((err) => `RETRY_FAILED(${String(err)})`),
    texts: { branchNavigateFailed: "BNF", retryResent: "RR", retryBranchCreated: "RBC" },
  };
  return { deps: d, calls };
}

describe("runBranchFromHere（从此此处分支：不自动发送）", () => {
  test("(9) select 成功且无 editorText：仅 switchLeaf（navigate+fetchFull），无 prompt 无 putDraft", async () => {
    const { deps, calls } = fakeDeps({ switchLeafResult: { ok: true, leafId: "lf1", editorText: undefined } });
    await runBranchFromHere("s1", "u2", deps);
    expect(calls).toEqual(["switchLeaf:s1:u2"]);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.putDraft).not.toHaveBeenCalled();
  });

  test("(10) editorText 回传：putDraft 单源回填 + 信号 bump，仍不自动发送", async () => {
    const { deps, calls } = fakeDeps({ switchLeafResult: { ok: true, leafId: "lf1", editorText: "回填文本" } });
    await runBranchFromHere("s1", "u2", deps);
    expect(calls).toEqual(["switchLeaf:s1:u2", "putDraft:s1:回填文本", "bump:s1"]);
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  test("(11) switchLeaf 拒绝（409/前置门）：pushError，无回填无发送", async () => {
    const { deps, calls } = fakeDeps({ switchLeafResult: { ok: false, reason: "rejected" } });
    await runBranchFromHere("s1", "u2", deps);
    expect(calls).toEqual(["switchLeaf:s1:u2", "pushError:BNF"]);
  });
});

describe("runEditResend（编辑重发：putDraft 单一回填源）", () => {
  test("(12) editorText 缺席：本地原文 fallback 回填（putDraft+信号，无 prompt）", async () => {
    const { deps, calls } = fakeDeps({ switchLeafResult: { ok: true, leafId: "lf1", editorText: undefined } });
    await runEditResend("s1", "u9", "本地原文", deps);
    expect(calls).toEqual(["switchLeaf:s1:u9", "putDraft:s1:本地原文", "bump:s1"]);
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  test("(13) editorText 优先于本地原文（引擎回传为真相）", async () => {
    const { deps } = fakeDeps({ switchLeafResult: { ok: true, leafId: "lf1", editorText: "回填文本" } });
    await runEditResend("s1", "u2", "本地原文", deps);
    expect(deps.putDraft).toHaveBeenCalledWith("s1", "回填文本");
  });

  test("(14) switchLeaf 拒绝：状态保持（无 putDraft）+ pushError", async () => {
    const { deps, calls } = fakeDeps({ switchLeafResult: { ok: false, reason: "blocked" } });
    await runEditResend("s1", "u2", "本地原文", deps);
    expect(calls).toEqual(["switchLeaf:s1:u2", "pushError:BNF"]);
    expect(deps.putDraft).not.toHaveBeenCalled();
  });
});

describe("runRetry（重试双路径，IS-8）", () => {
  test("(15) treeNavigation=true：原会话 navigate+prompt 序列，无 fork 无切会话，toast 随新路径", async () => {
    const { deps, calls } = fakeDeps();
    await runRetry("s1", "u2", "原问题", true, deps);
    expect(calls).toEqual(["switchLeaf:s1:u2", "prompt:s1:原问题", "toast:RR"]);
    expect(deps.forkSession).not.toHaveBeenCalled();
    expect(deps.selectSession).not.toHaveBeenCalled();
  });

  test("(16) 命令文本（/ 开头）维持现状直发：不拦截不加警示门", async () => {
    const { deps, calls } = fakeDeps();
    await runRetry("s1", "u2", "/compact 现在", true, deps);
    expect(calls).toEqual(["switchLeaf:s1:u2", "prompt:s1:/compact 现在", "toast:RR"]);
  });

  test("(17) 新路径 prompt 失败：retryFailed 文案入会话错误卡", async () => {
    const { deps, calls } = fakeDeps({ promptThrows: new Error("boom") });
    await runRetry("s1", "u2", "原问题", true, deps);
    expect(calls).toEqual(["switchLeaf:s1:u2", "prompt:s1:原问题", "pushError:RETRY_FAILED(Error: boom)"]);
  });

  test("(18) 新路径 switchLeaf 拒绝：不发送，pushError 分支失败", async () => {
    const { deps, calls } = fakeDeps({ switchLeafResult: { ok: false, reason: "busy" } });
    await runRetry("s1", "u2", "原问题", true, deps);
    expect(calls).toEqual(["switchLeaf:s1:u2", "pushError:BNF"]);
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  test("(19) treeNavigation=false：保留 fork 降级路径（fork before+切会话+重发），toast 沿旧路径", async () => {
    const { deps, calls } = fakeDeps();
    await runRetry("s1", "u2", "原问题", false, deps);
    expect(calls).toEqual(["fork:s1:u2:before", "select:fork1", "refresh", "toast:RBC", "prompt:fork1:fork 原文"]);
    expect(deps.switchLeaf).not.toHaveBeenCalled();
  });

  test("(20) fork 路径失败：错误卡文案同源（apiErrorMessage 包装）", async () => {
    const { deps, calls } = fakeDeps({ forkThrows: new Error("net") });
    await runRetry("s1", "u2", "原问题", false, deps);
    expect(calls).toEqual(["fork:s1:u2:before", "pushError:RETRY_FAILED(Error: net)"]);
  });
});

describe("MessageActions 组件（trigger smoke）", () => {
  test("(21) user 条目挂载渲染触发钮（菜单内容门控由 messageMenuItems 覆盖）", () => {
    const entries = [msg("u1", null), msg("a1", "u1", "assistant"), msg("u2", "a1")];
    useMessagesStore.getState().setEntries("s1", entries, "u2", "u2", { hasMore: false, oldestId: null });
    capabilities.treeNavigation = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(MessageActions, { sessionId: "s1", entryId: "u2" }));
    });
    const btn = host.querySelector('button[aria-label="chat.messageActions.menuLabel"]');
    expect(btn).not.toBeNull();
    act(() => root.unmount());
  });
});
