/**
 * 会话列表行紧凑化测试（docs08-r5 任务 11）：
 * - formatRelative 紧凑档位全枚举：<60s → Ns（未来时间钳 0s）、<60m → Nm、<24h → Nh、
 *   <30d → Nd、≥30d → M/D、跨年 → YY/M/D、非法 ISO → 空串（不汉化，对标 OC 数字+字母）
 * - 行渲染：紧凑时间上屏；桌面共享槽位机制类级 pin（时间 lg:group-hover:invisible +
 *   菜单开 group-has 隐藏；菜单钮 lg:absolute 脱离文档流回收 32px 常占宽 + hover 交换显隐；
 *   hover 态真实显隐走 Playwright 双档取证，happy-dom 无 CSS 求值不做伪断言）；
 *   手机双常显（时间无隐藏类、菜单钮无基线 opacity-0）；批量框/展开钮/未读/置顶零回归
 * 场景走真实组件（happy-dom + react-dom/client，sidebar-single-list.test.tsx 同款基建）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

// vitest 单文件独立 worker，双注册防御与 bun 单进程先例同形（sidebar-single-list 同款）
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { formatRelative, SessionItem } = await import("@/components/session-list/session-item");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");

function makeSession(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    path: `/store/${id}.jsonl`,
    project: "/p1",
    title: id,
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: false,
    ...overrides,
  };
}

let mountedRoot: { unmount(): void } | null = null;

/** 挂载组件并落 DOM，返回容器（根句柄登记到模块级，afterEach 统一卸载） */
async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  mountedRoot = root;
  return container;
}

