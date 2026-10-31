// 更新区组件回归（2026-10-31 update-m23 批次，任务 5）：
//   1) 有更新 → 横幅呈现两侧「当前→目标」+ 确认按钮点击 POST {target:"webui",version:latest}
//      + 状态行「更新中」出现；
//   2) 无更新 → 无横幅，仅当前版本行；
//   3) 检查接口拒绝 → 降级不崩溃：无横幅、错误文案 + 重试可点。
// 挂载基建同 abort-settle-reset 惯例（happy-dom 全局注册 + createRoot + act + fetch 桩）。
import { afterEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { UpdateSection } = await import("@/components/settings/update-section");

const ORIGINAL_FETCH = globalThis.fetch;

interface RecordedCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const okJson = (data: unknown): Response =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

function checkShape(webui: Record<string, unknown>, engine: Record<string, unknown>): unknown {
  return { webui, engine };
}

/** fetch 桩：记录调用并按端点回响应；install 拒绝用 opts.installFail */
function installFetch(opts: { check?: unknown; checkFail?: boolean; installFail?: boolean } = {}): {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body });
    if (url === "/api/update/check") {
      if (opts.checkFail) return Promise.reject(new TypeError("network down"));
      return okJson(opts.check ?? checkShape({}, {}));
    }
    if (url === "/api/update/install") {
      if (opts.installFail) return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      return okJson({ restarting: true, version: body?.version });
    }
    return okJson({});
  }) as typeof fetch;
  return { calls };
}

const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(UpdateSection));
  });
  return container;
}

/** 有界等待渲染态出现（真实定时器 + act 冲刷；订阅的是渲染结果而非固定延时） */
async function until(container: HTMLElement, selector: string): Promise<Element> {
  for (let i = 0; i < 100; i++) {
    const el = container.querySelector(selector);
    if (el) return el;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`timeout waiting for ${selector}`);
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
  }
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("UpdateSection", () => {
  test("shows banner with both versions and confirms install", async () => {
    const { calls } = installFetch({
      check: checkShape(
        { current: "1.0.0", latest: "2.0.0", hasUpdate: true },
        { current: "2026.10.1", latest: "2026.10.31", hasUpdate: true },
      ),
    });
    const c = await mount();

    const banner = await until(c, "[data-testid=update-banner]");
    expect(banner.textContent).toContain("1.0.0");
    expect(banner.textContent).toContain("2.0.0");
    expect(banner.textContent).toContain("2026.10.31");

    await click(c.querySelector<HTMLButtonElement>("[data-testid=update-confirm-btn]")!);

    const post = calls.find((x) => x.url === "/api/update/install" && x.method === "POST");
    expect(post).toBeDefined();
    expect(post!.body).toEqual({ target: "webui", version: "2.0.0" });
    await until(c, "[data-testid=update-status]");
    expect(c.querySelector("[data-testid=update-status]")!.textContent).toContain("更新中");
  });

  test("renders current-version line without banner when no update", async () => {
    installFetch({
      check: checkShape(
        { current: "1.0.0", latest: "1.0.0", hasUpdate: false },
        { current: "2026.10.1", latest: "2026.10.1", hasUpdate: false },
      ),
    });
    const c = await mount();

    await until(c, "[data-testid=update-current]");
    expect(c.querySelector("[data-testid=update-current]")!.textContent).toContain("1.0.0");
    expect(c.querySelector("[data-testid=update-banner]")).toBeNull();
  });

  test("degrades without crash when check fetch rejects", async () => {
    installFetch({ checkFail: true });
    const c = await mount();

    await until(c, "[data-testid=update-error]");
    expect(c.querySelector("[data-testid=update-banner]")).toBeNull();
    expect(c.querySelector("[data-testid=update-retry-btn]")).not.toBeNull();
  });
});
