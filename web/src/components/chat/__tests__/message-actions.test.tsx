// @ts-nocheck
// 消息级操作单测（session-branching todo 8 + todo 9）：findForkTargetEntry parentId 链上溯
// （F17 跨支串台修复）、菜单项能力位门控（含 assistant 编辑 editResend 分流）、动作体
// 调用序列（从此此处分支不自动发送 / 编辑重发 putDraft 单源回填 / 重试双路径 /
// assistant 编辑 edit→continue→refresh 序 + CAS 透传 / 降级 fork(at) / 编辑对话框）、
// 组件 trigger smoke。动作体依赖注入（message-actions-data），无网络无真定时器；
// 环境说明同 branch-pager.test.tsx：@ts-nocheck + 动态 import + @happy-dom 全局注册。
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

const { findForkTargetEntry, messageMenuItems, runBranchFromHere, runEditResend, runRetry, runEditReply, runCopyContinueNewSession } = await import(
  "@/components/chat/message-actions-data"
);
const { MessageActions } = await import("@/components/chat/message-actions");
const { AssistantEditDialog } = await import("@/components/chat/assistant-edit-dialog");
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

  test("(7) assistant 条目按 editResend 分流（todo 9）；(8) treeNavigation=false（IS-8 降级）只剩复制+重试", () => {
    // 能力位 true：主路径「编辑回复」（IS-6）
    expect(messageMenuItems({ role: "assistant", treeNavigation: true, editResend: true })).toEqual([
      "copy",
      "editReply",
      "retry",
    ]);
    // 能力位 false（回退）：降级「复制到新会话续跑」，入口不消失功能不砍（F22/D12）
    expect(messageMenuItems({ role: "assistant", treeNavigation: true, editResend: false })).toEqual([
      "copy",
      "copyContinue",
      "retry",
    ]);
    expect(messageMenuItems({ role: "user", treeNavigation: false })).toEqual(["copy", "retry"]);
  });
});

