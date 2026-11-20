// highlight worker 组合单测（files-ux-revamp F3 缺陷 6 回归锁）。worker 模块在本测试
// 的 happy-dom 环境里以 self/window 为 worker 作用域真实运行：happy-dom 的 Response
// 没有 bytes()，与旧 Chromium（同样缺 Response.bytes）同构，精确复刻 oniguruma wasm
// 内嵌加载链路的故障面（DecompressionStream → Response.bytes 缺失 → 引擎创建抛
// TypeError → codeToHtml 全语言降级 null）。回归语义：
// - 支持的语言必须产出含 shiki 标记的高亮 HTML（不可静默降级）；
// - 未知语言返回 null（纯文本兜底仅留给真正不支持的语言）。
import { describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

type WorkerScope = {
  onmessage: ((ev: { data: { id: number; code: string; lang: string } }) => Promise<void>) | null;
  postMessage: (message: { id: number; html: string | null }) => void;
};

/** 以受控 postMessage 收件箱运行 worker 顶层的 onmessage 注册 */
async function withWorkerInbox(): Promise<{
  send: (req: { id: number; code: string; lang: string }) => Promise<void>;
  inbox: Array<{ id: number; html: string | null }>;
}> {
  const mod = await import("@/workers/highlight.worker");
  void mod;
  const scope = self as unknown as WorkerScope;
  expect(scope.onmessage, "worker 顶层应已注册 onmessage").toBeTruthy();
  const inbox: Array<{ id: number; html: string | null }> = [];
  scope.postMessage = (message) => {
    inbox.push(message);
  };
  return {
    inbox,
    send: async (req) => {
      await scope.onmessage!({ data: req });
    },
  };
}

describe("highlight worker（F3 缺陷 6：构建产物全语言 html:null 回归锁）", () => {
  test("支持语言产出高亮 HTML，不因引擎加载链路静默降级", async () => {
    const { send, inbox } = await withWorkerInbox();
    await send({ id: 1, code: "const a = 1;", lang: "tsx" });
    expect(inbox).toEqual([{ id: 1, html: expect.any(String) }]);
    expect(inbox[0].html).toContain("shiki");
    expect(inbox[0].html).toContain("<span");
  });

  test("未知语言返回 null（纯文本兜底仅留给真正不支持的语言）", async () => {
    const { send, inbox } = await withWorkerInbox();
    await send({ id: 1, code: "plain", lang: "not-a-real-lang" });
    expect(inbox).toEqual([{ id: 1, html: null }]);
  });
});
