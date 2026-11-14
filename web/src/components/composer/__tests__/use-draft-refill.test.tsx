// @ts-nocheck
// 草稿回填信号单测（session-branching todo 8）：编辑重发/从此此处分支 putDraft 落库后
// uiStore.draftRefill bump → 输入框（use-draft）按 sessionId 命中重拉服务端草稿回填。
// 单一回填源纪律（F20）落点：文本永远来自服务端草稿（getDraft）；空才回填守卫
// （canRestoreRef）在重拉链上同款生效。无真定时器（restore 链无防抖参与）。
import { describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
const getDraftMock = vi.fn(async () => ({ sessionId: "s1", draft: { content: "服务端回填", updatedAt: "2026-11-14T00:00:00Z" } }));
const putDraftMock = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/api", () => ({ api: { getDraft: (...a: unknown[]) => getDraftMock(...a), putDraft: (...a: unknown[]) => putDraftMock(...a) } }));

const { useDraft } = await import("@/components/composer/use-draft");
const { useUiStore } = await import("@/stores/ui");
const { createElement, act, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");

/** 微任务链 flush（restore 是 fire-and-forget promise；固定 sleep 禁用纪律） */
async function flushMicrotasks(times = 10) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** 探针组件：捕获 useDraft 输出（text/update）与注入的 canRestoreRef 判定 */
let probe = { text: "", update: null, clear: null };
function Probe({ sessionId, canRestore }: { sessionId: string; canRestore: boolean }) {
  const ref = useRef(() => true);
  ref.current = () => canRestore;
  const { text, update, clear } = useDraft(sessionId, ref);
  probe = { text, update, clear };
  return null;
}

function mountProbe(sessionId: string, canRestore: boolean) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(Probe, { sessionId, canRestore }));
  });
  return () => act(() => root.unmount());
}

describe("use-draft 回填信号（todo 8，putDraft 单源 + 空才回填）", () => {
  test("(1) bump 命中本会话：重拉服务端草稿并回填（canRestore=true）", async () => {
    localStorage.clear();
    getDraftMock.mockClear();
    const unmount = mountProbe("s1", true);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(probe.text).toBe("服务端回填"); // 挂载初始恢复
    expect(getDraftMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      useUiStore.getState().bumpDraftRefill("s1");
      await flushMicrotasks();
    });
    expect(getDraftMock).toHaveBeenCalledTimes(2); // 信号触发重拉（文本来自服务端）
    expect(probe.text).toBe("服务端回填");
    unmount();
  });

  test("(2) 空才回填守卫：canRestoreRef=false（非空+焦点中）时信号重拉但不覆盖输入", async () => {
    localStorage.clear();
    getDraftMock.mockClear();
    const unmount = mountProbe("s1", false);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(probe.text).toBe(""); // 初始恢复也被守卫拦下

    await act(async () => {
      useUiStore.getState().bumpDraftRefill("s1");
      await flushMicrotasks();
    });
    expect(getDraftMock).toHaveBeenCalledTimes(2); // 重拉发生（草稿留在服务端，下次打开可恢复）
    expect(probe.text).toBe(""); // 但绝不覆盖用户正在输入的内容
    unmount();
  });

  test("(3) 他会话 bump：本输入框不重拉", async () => {
    localStorage.clear();
    getDraftMock.mockClear();
    const unmount = mountProbe("s1", true);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(getDraftMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      useUiStore.getState().bumpDraftRefill("other-session");
      await flushMicrotasks();
    });
    expect(getDraftMock).toHaveBeenCalledTimes(1); // sessionId 不命中，无重拉
    unmount();
  });

  test("(4) 侧发现 2（task-10 attempt-7）：用户已输入后迟到回填不覆盖——非空+动过双门拒（canRestore=true 即失焦态也拒），无 PUT 覆盖", async () => {
    localStorage.clear();
    getDraftMock.mockClear();
    putDraftMock.mockClear();
    const unmount = mountProbe("s1", true); // canRestore=true：旧「非焦点」支路会放行的形态
    await act(async () => {
      await flushMicrotasks();
    });
    expect(probe.text).toBe("服务端回填"); // 挂载初始恢复（空门放行）

    // 用户已输入自己的草稿（QA 实录：编辑位导航 15s 冷启窗口内已打「分支四」）
    await act(async () => {
      probe.update("请只回复一句话：分支四完成");
      await flushMicrotasks();
    });
    expect(probe.text).toBe("请只回复一句话：分支四完成");

    // 迟到的 editorText 回填（refillDraft putDraft 已落库旧交本 + bump 信号）：重拉发生
    // 但用户内容不破覆盖
    getDraftMock.mockResolvedValueOnce({
      sessionId: "s1",
      draft: { content: "请只回复一句话：分支三完成", updatedAt: "2026-11-15T01:06:24Z" },
    });
    await act(async () => {
      useUiStore.getState().bumpDraftRefill("s1");
      await flushMicrotasks();
    });
    expect(getDraftMock).toHaveBeenCalledTimes(2); // 信号触发重拉（单一回填源纪律不变）
    expect(probe.text).toBe("请只回复一句话：分支四完成"); // 迟到回填不覆盖已打草稿
    expect(putDraftMock).not.toHaveBeenCalledWith("s1", "请只回复一句话：分支三完成"); // 无 PUT 覆盖

    // 对照（空门照常）：清空（发送成功同构）后回填恢复常规链
    await act(async () => {
      probe.clear();
      await flushMicrotasks();
    });
    getDraftMock.mockResolvedValueOnce({
      sessionId: "s1",
      draft: { content: "编辑重发常规回填", updatedAt: "2026-11-15T01:07:00Z" },
    });
    await act(async () => {
      useUiStore.getState().bumpDraftRefill("s1");
      await flushMicrotasks();
    });
    expect(probe.text).toBe("编辑重发常规回填"); // 空+未动过：照常回填（常规链不误伤）
    unmount();
  });
});