/** fake deps：记录全部调用（误导性成功输出防线——断言调用序列本身，非日志） */
function fakeDeps(overrides = {}) {
  const calls = [];
  let editCalls = 0;
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
    recalibrateAfterStale: vi.fn(async (sid) => {
      calls.push(`recal:${sid}`);
      if (overrides.recalibrateThrows) throw overrides.recalibrateThrows;
      // 显式区分：recalibrateLeaf=null 是有效注入值（校准失败），不能被 ?? 吞掉
      return overrides.recalibrateLeaf !== undefined ? overrides.recalibrateLeaf : "cal-leaf-1";
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
    actionFailedMessage: vi.fn((err, key) => `FAILED(${key}):${String(err)}`),
    editAssistant: vi.fn(async (sid, body) => {
      editCalls += 1;
      calls.push(`edit:${sid}:${body.entryId}:${body.text}:${body.expectedLeafId ?? "-"}`);
      if (overrides.editThrowsOnce && editCalls === 1) throw overrides.editThrowsOnce;
      if (overrides.editThrows) throw overrides.editThrows;
      return overrides.editResult ?? { outcome: "edited", leafId: "edit-leaf-1" };
    }),
    continueFromLeaf: vi.fn(async (sid, body) => {
      calls.push(`continue:${sid}:${body?.expectedLeafId ?? "-"}`);
      if (overrides.continueThrows) throw overrides.continueThrows;
      return { sessionId: sid };
    }),
    refreshAfterContinue: vi.fn(async (sid) => {
      calls.push(`refresh:${sid}`);
      return overrides.refreshResult ?? { ok: true };
    }),
    texts: {
      branchNavigateFailed: "BNF",
      retryResent: "RR",
      retryBranchCreated: "RBC",
      copyContinueCreated: "CCC",
      editRefreshFailed: "ERF",
    },
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

  test("(11) switchLeaf 引擎拒绝（rejected）：pushError，无回填无发送；前置门拒绝（blocked/busy）由 store 轻提示承担不再双推（task-10 缺陷 D）", async () => {
    const { deps, calls } = fakeDeps({ switchLeafResult: { ok: false, reason: "rejected" } });
    await runBranchFromHere("s1", "u2", deps);
    expect(calls).toEqual(["switchLeaf:s1:u2", "pushError:BNF"]);
    const gated = fakeDeps({ switchLeafResult: { ok: false, reason: "blocked" } });
    await runBranchFromHere("s1", "u2", gated.deps);
    expect(gated.calls).toEqual(["switchLeaf:s1:u2"]); // 无错误卡（toast 在真 store 内出）
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

  test("(14) switchLeaf 前置门拒绝：状态保持（无 putDraft 无错误卡——反馈由 store 轻提示承担，task-10 缺陷 D）", async () => {
    const { deps, calls } = fakeDeps({ switchLeafResult: { ok: false, reason: "blocked" } });
    await runEditResend("s1", "u2", "本地原文", deps);
    expect(calls).toEqual(["switchLeaf:s1:u2"]);
    expect(deps.putDraft).not.toHaveBeenCalled();
    expect(deps.pushError).not.toHaveBeenCalled();
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

  test("(18) 新路径 switchLeaf 前置门拒绝（busy）：不发送无错误卡（store 轻提示承担，task-10 缺陷 D）", async () => {
    const { deps, calls } = fakeDeps({ switchLeafResult: { ok: false, reason: "busy" } });
    await runRetry("s1", "u2", "原问题", true, deps);
    expect(calls).toEqual(["switchLeaf:s1:u2"]);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.pushError).not.toHaveBeenCalled();
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

describe("runEditReply（assistant 编辑续跑：edit→continue→refresh 序，IS-6 主路径 todo 9）", () => {
  test("(22) happy 全序：edit(CAS=本地叶)→continue(CAS=编辑回传叶)→refresh；无 prompt 无 putDraft", async () => {
    const { deps, calls } = fakeDeps();
    await runEditReply("s1", "a1", "编辑后的回复", "leaf-cur", deps);
    expect(calls).toEqual([
      "edit:s1:a1:编辑后的回复:leaf-cur",
      "continue:s1:edit-leaf-1",
      "refresh:s1",
    ]);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.putDraft).not.toHaveBeenCalled();
  });

  test("(23) CAS 双跳透传：edit 带本地叶指针；continue 带编辑回传叶（F13，expectedLeafId 全程透传）", async () => {
    const { deps } = fakeDeps({ editResult: { outcome: "edited", leafId: "graft-9" } });
    await runEditReply("s1", "a1", "文本", "leaf-cur", deps);
    expect(deps.editAssistant).toHaveBeenCalledWith("s1", { entryId: "a1", text: "文本", expectedLeafId: "leaf-cur" });
    expect(deps.continueFromLeaf).toHaveBeenCalledWith("s1", { expectedLeafId: "graft-9" });
  });

  test("(24) 本地叶空：edit 缺省不带 expectedLeafId（undefined 透传语义）", async () => {
    const { deps } = fakeDeps();
    await runEditReply("s1", "a1", "文本", undefined, deps);
    expect(deps.editAssistant).toHaveBeenCalledWith("s1", { entryId: "a1", text: "文本" });
  });

  test("(25) edit 失败：pushError（editFailed 文案）即止，不 continue 不刷新", async () => {
    const { deps, calls } = fakeDeps({ editThrows: new Error("stale") });
    await runEditReply("s1", "a1", "文本", "leaf-cur", deps);
    expect(calls).toEqual([
      "edit:s1:a1:文本:leaf-cur",
      "pushError:FAILED(chat.messageActions.editFailed):Error: stale",
    ]);
    expect(deps.continueFromLeaf).not.toHaveBeenCalled();
    expect(deps.refreshAfterContinue).not.toHaveBeenCalled();
  });

  test("(26) continue 失败：编辑已落地不可回滚——仍刷新让副本可见，错误卡明示续跑未启动", async () => {
    const { deps, calls } = fakeDeps({ continueThrows: new Error("409 busy") });
    await runEditReply("s1", "a1", "文本", "leaf-cur", deps);
    expect(calls).toEqual([
      "edit:s1:a1:文本:leaf-cur",
      "continue:s1:edit-leaf-1",
      "refresh:s1",
      "pushError:FAILED(chat.messageActions.editContinueFailed):Error: 409 busy",
    ]);
  });

  test("(27) 刷新失败（refresh ok:false）：续跑已启动，静态文案错误卡（editRefreshFailed）", async () => {
    const { deps, calls } = fakeDeps({ refreshResult: { ok: false } });
    await runEditReply("s1", "a1", "文本", "leaf-cur", deps);
    expect(calls).toEqual(["edit:s1:a1:文本:leaf-cur", "continue:s1:edit-leaf-1", "refresh:s1", "pushError:ERF"]);
  });

  // task-10 缺陷 C：edit 的 CAS 跳同受冷引擎挂接簿记漂移波及——409 stale_leaf
  // 校准重试恰一次（staleLeafOf 鸭子形状：status 409 + code stale_leaf + data.leafId）
  function staleErr(leafId) {
    return Object.assign(new Error(`Session leaf moved (expected leaf-cur, now ${leafId})`), {
      status: 409,
      code: "stale_leaf",
      data: { leafId },
    });
  }

  test("(28) edit 首拒 409 stale：校准（recal）后带引擎新叶重试恰一次，后续链照常", async () => {
    const { deps, calls } = fakeDeps({ editThrowsOnce: staleErr("fresh-9") });
    await runEditReply("s1", "a1", "文本", "leaf-cur", deps);
    expect(calls).toEqual([
      "edit:s1:a1:文本:leaf-cur", // 首发带本地叶（陈旧）→ 409 stale
      "recal:s1", // 全量整替校准（recalibrateAfterStale）
      "edit:s1:a1:文本:fresh-9", // 重试带引擎拒答回传的新叶（优先于校准页叶）
      "continue:s1:edit-leaf-1",
      "refresh:s1",
    ]);
    expect(deps.pushError).not.toHaveBeenCalled();
  });

  test("(29) 引擎未带 leafId（edit 变体帧）：用校准页叶重试；二次仍拒交错误卡不再重试", async () => {
    const first = Object.assign(new Error("Session leaf moved (expected leaf-cur, now fresh-7)"), {
      status: 409,
      code: "stale_leaf",
    });
    const second = Object.assign(new Error("Session leaf moved (expected fresh-7, now fresh-8)"), {
      status: 409,
      code: "stale_leaf",
      data: { leafId: "fresh-8" },
    });
    const { deps, calls } = fakeDeps({ editThrowsOnce: first, editThrows: second });
    await runEditReply("s1", "a1", "文本", "leaf-cur", deps);
    expect(calls).toEqual([
      "edit:s1:a1:文本:leaf-cur",
      "recal:s1",
      "edit:s1:a1:文本:cal-leaf-1", // data.leafId 缺席 → 校准页叶
      "pushError:FAILED(chat.messageActions.editFailed):Error: Session leaf moved (expected fresh-7, now fresh-8)",
    ]);
    expect(deps.continueFromLeaf).not.toHaveBeenCalled();
    expect(deps.recalibrateAfterStale).toHaveBeenCalledTimes(1); // 重试恰一次
  });

  test("(30) 校准取数失败（recal 抛错/null）：按原拒绝上抛交错误卡，不重试", async () => {
    const fail = fakeDeps({ editThrowsOnce: staleErr("fresh-9"), recalibrateThrows: new Error("network") });
    await runEditReply("s1", "a1", "文本", "leaf-cur", fail.deps);
    expect(fail.calls).toEqual([
      "edit:s1:a1:文本:leaf-cur",
      "recal:s1",
      "pushError:FAILED(chat.messageActions.editFailed):Error: Session leaf moved (expected leaf-cur, now fresh-9)",
    ]);
    const nullLeaf = fakeDeps({ editThrowsOnce: staleErr("fresh-9"), recalibrateLeaf: null });
    await runEditReply("s1", "a1", "文本", "leaf-cur", nullLeaf.deps);
    expect(nullLeaf.deps.editAssistant).toHaveBeenCalledTimes(1);
    expect(nullLeaf.deps.pushError).toHaveBeenCalledTimes(1);
  });
});

describe("runCopyContinueNewSession（IS-6 降级：fork at 含该回复，不自动发送）", () => {
  test("(28) fork(at) 断言：切会话+列表刷新+toast，无 prompt 无编辑无导航", async () => {
    const { deps, calls } = fakeDeps();
    await runCopyContinueNewSession("s1", "a1", deps);
    expect(calls).toEqual(["fork:s1:a1:at", "select:fork1", "refresh", "toast:CCC"]);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.editAssistant).not.toHaveBeenCalled();
  });

  test("(29) fork 失败：错误卡（copyContinueFailed 文案）", async () => {
    const { deps, calls } = fakeDeps({ forkThrows: new Error("net") });
    await runCopyContinueNewSession("s1", "a1", deps);
    expect(calls).toEqual([
      "fork:s1:a1:at",
      "pushError:FAILED(chat.messageActions.copyContinueFailed):Error: net",
    ]);
  });
});

describe("AssistantEditDialog（编辑文本采集件，CLI 编辑器同构）", () => {
  function mountDialog(props) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(AssistantEditDialog, props));
    });
    return { host, root };
  }

  test("(30) 预填原文；改后确认回传编辑文本", () => {
    const onConfirm = vi.fn();
    const { root } = mountDialog({ open: true, onOpenChange: () => {}, initialText: "AI 原回复", onConfirm });
    const ta = document.querySelector('[data-testid="assistant-edit-textarea"]');
    expect(ta).not.toBeNull();
    expect(ta.value).toBe("AI 原回复");
    // React 受控件：绕过 value tracker 用原型 setter 触发 onChange
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    act(() => {
      setter.call(ta, "编辑后的回复");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      document.querySelector('[data-testid="assistant-edit-confirm"]').click();
    });
    expect(onConfirm).toHaveBeenCalledWith("编辑后的回复");
    act(() => root.unmount());
  });

  test("(31) 流式锁定（locked）与空白文本：确认钮禁用（既有门口径下沉防线）", () => {
    const onConfirm = vi.fn();
    const locked = mountDialog({ open: true, onOpenChange: () => {}, initialText: "x", locked: true, onConfirm });
    expect(document.querySelector('[data-testid="assistant-edit-confirm"]').disabled).toBe(true);
    act(() => locked.root.unmount());

    const blank = mountDialog({ open: true, onOpenChange: () => {}, initialText: "  ", onConfirm });
    expect(document.querySelector('[data-testid="assistant-edit-confirm"]').disabled).toBe(true);
    act(() => blank.root.unmount());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("(32) 取消：onOpenChange(false)，不确认", () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    const { root } = mountDialog({ open: true, onOpenChange, initialText: "x", onConfirm });
    act(() => {
      document.querySelector('[data-testid="assistant-edit-cancel"]').click();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

describe("MessageActions 组件（todo 9 smoke）", () => {
  test("(33) assistant 条目挂载渲染触发钮（能力位 true；菜单内容门控由 messageMenuItems 覆盖）", () => {
    const entries = [msg("u1", null), msg("a1", "u1", "assistant")];
    useMessagesStore.getState().setEntries("s1", entries, "a1", "a1", { hasMore: false, oldestId: null });
    capabilities.treeNavigation = true;
    capabilities.editResend = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(MessageActions, { sessionId: "s1", entryId: "a1", switchDisabled: false }));
    });
    const btn = host.querySelector('button[aria-label="chat.messageActions.menuLabel"]');
    expect(btn).not.toBeNull();
    act(() => root.unmount());
  });
});
