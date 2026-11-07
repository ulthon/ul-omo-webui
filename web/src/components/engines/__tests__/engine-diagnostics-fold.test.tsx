// @ts-nocheck
// 引擎监控折叠诊断区单测（engine-ux-visibility 任务 6）：默认收起+展开渲染各诊断
// 字段（CPU/IO/错误/RPC 队列）+ 回收历史 N 条含原因 + 空态。
// 环境惯例（restore-digest-expand / engine-status-bar 同款）：@happy-dom 全局注册 +
// createRoot+act 交互驱动（点击展开走真实 onClick），api 模块 mock 双接口；
// setup-locale preload 锁 zh-CN，断言中文原文（misleading_success 防护：断言具体
// 文本与 data-testid 节点在场，非「不抛错」）。
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 可变响应面：每用例按需覆写 metricsResult / reclaimsResult
let metricsResult = { engines: [] };
let reclaimsResult = { reclaims: [] };
const apiCalls = { metrics: 0, reclaims: 0 };

vi.mock("@/lib/api", () => ({
  api: {
    getEngineMetrics: () => {
      apiCalls.metrics += 1;
      return Promise.resolve(metricsResult);
    },
    getEngineReclaims: () => {
      apiCalls.reclaims += 1;
      return Promise.resolve(reclaimsResult);
    },
  },
  ApiError: class ApiError extends Error {},
}));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EngineDiagnosticsFold } = await import("../engine-diagnostics-fold");
const { formatBytes } = await import("@/components/file-tree/file-tree-logic");
const { relTime } = await import("@/components/notes/notes-logic");

/** 指标行最小可用面（字段全集对齐 api.ts EngineMetricsRow） */
function metricRow(overrides = {}) {
  return {
    projectPath: "/proj/a",
    sessionPath: "/proj/a/s1.jsonl",
    state: "ready",
    pid: 100,
    rssBytes: 40960,
    treeRssBytes: 176128,
    childCount: 3,
    cpuPct: 37.5,
    cpuTotalMs: 8400,
    ioBytes: { readBytes: 4096, writeBytes: 2048 },
    startedAt: 1,
    startupMs: 4200,
    lastStartupMs: 4200,
    uptimeMs: 1000,
    boundSession: null,
    workerRestartCount: 1,
    rpcQueueDepth: 2,
    recentErrors: [
      { t: "2026-11-07T00:00:00.000Z", ev: "probe_gate", detail: "attempt=3" },
      { t: "2026-11-07T00:01:00.000Z", ev: "warmup_fail", detail: "reason=timeout" },
    ],
    ...overrides,
  };
}

const roots = [];
function mount(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(createElement(EngineDiagnosticsFold));
  });
  return host;
}

async function clickToggle(host: HTMLElement): Promise<void> {
  await act(async () => {
    host.querySelector('[data-testid="engine-diagnostics-fold-toggle"]').dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
  });
}

beforeEach(() => {
  metricsResult = { engines: [] };
  reclaimsResult = { reclaims: [] };
  apiCalls.metrics = 0;
  apiCalls.reclaims = 0;
});

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    act(() => {
      root.unmount();
    });
  }
});

