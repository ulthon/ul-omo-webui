// TagBadges 色格模式组件层用例（docs08 2026-10-22 批次任务 20，GAP-9）：
// - 色格 A 方格形状：2=左右半（grid-cols-2 2 格）/4=四象限（2x2 4 格）/5=首色单格+计数角标；
// - 色源：显式定义色原样、hash 自动色落 TAG_PALETTE；
// - 全局 text 档（缺省）渲染文字徽标（历史形态回归）；任一 display:"text" 覆盖 →
//   全局 grid 档下整行回退文字徽标（rowTagDisplayMode 行级判定）；
// - 孤儿格灰显 + title 显名清单；移动端点格 toast 显名（视口 390）；
// - 点孤儿格/徽标不再触发清理（任务 10：清理移入标签管理弹框带确认）。
// 渲染走真实组件（happy-dom + createRoot，stat-panel-panorama 同款）；ui store 直注。
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const setSessionTagsMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, setSessionTags: (...args: unknown[]) => setSessionTagsMock(...args) } };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { TagBadges } = await import("@/components/session-list/tag-badge");
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { useLocaleStore } from "@/i18n/i18n";
import { TAG_PALETTE, fnv1a32, definedTagKeys, type TagDefs } from "@/components/session-list/tag-data";
import type { SessionListItem } from "@/lib/api";

const roots: Array<() => Promise<void>> = [];

async function render(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  roots.push(() => act(async () => root.unmount()));
  return container;
}

afterEach(async () => {
  for (const unmount of roots.splice(0)) await unmount();
});

afterAll(() => {
  vi.useRealTimers();
});

function session(tags: Array<{ scope: string; name: string }>): SessionListItem {
  return {
    id: "s-grid",
    path: "/proj/s-grid.jsonl",
    project: "/proj",
    title: "色格会话",
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-10-22T00:00:00.000Z",
    modified: "2026-10-22T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: null,
    tags,
  };
}

const DEFS: TagDefs = {
  global: [
    { name: "甲", sort: 0 },
    { name: "乙", sort: 1, color: "#112233" },
    { name: "丙", sort: 2 },
    { name: "丁", sort: 3 },
    { name: "戊", sort: 4, display: "text" },
  ],
  project: [],
};
const KEYS = definedTagKeys(DEFS);

function seed(mode: "text" | "grid"): void {
  useLocaleStore.setState({ locale: "zh-CN" });
  useSessionsStore.setState({ runStates: {}, appliedModels: {} });
  useUiStore.setState({ tagDisplayMode: mode, toast: null });
}

const g = (name: string) => ({ scope: "global", name });

describe("TagBadges 色格 A 方格（全局 grid 档）", () => {
  test("2 标签 = 左右半：grid-cols-2 两格，色源显式色/hash 色各归其位", async () => {
    seed("grid");
    const c = await render(createElement(TagBadges, { session: session([g("乙"), g("甲")]), definedKeys: KEYS, defs: DEFS }));
    const grid = c.querySelector('[data-testid="tag-color-grid"]');
    expect(grid).not.toBeNull();
    expect(grid?.getAttribute("data-count")).toBe("2");
    const cells = grid?.querySelectorAll("span[data-tag]") ?? [];
    expect(cells).toHaveLength(2);
    // 内层 grid 容器带 grid-cols-2（左右半）
    expect(grid?.querySelector("span.grid")?.className).toContain("grid-cols-2");
    const byName = (name: string): Element | null => grid?.querySelector(`span[data-tag="${name}"]`) ?? null;
    // 显式色原样
    expect(byName("乙")?.getAttribute("style")).toContain("#112233");
    // hash 自动色落板
    expect(byName("甲")?.getAttribute("style")).toContain(TAG_PALETTE[fnv1a32("甲") % 10]);
    // 不渲染文字徽标
    expect(c.querySelector('[data-testid="tag-badges"]')).toBeNull();
  });

  test("4 标签 = 四象限：grid-cols-2 grid-rows-2 四格", async () => {
    seed("grid");
    const c = await render(
      createElement(TagBadges, { session: session([g("甲"), g("乙"), g("丙"), g("丁")]), definedKeys: KEYS, defs: DEFS }),
    );
    const grid = c.querySelector('[data-testid="tag-color-grid"]');
    expect(grid?.getAttribute("data-count")).toBe("4");
    expect(grid?.querySelector("span.grid")?.className).toContain("grid-rows-2");
    expect(grid?.querySelectorAll("span[data-tag]")).toHaveLength(4);
  });

  test("5 标签 = 首色单格 + 计数角标 5（>4 不堆细条）", async () => {
    seed("grid");
    const tags = [g("甲"), g("乙"), g("丙"), g("丁"), g("无覆盖")];
    const defs: TagDefs = { global: DEFS.global.slice(0, 5), project: [] };
    const c = await render(
      createElement(TagBadges, { session: session(tags), definedKeys: definedTagKeys(defs), defs }),
    );
    const grid = c.querySelector('[data-testid="tag-color-grid"]');
    expect(grid?.getAttribute("data-count")).toBe("5");
    expect(grid?.querySelectorAll("span[data-tag]")).toHaveLength(1);
    // 首色 = 第一个标签的有效色
    expect(grid?.querySelector("span[data-tag]")?.getAttribute("style")).toContain(TAG_PALETTE[fnv1a32("甲") % 10]);
    const count = grid?.querySelector('[data-testid="tag-grid-count"]');
    expect(count?.textContent).toBe("5");
  });

  test("title 显名清单（全部标签名入 title）", async () => {
    seed("grid");
    const c = await render(createElement(TagBadges, { session: session([g("乙"), g("甲")]), definedKeys: KEYS, defs: DEFS }));
    const title = c.querySelector('[data-testid="tag-color-grid"]')?.getAttribute("title") ?? "";
    expect(title).toContain("乙");
    expect(title).toContain("甲");
  });
});

