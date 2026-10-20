// useT 响应性测试（Wave-2 收口 B）：语言切换必须即时驱动已接线组件重渲染。
// 靶件 TagBadges（真实接线组件）：徽标 title 直出 t("sessionList.tagBadge.title") 插值。
// 断言双语显式（误导性成功防护）：切换前后同一 DOM 节点的 title 必须逐字等于
// zh「标签：bug」/ en "Tag: bug"（字典值，改文案需同步本用例）；仍旧语言或回退键名都判失败。
// 确定性：固定 props、store 单点 setState、无 timers、无网络（孤儿清理路径不触发）。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListItem } from "@/lib/api";

// vitest 单文件独立 worker，双注册防御（sidebar-single-list 同款）
if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { TagBadges } = await import("@/components/session-list/tag-badge");
const { useLocaleStore } = await import("@/i18n/i18n");

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

async function render(ui: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeEach(() => {
  // 归位 zh-CN（setup-locale 已兜底，此处自证起点，不依赖执行顺序）
  useLocaleStore.setState({ locale: "zh-CN" });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useT 语言切换响应性", () => {
  test("TagBadges zh-CN 渲染中文，setState 切 en 后同节点即时改英文，切回复原", async () => {
    const session = makeSession("s1", { tags: [{ scope: "global", name: "bug" }] });
    // 定义集含 (global,bug)：徽标为非孤儿，title 走 sessionList.tagBadge.title 插值
    const definedKeys = new Set(["global\u0000bug"]);
    const { container, unmount } = await render(createElement(TagBadges, { session, definedKeys }));

    // 先取节点引用再切语言：断言作用于同一 DOM 节点（证明是重渲染而非重挂载）
    const badge = container.querySelector<HTMLElement>("[data-testid=tag-badge]")!;
    expect(badge).not.toBeNull();

    // 切换前：中文值显式断言
    expect(badge.getAttribute("title")).toBe("标签：bug");

    await act(async () => {
      useLocaleStore.setState({ locale: "en" });
    });

    // 切换后：同一节点已显示英文值（订阅驱动重渲染的直接证据）
    expect(badge.getAttribute("title")).toBe("Tag: bug");

    // 切回 zh 复原（双向断言，排除单向巧合）
    await act(async () => {
      useLocaleStore.setState({ locale: "zh-CN" });
    });
    expect(badge.getAttribute("title")).toBe("标签：bug");

    await unmount();
  });
});
