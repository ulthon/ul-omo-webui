// @ts-nocheck
// 「流量统计」分区前端单测（docs08-2026-10-22 批次任务 28）。
// models-discover 同款惯例：@happy-dom 全局注册 + createRoot/act + fetch 桩走真 api 层。
// 覆盖：(1) 端点日账表格渲染与字节格式化；(2) vnstat 系统账可用展示；
// (3) vnstat 缺失降级提示；(4) 零流量空态；(5) 刷新拉新数字移动。
// 纯函数 formatBytes（大数值）单测。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { TrafficSection } = await import("@/components/stats/traffic-section");
const { formatBytes, toEndpointRows } = await import("@/components/stats/traffic-data");
const { useLocaleStore } = await import("@/i18n/i18n");

const ORIGINAL_FETCH = globalThis.fetch;

function installFetch(handler: (url: string) => { status: number; body: unknown }): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const res = handler(url);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "zh-CN" });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

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

async function mount(): Promise<{ root: HTMLElement; unmount: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const reactRoot = createRoot(host);
  await act(async () => {
    reactRoot.render(createElement(TrafficSection));
  });
  return { root: host, unmount: () => reactRoot.unmount() };
}

const SNAP = {
  day: "2026-10-23",
  generatedAt: "2026-10-23T03:00:00.000Z",
  endpoints: [
    { endpoint: "/api/events", requests: 3, reqBytes: 0, resBytes: 0, sseConnections: 3, sseEvents: 2500, sseBytes: 1024 * 1024 * 3 },
    { endpoint: "/api/sessions/:id/messages", requests: 12, reqBytes: 2048, resBytes: 1024 * 1024 * 5, sseConnections: 0, sseEvents: 0, sseBytes: 0 },
  ],
  system: {
    available: true,
    interface: "eth0",
    day: { date: "2026-10-23", rx: 3000, tx: 4000 },
    month: { rx: 1024 * 1024 * 100, tx: 1024 * 1024 * 200 },
  },
};

describe("TrafficSection", () => {
  test("端点日账表格：行数、请求数与格式化字节", async () => {
    installFetch((url) => (url.includes("/api/stats/traffic") ? { status: 200, body: SNAP } : { status: 404, body: {} }));
    const { root, unmount } = await mount();
    const table = byTestId(root, "traffic-endpoints");
    expect(table).not.toBeNull();
    const rows = table.querySelectorAll("[data-testid='traffic-endpoint-row']");
    expect(rows.length).toBe(2);
    expect(table.textContent).toContain("/api/sessions/:id/messages");
    expect(table.textContent).toContain("12");
    expect(table.textContent).toContain("5.00 MB");
    expect(table.textContent).toContain("3 / 2500 / 3.00 MB");
    unmount();
  });

  test("vnstat 系统账可用：网卡/日账/月账展示", async () => {
    installFetch((url) => (url.includes("/api/stats/traffic") ? { status: 200, body: SNAP } : { status: 404, body: {} }));
    const { root, unmount } = await mount();
    const sys = byTestId(root, "traffic-system");
    expect(sys).not.toBeNull();
    expect(sys.textContent).toContain("eth0");
    expect(sys.textContent).toContain("2026-10-23");
    expect(sys.textContent).toContain("3.91 KB");
    expect(sys.textContent).toContain("200 MB");
    unmount();
  });

  test("vnstat 缺失：降级提示且不渲染系统账卡", async () => {
    installFetch((url) =>
      url.includes("/api/stats/traffic")
        ? { status: 200, body: { ...SNAP, system: { available: false, reason: "spawn vnstat ENOENT" } } }
        : { status: 404, body: {} },
    );
    const { root, unmount } = await mount();
    expect(byTestId(root, "traffic-system")).toBeNull();
    const msg = byTestId(root, "traffic-system-unavailable");
    expect(msg).not.toBeNull();
    expect(msg.textContent).toContain("ENOENT");
    unmount();
  });

  test("零流量空态：空表不渲染行，显示空态文案", async () => {
    installFetch((url) =>
      url.includes("/api/stats/traffic")
        ? { status: 200, body: { ...SNAP, endpoints: [] } }
        : { status: 404, body: {} },
    );
    const { root, unmount } = await mount();
    const table = byTestId(root, "traffic-endpoints");
    expect(table.querySelectorAll("[data-testid='traffic-endpoint-row']").length).toBe(0);
    expect(table.textContent).toContain("本日暂无请求记账");
    unmount();
  });

  test("刷新按钮：拉新快照数字移动", async () => {
    let calls = 0;
    installFetch((url) => {
      if (!url.includes("/api/stats/traffic")) return { status: 404, body: {} };
      calls += 1;
      return calls === 1
        ? { status: 200, body: SNAP }
        : { status: 200, body: { ...SNAP, endpoints: [{ ...SNAP.endpoints[1], requests: 99 }] } };
    });
    const { root, unmount } = await mount();
    const table = byTestId(root, "traffic-endpoints");
    expect(table.textContent).toContain("12");
    const btn = byTestId(root, "traffic-refresh");
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(table.textContent).toContain("99");
    unmount();
  });
});

describe("formatBytes 纯函数", () => {
  test("B/KB/MB/GB 进制与边界（零/负/超大）", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.00 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
    expect(formatBytes(2.9 * 1024 * 1024 * 1024)).toBe("2.90 GB");
    expect(formatBytes(1024 * 1024 * 100)).toBe("100 MB");
    expect(formatBytes(1024 ** 4 * 3)).toBe("3.00 TB");
  });

  test("toEndpointRows：SSE 单列连字符空态", () => {
    const rows = toEndpointRows([
      { endpoint: "/api/x", requests: 1, reqBytes: 10, resBytes: 20, sseConnections: 0, sseEvents: 0, sseBytes: 0 },
    ]);
    expect(rows[0].sse).toBe("—");
    expect(rows[0].uplink).toBe("10 B");
    expect(rows[0].downlink).toBe("20 B");
  });
});