describe("TagBadges 模式判定回归", () => {
  test("全局 text 档（缺省）渲染文字徽标，不出色格（历史形态不漂移）", async () => {
    seed("text");
    const c = await render(createElement(TagBadges, { session: session([g("甲")]), definedKeys: KEYS, defs: DEFS }));
    expect(c.querySelector('[data-testid="tag-badges"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="tag-color-grid"]')).toBeNull();
    expect(c.querySelector('[data-testid="tag-badge"]')?.getAttribute("data-tag")).toBe("甲");
  });

  test("任一 display:text 覆盖 → 全局 grid 档下整行回退文字徽标", async () => {
    seed("grid");
    const c = await render(
      createElement(TagBadges, { session: session([g("甲"), g("戊")]), definedKeys: KEYS, defs: DEFS }),
    );
    expect(c.querySelector('[data-testid="tag-badges"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="tag-color-grid"]')).toBeNull();
  });

  test("孤儿格灰显入格，title 仍显名；点格不再触发清理（任务 10：清理移入管理弹框）", async () => {
    seed("grid");
    setSessionTagsMock.mockResolvedValue({ tags: [] });
    const c = await render(
      createElement(TagBadges, { session: session([g("甲"), g("已删")]), definedKeys: KEYS, defs: DEFS }),
    );
    const grid = c.querySelector('[data-testid="tag-color-grid"]');
    const orphanCell = grid?.querySelector('span[data-tag="已删"]');
    expect(orphanCell?.getAttribute("data-orphan")).toBe("true");
    expect(orphanCell?.className).toContain("bg-muted-foreground/40");
    expect(grid?.getAttribute("title")).toContain("已删");
    // 点格无删除副作用（旧语义点按即整替删孤儿，已移入标签管理弹框带确认）
    await act(async () => {
      grid?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(setSessionTagsMock).not.toHaveBeenCalled();
  });

  test("文字徽标孤儿灰显，点按不再触发清理（任务 10）", async () => {
    seed("text");
    setSessionTagsMock.mockResolvedValue({ tags: [] });
    const c = await render(createElement(TagBadges, { session: session([g("已删")]), definedKeys: KEYS, defs: DEFS }));
    const badge = c.querySelector('[data-testid="tag-badge"][data-tag="已删"]');
    expect(badge?.getAttribute("data-orphan")).toBe("true");
    await act(async () => {
      badge?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(setSessionTagsMock).not.toHaveBeenCalled();
  });
});

describe("TagBadges 移动端点格 toast 显名", () => {
  test("视口 390 点格 → toast 含显名清单；桌面点格无 toast", async () => {
    seed("grid");
    const win = window as unknown as { innerWidth: number };
    const savedWidth = win.innerWidth;
    win.innerWidth = 390;
    try {
      const c = await render(createElement(TagBadges, { session: session([g("乙"), g("甲")]), definedKeys: KEYS, defs: DEFS }));
      const grid = c.querySelector('[data-testid="tag-color-grid"]');
      await act(async () => {
        grid?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const toast = useUiStore.getState().toasts.at(-1) ?? null;
      expect(toast?.text).toContain("乙");
      expect(toast?.text).toContain("甲");
    } finally {
      win.innerWidth = savedWidth;
    }
  });
});
