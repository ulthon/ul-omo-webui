// 空态用法提示卡单测（docs08-2026-10-22 批次任务 25）：轮换/关闭持久化/降级无痕/
// 设置开关关闭不请求/单条禁用「换一条」/i18n 双语键齐。api.listTips 全 mock（无网络）；
// localStorage 走 happy-dom；断言确定性（无 timers、无真实引擎依赖）。
// 渲染走真实组件（happy-dom + createRoot，tags-badge-grid 同款）；ui store 直注。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const listTipsMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, listTips: (...args: unknown[]) => listTipsMock(...args) } };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { TipCard } = await import("@/components/chat/tip-card");
const { TIPS_DISMISSED_KEY } = await import("@/components/chat/tip-card-data");
const { useUiStore } = await import("@/stores/ui");
const { zh } = await import("@/i18n/zh");
const { en } = await import("@/i18n/en");

const TIPS = [
  { id: "a", text: "第一条提示" },
  { id: "b", text: "第二条提示" },
];

interface TipHarness {
  host: HTMLElement;
  card: () => Element | null;
  text: () => string | null;
  click: (testid: string) => Promise<void>;
  unmount: () => Promise<void>;
}

async function mountTip(): Promise<TipHarness> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(TipCard));
  });
  await act(async () => {}); // flush 微任务（listTips mock 的 then 回调）
  return {
    host,
    card: () => host.querySelector('[data-testid="tip-card"]'),
    text: () => host.querySelector('[data-testid="tip-card-text"]')?.textContent ?? null,
    click: async (testid: string) => {
      const el = host.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement | null;
      await act(async () => {
        el?.click();
      });
      await act(async () => {});
    },
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

beforeEach(() => {
  listTipsMock.mockReset();
  window.localStorage.clear();
  useUiStore.getState().setTipsEnabled(true);
});

afterEach(() => {
  document.body.innerHTML = ""; // 各用例自行 unmount；此处兜底清场
});

describe("TipCard", () => {
  test("空态渲染单条提示，「换一条」本地轮换循环且不重发请求", async () => {
    listTipsMock.mockResolvedValue({ tips: TIPS });
    const h = await mountTip();
    expect(h.card()).toBeTruthy();
    expect(h.text()).toBe("第一条提示");
    expect(listTipsMock).toHaveBeenCalledTimes(1);
    await h.click("tip-card-next");
    expect(h.text()).toBe("第二条提示");
    await h.click("tip-card-next");
    expect(h.text()).toBe("第一条提示");
    expect(listTipsMock).toHaveBeenCalledTimes(1);
    await h.unmount();
  });

  test("「关闭」写 localStorage 且本会话不再显（重挂载仍隐藏、不再请求）", async () => {
    listTipsMock.mockResolvedValue({ tips: TIPS });
    const h = await mountTip();
    await h.click("tip-card-dismiss");
    expect(h.card()).toBeNull();
    expect(window.localStorage.getItem(TIPS_DISMISSED_KEY)).toBe("1");
    expect(listTipsMock).toHaveBeenCalledTimes(1);
    await h.unmount();

    // 重挂载：关闭记忆仍生效（本会话不再显），且不再发起请求
    const h2 = await mountTip();
    expect(h2.card()).toBeNull();
    expect(listTipsMock).toHaveBeenCalledTimes(1);
    await h2.unmount();
  });

  test("接口失败/空清单降级：无 tip 区、无报错", async () => {
    listTipsMock.mockRejectedValue(new Error("boom"));
    const h = await mountTip();
    expect(h.card()).toBeNull();
    await h.unmount();

    listTipsMock.mockResolvedValue({ tips: [] });
    const h2 = await mountTip();
    expect(h2.card()).toBeNull();
    await h2.unmount();
  });

  test("设置「显示用法提示」关闭：不渲染、不请求", async () => {
    useUiStore.getState().setTipsEnabled(false);
    listTipsMock.mockResolvedValue({ tips: TIPS });
    const h = await mountTip();
    expect(h.card()).toBeNull();
    expect(listTipsMock).not.toHaveBeenCalled();
    await h.unmount();
  });

  test("单条提示：「换一条」禁用（轮换无意义）", async () => {
    listTipsMock.mockResolvedValue({ tips: [TIPS[0]] });
    const h = await mountTip();
    const next = h.host.querySelector('[data-testid="tip-card-next"]') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await h.unmount();
  });

  test("重开设置开关（TipsSection 清除关闭记忆）后已挂载的关闭卡复原", async () => {
    listTipsMock.mockResolvedValue({ tips: TIPS });
    const h = await mountTip();
    await h.click("tip-card-dismiss");
    expect(h.card()).toBeNull();
    // TipsSection 重开路径：先清存储再翻开关（组件不重挂载，依赖 tipsEnabled 翻真重读）
    window.localStorage.removeItem(TIPS_DISMISSED_KEY);
    const { useUiStore: ui } = await import("@/stores/ui");
    await act(async () => ui.getState().setTipsEnabled(false));
    await act(async () => ui.getState().setTipsEnabled(true));
    await act(async () => {});
    expect(h.card()).toBeTruthy();
    expect(window.localStorage.getItem(TIPS_DISMISSED_KEY)).toBeNull();
    await h.unmount();
  });

  test("i18n 双语键齐：tipCard 与 topbar tips 分区 zh/en 键集一致且词条非空", () => {
    const leafKeys = (o: Record<string, unknown>, p = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === "object" && v !== null ? leafKeys(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`],
      );
    expect(leafKeys(zh.chat.tipCard as Record<string, unknown>).sort()).toEqual(
      leafKeys(en.chat.tipCard as Record<string, unknown>).sort(),
    );
    expect(leafKeys(zh.chat.tipCard as Record<string, unknown>).length).toBe(3);
    for (const key of ["tipsSaveFailed", "tipsHeading", "tipsEnabled", "tipsNote"]) {
      expect(zh.login.topbar).toHaveProperty(key);
      expect(en.login.topbar).toHaveProperty(key);
      expect(String((zh.login.topbar as Record<string, unknown>)[key]).length).toBeGreaterThan(0);
      expect(String((en.login.topbar as Record<string, unknown>)[key]).length).toBeGreaterThan(0);
    }
  });
});
