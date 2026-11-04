// @ts-nocheck
// 恢复摘要行展开单测（2026-11-05 #11）：内容长时单行截断看不全——点行展开全文、
// 再点收起。环境说明同 engine-section.test.tsx：@ts-nocheck + 动态 import +
// @happy-dom 全局注册。验收：(a) 默认收起（无全文节点）；(b) 点击后全文节点在场
// 且 data-expanded/aria-expanded 翻转；(c) 再点收起。
import { describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
(globalThis as { matchMedia?: unknown }).matchMedia ??= () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
});

vi.mock("@/lib/api", () => ({
  api: new Proxy({}, { get: () => () => Promise.resolve({}) }),
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/i18n/i18n", () => ({ useT: () => (key: string) => key }));

const { RestoreDigestLine } = await import("@/components/chat/message-bubble");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const LONG = "恢复 12 个会话：丢失 3 条、孤儿 5 条、重放 2 条；模型 p/glm-5.3 掉线重连；定时任务 4 项已重新登记；标签 2 个丢失被清理；".repeat(3);

function mount(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(RestoreDigestLine, { digest: { content: LONG } }));
  });
  return host;
}

function clickRow(host: HTMLElement) {
  act(() => {
    host.querySelector('[data-testid="restore-digest-line"]').dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
  });
}

describe("恢复摘要行展开（#11）", () => {
  test("(a) 默认收起：全文节点不在，aria-expanded=false", () => {
    const host = mount();
    const row = host.querySelector('[data-testid="restore-digest-line"]');
    expect(host.querySelector('[data-testid="restore-digest-full"]')).toBeNull();
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.textContent).toContain(LONG.slice(0, 8)); // 截断单行仍含开头
  });

  test("(b) 点击展开：全文节点在场、不截断、aria 翻转", () => {
    const host = mount();
    clickRow(host);
    const full = host.querySelector('[data-testid="restore-digest-full"]');
    expect(full).not.toBeNull();
    expect(full.textContent).toBe(LONG); // 完整无截断
    expect(host.querySelector('[data-testid="restore-digest-line"]').getAttribute("aria-expanded")).toBe("true");
  });

  test("(c) 再点收起：回到截断单行", () => {
    const host = mount();
    clickRow(host);
    clickRow(host);
    expect(host.querySelector('[data-testid="restore-digest-full"]')).toBeNull();
    expect(host.querySelector('[data-testid="restore-digest-line"]').getAttribute("aria-expanded")).toBe("false");
  });
});
