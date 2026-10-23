// @ts-nocheck
// 「发现模型」分区前端单测（docs08-2026-10-22 批次任务 23）。
// schedule-ui 同款惯例：@happy-dom 全局注册 + createRoot/act 真实交互 + fetch 桩走真 api 层。
// 覆盖：(1) provider 清单加载与选择；(2) 发现预览（POST 仅 provider，新增列表+全选默认）；
// (3) 确认导入（POST 带 import 所选，成功摘要）；(4) 无新增空态；(5) 服务端错误回显。
// 纯函数（toggleSelected/isAllSelected/summarizeImport/providerOptionLabel）单测。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { ModelsDiscoverSection } = await import("@/components/models/models-discover-section");
const {
  toggleSelected,
  isAllSelected,
  providerOptionLabel,
  summarizeImport,
} = await import("@/components/models/models-discover-data");
const { useLocaleStore } = await import("@/i18n/i18n");

const ORIGINAL_FETCH = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function installFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }): { calls: Call[] } {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ url, method: init?.method ?? "GET", body });
    const res = handler(url, init ?? {});
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "zh-CN" });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

/** 找到 data-testid 对应元素（happy-dom 无 testid 选择器引擎，手写遍历） */
function byTestId(root: HTMLElement, id: string): HTMLElement | null {
  const walk = (node: Element): HTMLElement | null => {
    if (node instanceof HTMLElement && node.dataset.testid === id) return node;
    for (const child of node.children) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

function text(root: HTMLElement): string {
  return (root.textContent ?? "").trim();
}

async function click(root: HTMLElement, testId: string): Promise<void> {
  const el = byTestId(root, testId);
  if (!el) throw new Error(`missing testid ${testId}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const PROVIDERS = {
  providers: [
    { id: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: null, modelCount: 2 },
    { id: "bare", baseUrl: "", api: null, modelCount: 0 },
  ],
};

const REPORT_FRESH = {
  provider: "zhipu",
  url: "https://open.bigmodel.cn/api/paas/v4/models",
  discovered: ["glm-5.3", "glm-5.3-air", "glm-5.3-4k"],
  added: ["glm-5.3", "glm-5.3-air", "glm-5.3-4k"],
  unchanged: [],
  imported: null,
  written: false,
};

const REPORT_PARTIAL = {
  ...REPORT_FRESH,
  discovered: ["glm-5.3", "glm-5.3-4k"],
  added: ["glm-5.3-4k"],
  unchanged: ["glm-5.3"],
};

describe("models-discover 纯函数", () => {
  test("toggleSelected/isAllSelected/summarizeImport/providerOptionLabel", () => {
    expect(toggleSelected(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleSelected(["a", "b"], "a")).toEqual(["b"]);
    expect(isAllSelected(["a", "b"], ["a", "b"])).toBe(true);
    expect(isAllSelected(["a", "b"], ["a"])).toBe(false);
    expect(isAllSelected([], [])).toBe(false);
    expect(summarizeImport({ ...REPORT_FRESH, imported: ["x", "y"], written: true })).toEqual({ kind: "done", count: 2 });
    expect(summarizeImport(REPORT_FRESH)).toEqual({ kind: "nothing", count: 0 });
    expect(providerOptionLabel(PROVIDERS.providers[0])).toContain("2");
    expect(providerOptionLabel(PROVIDERS.providers[1])).toContain("-");
  });
});

describe("ModelsDiscoverSection", () => {
  function setup(): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    return { container, root };
  }

  test("加载 provider 清单并渲染选择器与说明", async () => {
    installFetch(() => ({ status: 200, body: PROVIDERS }));
    const { container, root } = setup();
    await act(async () => {
      root.render(createElement(ModelsDiscoverSection));
    });
    const select = byTestId(container, "models-discover-provider") as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe("zhipu");
    expect(select.options.length).toBe(2);
    expect(text(container)).toContain("发现模型");
    expect(text(container)).toContain("重复发现不会重复导入");
    await act(async () => root.unmount());
    container.remove();
  });

  test("发现预览：POST 仅 provider，新增全选，确认导入带所选 id 且显示成功摘要", async () => {
    let phase = 0;
    const { calls } = installFetch((url, init) => {
      if (init.method === "POST" && phase === 0) return { status: 200, body: REPORT_FRESH };
      if (init.method === "POST") return { status: 200, body: { ...REPORT_PARTIAL, imported: ["glm-5.3-4k"], written: true } };
      return { status: 200, body: PROVIDERS };
    });
    const { container, root } = setup();
    await act(async () => {
      root.render(createElement(ModelsDiscoverSection));
    });
    await click(container, "models-discover-run");
    const results = byTestId(container, "models-discover-results");
    expect(results).not.toBeNull();
    expect(text(results)).toContain("发现 3 个模型");
    for (const id of REPORT_FRESH.added) {
      const item = byTestId(container, `models-discover-item-${id}`);
      expect(item).not.toBeNull();
    }
    // 全选默认：三个 checkbox 全勾
    const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes.every((c) => c.checked)).toBe(true);

    // 取消一个再导入：POST import 只带所选
    phase = 1;
    await act(async () => {
      checkboxes[0].click();
    });
    await click(container, "models-discover-import");
    const importCall = calls.find((c) => c.method === "POST" && (c.body as { import?: unknown }).import !== undefined);
    expect(importCall).toBeDefined();
    expect((importCall!.body as { provider: string; import: string[] }).import).toEqual(["glm-5.3-air", "glm-5.3-4k"]);
    expect((importCall!.body as { provider: string }).provider).toBe("zhipu");
    const resultEl = byTestId(container, "models-discover-result");
    expect(resultEl).not.toBeNull();
    expect(text(resultEl!)).toContain("已导入 1 个新模型");
    await act(async () => root.unmount());
    container.remove();
  });

  test("无新增空态：不渲染导入按钮，显示无需导入", async () => {
    installFetch((_url, init) =>
      init.method === "POST"
        ? { status: 200, body: { ...REPORT_FRESH, discovered: ["glm-5.3"], added: [], unchanged: ["glm-5.3"] } }
        : { status: 200, body: PROVIDERS },
    );
    const { container, root } = setup();
    await act(async () => {
      root.render(createElement(ModelsDiscoverSection));
    });
    await click(container, "models-discover-run");
    expect(byTestId(container, "models-discover-nothing-new")).not.toBeNull();
    expect(byTestId(container, "models-discover-import")).toBeNull();
    await act(async () => root.unmount());
    container.remove();
  });

  test("发现失败：错误码词典回显，预览区清空", async () => {
    installFetch((_url, init) =>
      init.method === "POST"
        ? { status: 502, body: { error: { code: "discover_upstream_failed", message: "GET https://x/v1/models 失败：HTTP 401" } } }
        : { status: 200, body: PROVIDERS },
    );
    const { container, root } = setup();
    await act(async () => {
      root.render(createElement(ModelsDiscoverSection));
    });
    await click(container, "models-discover-run");
    const err = byTestId(container, "models-discover-error");
    expect(err).not.toBeNull();
    // 命中词典键 → 双语文案，不透传键名
    expect(text(err!)).toContain("模型发现请求失败");
    expect(text(err!)).not.toContain("errors.");
    expect(byTestId(container, "models-discover-results")).toBeNull();
    await act(async () => root.unmount());
    container.remove();
  });
});
