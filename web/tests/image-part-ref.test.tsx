/**
 * ImagePart 双形态渲染单测（docs08 2026-10-23/24 批次任务 19 历史引用化）：
 * - legacy：内联 base64 part 原样渲染（旧会话兼容不破）
 * - ref：引用形态 part 经 GET /api/sessions/:id/attachments?path= 按需取字节 → objectURL 渲染
 * - ref 取回失败（410 过期/网络错）→ 过期占位提示，不抛错不阻塞
 * 环境说明同 compaction-live-mount.test.tsx（happy-dom + createRoot + act）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { ImagePart } = await import("@/components/chat/image-lightbox");

const SID = "img-ref-qa";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let container: HTMLElement;
let root: ReturnType<typeof createRoot> | null = null;
const fetchMock = vi.fn();

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
  delete (globalThis as { fetch?: unknown }).fetch;
});

async function mountPart(part: Record<string, unknown>, sessionId?: string): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(ImagePart, { part: part as never, sessionId }));
  });
  // flush 微任务（fetch promise 链）
  await act(async () => {});
}

function renderedImg(): HTMLImageElement | null {
  return container.querySelector("img");
}

describe("ImagePart 双形态（任务 19）", () => {
  test("legacy：内联 base64 part 原样渲染 data: src，零网络请求", async () => {
    await mountPart({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
    const img = renderedImg();
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("ref：按需 GET 附件服务取字节 → objectURL 渲染", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array(Buffer.from(PNG_BASE64, "base64")), { status: 200 }),
    );
    await mountPart(
      { type: "image", ref: { path: "/data/attachments/ab/img-0123456789abcdef.png", name: "img-0123456789abcdef.png" }, mimeType: "image/png" },
      SID,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/sessions/${SID}/attachments?path=${encodeURIComponent("/data/attachments/ab/img-0123456789abcdef.png")}`,
    );
    const img = renderedImg();
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toMatch(/^blob:/);
  });

  test("ref 失败（410 过期）→ 过期占位提示，不渲染 img 不抛错", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "attachment_expired", message: "x" } }), {
        status: 410,
        headers: { "content-type": "application/json" },
      }),
    );
    await mountPart(
      { type: "image", ref: { path: "/data/attachments/ab/gone.png", name: "gone.png" }, mimeType: "image/png" },
      SID,
    );
    expect(container.textContent).toContain("图片附件已过期或不可用");
    expect(renderedImg()).toBeNull();
  });

  test("ref 但无 sessionId（渲染面缺上下文）→ 不发请求不出占位（静默空）", async () => {
    await mountPart({ type: "image", ref: { path: "/x/y.png", name: "y.png" }, mimeType: "image/png" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(renderedImg()).toBeNull();
  });
});
