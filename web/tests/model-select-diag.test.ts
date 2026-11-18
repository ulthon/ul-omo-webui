// 模型选中埋点单测（2026-11-18 用户反馈「切了但没换」排查补点）：
// selectModel 是全部选中入口（输入区 chip 弹层 / Ctrl+P 收藏循环 / 顶栏下拉）的
// 共用路径——异值选中记 model-select user_change（from/to/session），同值守卫不记，
// 首次选中 from 记 unknown、无选中会话 session 记 unknown（与 thinking-level
// user_change 来源分级日志同款口径）。持久化防抖无网络副作用（byProject 空 →
// projectOfSession 派生 null → preferences.ts 静默跳过）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { diag } from "@/lib/diag";
import { selectModel } from "@/lib/model-cycle";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

let spy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  spy = vi.spyOn(diag, "info");
});

afterEach(() => {
  spy?.mockRestore();
  useUiStore.setState({ selectedModel: null });
  useSessionsStore.setState({ selectedId: null, byProject: {} });
});

describe("selectModel 选中埋点", () => {
  test("异值选中记 model-select user_change（from/to/session），选中态同步写入", () => {
    useUiStore.setState({ selectedModel: "zai-coding-cn/glm-5.3" });
    useSessionsStore.setState({ selectedId: "sess-abcd1234", byProject: {} });
    selectModel("zai-coding-cn/glm-5.3-4k");
    expect(useUiStore.getState().selectedModel).toBe("zai-coding-cn/glm-5.3-4k");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("model-select", "user_change", {
      from: "zai-coding-cn/glm-5.3",
      to: "zai-coding-cn/glm-5.3-4k",
      session: "sess-abcd1234",
    });
  });

  test("同值守卫不记（同值不重复写、不触发持久化同口径）", () => {
    useUiStore.setState({ selectedModel: "p/m1" });
    selectModel("p/m1");
    expect(spy).not.toHaveBeenCalled();
  });

  test("首次选中 from 记 unknown；无选中会话 session 记 unknown", () => {
    useSessionsStore.setState({ selectedId: null, byProject: {} });
    selectModel("p/m2");
    expect(spy).toHaveBeenCalledWith("model-select", "user_change", {
      from: "unknown",
      to: "p/m2",
      session: "unknown",
    });
  });
});