describe("引擎折叠诊断区（任务 6）", () => {
  test("(a) 默认收起：无正文节点，且零请求（折叠默认不采样）", () => {
    const host = mount();
    const html = host.innerHTML;
    expect(html).toContain('aria-expanded="false"');
    expect(host.querySelector('[data-testid="engine-diagnostics-fold-body"]')).toBeNull();
    expect(apiCalls.metrics).toBe(0);
    expect(apiCalls.reclaims).toBe(0);
  });

  test("(b) 展开渲染各诊断字段：CPU 瞬时+累计 / IO 读写 / RPC 队列 / 错误计数+尾行", async () => {
    metricsResult = {
      engines: [
        metricRow(),
        // 第二行进程指标不可得：null 字段落「—」，零错误显示「0 条 · 无近期错误」
        metricRow({
          sessionPath: "/proj/a/s2.jsonl",
          state: "starting",
          cpuPct: null,
          cpuTotalMs: null,
          ioBytes: null,
          rpcQueueDepth: 0,
          recentErrors: [],
        }),
      ],
    };
    reclaimsResult = { reclaims: [] };
    const host = mount();
    await clickToggle(host);
    const html = host.innerHTML;
    expect(html).toContain('aria-expanded="true"');
    expect(host.querySelectorAll('[data-testid="engine-diagnostics-engine"]')).toHaveLength(2);
    // CPU：37.5% + 累计 8.4s；null 行落 —
    expect(host.querySelector('[data-testid="engine-diag-cpu"]').textContent).toContain("37.5%");
    expect(host.querySelector('[data-testid="engine-diag-cpu"]').textContent).toContain("8.4s");
    expect(host.querySelectorAll('[data-testid="engine-diag-cpu"]')[1].textContent).toContain("—");
    // IO：读 4.0 KB / 写 2.0 KB（formatBytes 同源断言）；null 行落 —
    const io = host.querySelector('[data-testid="engine-diag-io"]').textContent;
    expect(io).toContain(formatBytes(4096));
    expect(io).toContain(formatBytes(2048));
    expect(host.querySelectorAll('[data-testid="engine-diag-io"]')[1].textContent).toContain("—");
    // RPC 队列深度
    expect(host.querySelector('[data-testid="engine-diag-rpc"]').textContent).toContain("2");
    // 最近错误：2 条 + 尾行
    expect(host.querySelector('[data-testid="engine-diag-errors"]').textContent).toContain("2 条");
    expect(host.querySelectorAll('[data-testid="engine-diag-error-line"]')).toHaveLength(2);
    expect(host.querySelector('[data-testid="engine-diag-error-line"]').textContent).toContain("probe_gate");
    expect(host.querySelector('[data-testid="engine-diag-error-line"]').textContent).toContain("attempt=3");
    // 第二行零错误空态
    expect(host.querySelectorAll('[data-testid="engine-diag-errors"]')[1].textContent).toContain("0 条");
    expect(host.querySelectorAll('[data-testid="engine-diag-errors"]')[1].textContent).toContain("无近期错误");
  });

  test("(c) 回收历史渲染 N 条含原因（时间走 relTime 同源断言）", async () => {
    const at = Date.now() - 5 * 60_000;
    metricsResult = { engines: [metricRow({ recentErrors: [] })] };
    reclaimsResult = {
      reclaims: [
        { at, sessionPath: "/proj/a/s1.jsonl", reason: "idle_timeout" },
        { at: at - 60_000, sessionPath: "/proj/b/s2.jsonl", reason: "activity_window" },
      ],
    };
    const host = mount();
    await clickToggle(host);
    const entries = host.querySelectorAll('[data-testid="engine-diag-reclaim-entry"]');
    expect(entries).toHaveLength(2);
    const html = host.innerHTML;
    expect(html).toContain("空闲超时回收");
    expect(html).toContain("探活窗回收");
    // 时间列与 relTime 同源（相对时间档）；会话列取基名
    expect(entries[0].textContent).toContain(relTime(new Date(at).toISOString()));
    expect(entries[0].textContent).toContain("s1");
  });

  test("(d) 空态：无引擎 + 无回收记录", async () => {
    metricsResult = { engines: [] };
    reclaimsResult = { reclaims: [] };
    const host = mount();
    await clickToggle(host);
    expect(host.querySelector('[data-testid="engine-diagnostics-no-engines"]').textContent).toBe("当前无引擎运行");
    expect(host.querySelector('[data-testid="engine-diag-reclaims-empty"]').textContent).toBe("暂无回收记录");
  });

  test("(e) 再点收起：正文隐藏", async () => {
    metricsResult = { engines: [metricRow()] };
    const host = mount();
    await clickToggle(host);
    expect(host.querySelector('[data-testid="engine-diagnostics-fold-body"]')).not.toBeNull();
    await clickToggle(host);
    expect(host.querySelector('[data-testid="engine-diagnostics-fold-body"]')).toBeNull();
    expect(host.innerHTML).toContain('aria-expanded="false"');
  });
});
