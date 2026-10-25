// @ts-nocheck
// docs08-2026-10-23-24 批次任务 15：DialogContent 通用滚动修复的回归守卫。
// 断言基础类自带高度约束 max-h-[calc(100dvh-2rem)]、overflow-y-auto 与
// min-w-0（Radix grid 轨道被长 truncate 行撑爆的防护），且消费者可覆盖。
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Dialog, DialogContent, DialogTitle } = await import("@/components/ui/dialog");

let container: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  document.body.innerHTML = "";
  container = null;
  root = null;
});

async function renderDialog(contentProps?: Record<string, unknown>) {
  await act(async () => {
    root.render(
      createElement(
        Dialog,
        { open: true },
        createElement(
          DialogContent,
          contentProps ?? {},
          createElement(DialogTitle, null, "标题")
        )
      )
    );
  });
  return document.querySelector('[data-slot="dialog-content"]');
}

describe("任务15 DialogContent 通用滚动", () => {
  test("基础类含 max-h 100dvh / overflow-y-auto / min-w-0", async () => {
    const el = await renderDialog();
    expect(el).not.toBeNull();
    const cls = el.getAttribute("class") ?? "";
    expect(cls).toContain("max-h-[calc(100dvh-2rem)]");
    expect(cls).toContain("overflow-y-auto");
    expect(cls).toContain("min-w-0");
  });

  test("消费者自定义 className 正常拼接（宽度覆盖场景）", async () => {
    const el = await renderDialog({ className: "sm:max-w-md" });
    const cls = el.getAttribute("class") ?? "";
    expect(cls).toContain("sm:max-w-md");
    expect(cls).toContain("max-h-[calc(100dvh-2rem)]");
  });
});