function classesOf(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

beforeEach(() => {
  useSessionsStore.setState({
    byProject: {},
    runStates: {},
    allMode: false,
    selectedId: null,
    loading: false,
    view: "all",
    q: "",
    archived: "false",
    tagFilter: [],
  });
  useUiStore.setState({ currentProject: null, projects: [], models: [] });
});

afterEach(async () => {
  const root = mountedRoot;
  mountedRoot = null;
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

describe("formatRelative 紧凑档位全枚举（docs08-r5 任务 11）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 冻结在 2026-10-18 12:00 本地时：同年/跨年日期分支确定性可断言
    vi.setSystemTime(new Date(2026, 9, 18, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  test("<60s → Ns：0s 起点、59s 边界、未来时间（时钟偏移）钳 0s", () => {
    expect(formatRelative(ago(0))).toBe("0s");
    expect(formatRelative(ago(5_000))).toBe("5s");
    expect(formatRelative(ago(59_000))).toBe("59s");
    expect(formatRelative(new Date(Date.now() + 10_000).toISOString())).toBe("0s");
  });

  test("<60m → Nm：60s 进位、90s 仍 1m、59m 边界", () => {
    expect(formatRelative(ago(60_000))).toBe("1m");
    expect(formatRelative(ago(90_000))).toBe("1m");
    expect(formatRelative(ago(59 * 60_000))).toBe("59m");
  });

  test("<24h → Nh：60m 进位、23h 边界", () => {
    expect(formatRelative(ago(60 * 60_000))).toBe("1h");
    expect(formatRelative(ago(23 * 3_600_000))).toBe("23h");
  });

  test("<30d → Nd：24h 进位、29d 边界", () => {
    expect(formatRelative(ago(24 * 3_600_000))).toBe("1d");
    expect(formatRelative(ago(29 * 86_400_000))).toBe("29d");
  });

  test("≥30d：同年 → M/D；跨年 → YY/M/D（两位年）", () => {
    // 2026-10-18 12:00 - 40d = 2026-09-08 → 9/8；- 400d = 2025-09-13 → 25/9/13
    expect(formatRelative(ago(40 * 86_400_000))).toBe("9/8");
    expect(formatRelative(ago(400 * 86_400_000))).toBe("25/9/13");
  });

  test("非法 ISO → 空串（不抛错）", () => {
    expect(formatRelative("not-a-date")).toBe("");
  });
});

describe("SessionItem 行渲染紧凑化（docs08-r5 任务 11）", () => {
  test("紧凑时间上屏（跨年固定样本 → 20/1/1，不出现中文格式）", async () => {
    const container = await mount(
      createElement(SessionItem, {
        session: makeSession("compact-time", { modified: "2020-01-01T00:00:00.000Z", title: "紧凑时间行" }),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    expect(container.textContent).toContain("20/1/1");
    expect(container.textContent).not.toMatch(/分钟前|小时前|天前|刚刚/);
  });

  test("桌面共享槽位：菜单钮 lg:absolute 脱离文档流回收常占宽，hover 交换显隐类在位", async () => {
    const container = await mount(
      createElement(SessionItem, {
        session: makeSession("slot-row", { modified: "2020-01-01T00:00:00.000Z", title: "槽位行" }),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    const btn = container.querySelector<HTMLButtonElement>('button[aria-label="会话操作"]');
    expect(btn).toBeDefined();
    // 行尾同一槽位：绝对定位右缘对齐行内边距（px-1.5 → right-1.5），脱离文档流 → 不再常占 32px 布局宽
    expect(btn!.className).toContain("lg:absolute");
    expect(btn!.className).toContain("lg:right-1.5");
    // hover 交换显隐：非 hover 隐（lg:opacity-0）、hover 显（lg:group-hover:opacity-100）
    expect(btn!.className).toContain("lg:opacity-0");
    expect(btn!.className).toContain("lg:group-hover:opacity-100");
    // 菜单打开与键盘 focus-visible 时不随 hover 消失
    expect(btn!.className).toContain("data-[state=open]:opacity-100");
    expect(btn!.className).toContain("focus-visible:opacity-100");
    // 对侧：时间 hover 隐 + 菜单打开期间保持隐（invisible 保布局零跳版）
    const time = [...container.querySelectorAll("span")].find((s) => (s.textContent ?? "").includes("20/1/1"));
    expect(time).toBeDefined();
    expect(time!.className).toContain("lg:group-hover:invisible");
    expect(time!.className).toContain("lg:group-has-[[data-state=open]]:invisible");
    // 行高维持：菜单钮脱离文档流后行高改由 lg:py-2 提供（36px 桌面行不变）
    const row = btn!.closest("div.group");
    expect(row).toBeDefined();
    expect(row!.className).toContain("lg:py-2");
  });

  test("手机双常显：时间与菜单钮均无移动端隐藏类（无裸 hidden/invisible/opacity-0，无 max-lg: 前缀）", async () => {
    const container = await mount(
      createElement(SessionItem, {
        session: makeSession("mobile-row", { modified: "2020-01-01T00:00:00.000Z", title: "移动端行" }),
        expandable: false,
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    const btn = container.querySelector<HTMLButtonElement>('button[aria-label="会话操作"]');
    expect(btn).toBeDefined();
    const btnClasses = classesOf(btn!);
    expect(btnClasses).not.toContain("opacity-0");
    expect(btnClasses).not.toContain("hidden");
    expect(btnClasses).not.toContain("invisible");
    expect(btnClasses.some((c) => c.startsWith("max-lg:"))).toBe(false);
    const time = [...container.querySelectorAll("span")].find((s) => (s.textContent ?? "").includes("20/1/1"));
    expect(time).toBeDefined();
    const timeClasses = classesOf(time!);
    expect(timeClasses).not.toContain("invisible");
    expect(timeClasses).not.toContain("hidden");
    expect(timeClasses.some((c) => c.startsWith("max-lg:"))).toBe(false);
  });

  test("批量框/展开钮/未读/置顶与共享槽位同屏零回归", async () => {
    const container = await mount(
      createElement(SessionItem, {
        session: makeSession("full-row", { title: "满配行", unreadCount: 3, pinned: true }),
        expandable: true,
        selectable: true,
        checked: false,
        onToggleCheck: () => {},
        onDialog: () => {},
        onChanged: () => {},
      }),
    );
    expect(container.querySelector('button[role="checkbox"]')).toBeDefined();
    expect(container.querySelector('button[aria-label="展开子会话"]')).toBeDefined();
    const unread = [...container.querySelectorAll("span")].find(
      (s) => s.className.includes("bg-primary") && s.textContent?.trim() === "3",
    );
    expect(unread).toBeDefined();
    expect(container.querySelector("svg.lucide-pin")).toBeDefined();
    const btn = container.querySelector<HTMLButtonElement>('button[aria-label="会话操作"]');
    expect(btn?.className).toContain("lg:absolute");
  });
});
