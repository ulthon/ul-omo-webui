// @ts-nocheck
// r11 todo 4：新建会话冷启动 engine_not_ready（503）一次性自动重试。
// 环境说明同 session-list-new-session-icon.test.tsx：@ts-nocheck + 被测模块动态 import +
// @happy-dom 全局注册 + api 整模块代理 mock。计时敏感场景全部走 vi.useFakeTimers +
// advanceTimersByTimeAsync(2500)，无任何真实 2.5s 等待。
// 验收：(1) 首次 engine_not_ready + 重试成功 → 会话创建、无错误 toast、api 恰 2 次；
// (2) 两次均 engine_not_ready → 错误 toast 恰一次、api 恰 2 次；
// (3) 非 engine 错误（400 invalid_path）→ 不重试，api 恰 1 次、toast 一次。
import { afterEach, describe, expect, test, vi } from "vitest";
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

// api 整模块代理 mock：每个方法名缓存同一 vi.fn（resolve 空对象），挂载期副作用全部吞掉；
// ApiError 带 status/code，使组件内 `err instanceof ApiError && err.code === "engine_not_ready"` 成立。
const apiFns = new Map();
vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (!apiFns.has(key))
          apiFns.set(
            key,
            vi.fn(() => Promise.resolve({ global: [], project: [], projects: [], sessions: [], items: [], list: [] })),
          );
        return apiFns.get(key);
      },
    },
  ),
  ApiError: class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  },
}));
vi.mock("@/lib/bootstrap", () => ({ loadProjectModels: vi.fn(() => Promise.resolve({})) }));

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { api, ApiError } = await import("@/lib/api");
const { SessionList } = await import("@/components/session-list/session-list");
const { useUiStore } = await import("@/stores/ui");
const { useSessionsStore } = await import("@/stores/sessions");

useUiStore.setState({ currentProject: "/tmp/p", projects: [{ projectPath: "/tmp/p", preferredModel: null, preferredThinkingLevel: null, lastOpenedAt: null }] });
useSessionsStore.setState({ byProject: { "/tmp/p": [] }, archived: "false", loading: false });

async function mountList() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SessionList));
  });
  const btn = container.querySelector('[data-testid="new-session-btn"]');
  expect(btn).toBeTruthy();
  const btnRef = () => container.querySelector('[data-testid="new-session-btn"]');
  return {
    btn,
    btnRef,
    async click() {
      await act(async () => {
        btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
    },
    async close() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("新建会话冷启动 engine_not_ready 一次性自动重试（r11 todo 4）", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    api.createSession.mockReset();
    api.createSession.mockImplementation(() => Promise.resolve({ global: [], project: [], projects: [], sessions: [], items: [], list: [] }));
  });

  test("(1) 首次 engine_not_ready 重试成功：会话创建、无错误 toast、api 恰 2 次", async () => {
    vi.useFakeTimers();
    const toastSpy = vi.spyOn(useUiStore.getState(), "showToast");
    api.createSession
      .mockImplementationOnce(() => Promise.reject(new ApiError(503, "engine_not_ready", "warming up")))
      .mockImplementationOnce(() =>
        Promise.resolve({ session: { id: "s1", sessionPath: "/tmp/p/s1", durable: true } }),
      );
    const h = await mountList();
    await h.click();
    expect(api.createSession).toHaveBeenCalledTimes(1);
    // B2：重试窗口内（2500ms 未到）按钮必须保持 disabled，防二次点击重复建会话
    expect((h.btnRef() as HTMLButtonElement).disabled).toBe(true);
    // 冷启动窗口：2500ms 延时后才发起第二次请求
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2499);
    });
    expect(api.createSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.createSession).toHaveBeenCalledTimes(2);
    // 无错误 toast（成功路径的“已创建”提示允许存在）
    expect(toastSpy.mock.calls.filter((c) => String(c[0]).includes("失败") || c[1] === "error")).toHaveLength(0);
    expect(useSessionsStore.getState().byProject["/tmp/p"].some((s) => s.id === "s1")).toBe(true);
    await h.close();
  });

  test("(2) 两次均 engine_not_ready：错误 toast 恰一次、api 恰 2 次、锁最终释放", async () => {
    vi.useFakeTimers();
    const toastSpy = vi.spyOn(useUiStore.getState(), "showToast");
    api.createSession
      .mockImplementationOnce(() => Promise.reject(new ApiError(503, "engine_not_ready", "warming up")))
      .mockImplementationOnce(() => Promise.reject(new ApiError(503, "engine_not_ready", "still warming up")));
    const h = await mountList();
    await h.click();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(api.createSession).toHaveBeenCalledTimes(2);
    // 不再第三次重试
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(api.createSession).toHaveBeenCalledTimes(2);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    // 重试最终失败后锁释放：按钮重新可点击
    expect((h.btnRef() as HTMLButtonElement).disabled).toBe(false);
    await h.close();
  });

  test("(3) 非 engine 错误（400 invalid_path）：不重试，api 恰 1 次、toast 一次", async () => {
    vi.useFakeTimers();
    const toastSpy = vi.spyOn(useUiStore.getState(), "showToast");
    api.createSession.mockImplementationOnce(() => Promise.reject(new ApiError(400, "invalid_path", "bad path")));
    const h = await mountList();
    await h.click();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    await h.close();
  });
});
