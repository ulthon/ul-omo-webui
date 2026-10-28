// @ts-nocheck
// r10 todo 1：会话列表展开/收缩按钮移除（docs/08 GAP-13，零 fork 血缘实证按钮纯噪音）。
// 环境说明同 model-badge.test.tsx：@ts-nocheck（类型包仅在 server 工作区）+ 被测模块动态
// import（保证单独运行时晚于 preload mock 生效）；renderToStaticMarkup 服务端渲染
// （zustand 快照 shim + setup-locale 锁 zh-CN）。验收：普通会话与 fork 血缘会话渲染
// 均无展开/收缩控件（aria-label 展开子会话/收起子会话），fork 行不崩溃且来源徽标保留。
import { describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// composer-mobile-layout 惯例：@happy-dom 全局注册 + renderToStaticMarkup 静态断言
// （TagBadges → useIsMobile 需要 window.matchMedia）
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

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SessionItem } = await import("../session-item");
const { t: tSnap } = await import("@/i18n/i18n");

/** 展开钮（已删除）与收起钮的 aria-label 文案：经 i18n 取词而非硬编码，
 * 文案改动时断言自动跟随真实控件存在性（setup-locale 锁 zh-CN）。 */
const EXPAND_LABEL = tSnap("sessionList.item.expandChildren");
const COLLAPSE_LABEL = tSnap("sessionList.item.collapseChildren");
const NO_CHILDREN_TEXT = tSnap("sessionList.item.noChildren");

function makeSession(overrides = {}) {
  return {
    id: "s1",
    path: "/tmp/p/2026-01-01T00-00-00-000-abcd",
    project: "/tmp/p",
    title: "示例会话",
    name: null,
    renamedTitle: null,
    parentSessionPath: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "",
    pinned: false,
    archivedAt: null,
    unreadCount: 0,
    lastRead: null,
    active: null,
    runState: null,
    tags: [],
    ...overrides,
  };
}

const noop = () => {};

function renderItem(session) {
  return renderToStaticMarkup(
    createElement(SessionItem, {
      session,
      forkIndexes: new Map([["/tmp/p/2026-01-01T00-00-00-000-abcd", 1]]),
      onDialog: noop,
      onChanged: noop,
    }),
  );
}

describe("会话列表展开/收缩按钮移除（r10 todo 1 / GAP-13）", () => {
  test("普通会话：DOM 无展开/收起控件，行标题正常渲染", () => {
    const html = renderItem(makeSession());
    expect(html).toContain("示例会话");
    expect(html).not.toContain(EXPAND_LABEL);
    expect(html).not.toContain(COLLAPSE_LABEL);
    expect(html).not.toContain(NO_CHILDREN_TEXT);
  });

  test("fork 血缘会话：渲染不崩溃，无展开控件，来源徽标与 (fork #N) 后缀保留", () => {
    const html = renderItem(makeSession({ id: "s2", parentSessionPath: "/tmp/parent" }));
    expect(html).toContain("(fork #1)");
    expect(html).toContain("fork");
    expect(html).not.toContain(EXPAND_LABEL);
    expect(html).not.toContain(COLLAPSE_LABEL);
  });
});
