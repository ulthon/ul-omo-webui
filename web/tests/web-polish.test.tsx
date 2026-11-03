// 前端小修三件套定向测试（2026-11-03）：A 站点名 kv 优先于 env 默认；B 代码块复制钮
// 点击写剪贴板；C 表格无常驻操作列、浮钮组 hover 类齐备。环境沿
// markdown-table-actions.test.tsx：GlobalRegistrator 双注册守卫 + IS_REACT_ACT_ENVIRONMENT。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// 剪贴板 mock 须先于被测模块（markdown.tsx 顶层 import copyText）
const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyText }));

const { resolveSiteName, useUiStore } = await import("@/stores/ui");
const { Markdown } = await import("@/components/chat/markdown");
const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");

/** 含 3 列表头 + 2 数据行的 fixture 表格 */
const TABLE_MD = ["| 名称 | 数值 | 备注 |", "| --- | --- | --- |", "| 甲 | 1 | 普通 |", "| 乙 | 2 | 备注 |"].join("\n");
/** 无语言标注的代码块（跳过 Shiki worker，纯文本态即含复制钮） */
const CODE_MD = ["```", "const a = 1", "const b = 2", "```"].join("\n");

describe("小修 A：站点名 kv 优先于 env 注入默认", () => {
  test("kv 非空（含首尾空白）时覆盖 env 注入值", () => {
    expect(resolveSiteName("自定义站名", "env 默认站")).toBe("自定义站名");
    expect(resolveSiteName("  自定义站名  ", "env 默认站")).toBe("自定义站名");
  });

  test("kv 缺失/空串/纯空白时回退 env 注入值；两者皆无为 null（不渲染）", () => {
    expect(resolveSiteName(null, "env 默认站")).toBe("env 默认站");
    expect(resolveSiteName(undefined, "env 默认站")).toBe("env 默认站");
    expect(resolveSiteName("", "env 默认站")).toBe("env 默认站");
    expect(resolveSiteName("   ", "env 默认站")).toBe("env 默认站");
    expect(resolveSiteName(null, null)).toBe(null);
  });

  test("store 档位变更经 resolveSiteName 即时反映（顶栏订阅语义）", () => {
    const injected = "env 注入站";
    act(() => {
      useUiStore.getState().setSiteName("kv 覆盖站");
    });
    expect(resolveSiteName(useUiStore.getState().siteName, injected)).toBe("kv 覆盖站");
    act(() => {
      useUiStore.getState().setSiteName(null);
    });
    expect(resolveSiteName(useUiStore.getState().siteName, injected)).toBe(injected);
  });
});

describe("小修 B：代码块复制按钮", () => {
  beforeEach(() => {
    copyText.mockReset();
  });

  test("渲染含复制钮（aria-label/title/data-testid 齐备）", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: CODE_MD }));
    expect(html).toContain('aria-label="复制代码"');
    expect(html).toContain('title="复制代码"');
    expect(html).toContain("data-testid=\"code-block-copy\"");
  });

  test("点击复制钮：copyText 收到代码块原文（去尾换行），成功 toast 提示", async () => {
    copyText.mockResolvedValue(true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Markdown, { text: CODE_MD }));
    });
    const btn = container.querySelector('button[data-testid="code-block-copy"]');
    expect(btn).not.toBeNull();
    await act(async () => {
      (btn as HTMLButtonElement).click();
    });
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copyText).toHaveBeenCalledWith("const a = 1\nconst b = 2");
    expect(useUiStore.getState().toasts.at(-1)?.text).toBe("已复制代码");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe("小修 C：表格操作列收敛为表级浮钮组", () => {
  test("无常驻操作列单元格；浮钮组随表渲染于相对定位容器内（hover/focus 显现类齐备）", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: TABLE_MD }));
    expect(html).not.toContain("table-row-actions-cell");
    expect(html).toContain("data-md-table-wrap");
    expect(html).toContain("data-testid=\"table-float-actions\"");
    // hover 显现（触屏首点即触发 CSS hover，可接受退化）+ 键盘 focus-within 可达
    // （同表仅一组浮钮，类断言直接对全文即可）
    expect(html).toContain("opacity-0");
    expect(html).toContain("group-hover/table:opacity-100");
    expect(html).toContain("focus-within:opacity-100");
  });

  test("整表一组浮钮（复制 TSV + 下载 CSV 语义保留），而非每行各一列", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: TABLE_MD }));
    expect((html.match(/aria-label="复制表格"/g) ?? []).length).toBe(1);
    expect((html.match(/aria-label="下载 CSV"/g) ?? []).length).toBe(1);
    expect((html.match(/<tr>/g) ?? []).length).toBe(3);
  });

  test("浮钮组点击复制全表 TSV（数据读取链路不变）", async () => {
    copyText.mockResolvedValue(true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Markdown, { text: TABLE_MD }));
    });
    const btn = container.querySelector('button[aria-label="复制表格"]');
    expect(btn).not.toBeNull();
    await act(async () => {
      (btn as HTMLButtonElement).click();
    });
    expect(copyText).toHaveBeenCalledWith("名称\t数值\t备注\n甲\t1\t普通\n乙\t2\t备注");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
