// @ts-nocheck
// FilePreview 增强（files-ux-revamp 任务 11）：Shiki 高亮降级、图片灯箱、git 状态角标与缓存。
// 惯例同 files-ops.test.tsx：@happy-dom 全局注册 + createRoot/act 真实点击 + recording fetch。
// mock 缝隙选择：stub @/lib/highlight-client（highlight-client 对 worker 的单例封装在 happy-dom
// 下不可控，模块级 stub 是最小侵入缝隙，协议本身不动）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { mockHighlight } = vi.hoisted(() => ({ mockHighlight: vi.fn() }));
vi.mock("@/lib/highlight-client", () => ({ highlight: mockHighlight }));

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FilePreview } = await import("@/components/file-tree/file-preview");
const { gitBadgeInfo, invalidateGitStatusCache } = await import("@/components/file-tree/preview-git-badge");

const ORIGINAL_FETCH = globalThis.fetch;

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function errJson(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } });
}

const GIT_ENTRIES = [
  { status: "M ", path: "src/modified.ts" },
  { status: "A ", path: "src/added.ts" },
  { status: "??", path: "untracked.txt" },
  { status: "D ", path: "old/deleted.js" },
  { status: "R ", path: "renamed.go" },
];

let gitStatusCalls: string[] = [];

function installFetch(opts: { gitStatusStatus?: number } = {}): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/git/status")) {
      gitStatusCalls.push(url);
      if (opts.gitStatusStatus !== undefined) return errJson(opts.gitStatusStatus, "not_a_git_repo", "目录不是 git 仓库");
      return okJson({ project: new URL(url, "http://localhost").searchParams.get("project"), entries: GIT_ENTRIES, raw: "" });
    }
    if (url.includes("/api/fs/file")) {
      const qs = new URL(url, "http://localhost").searchParams;
      const path = qs.get("path") ?? "";
      const fixture = FS_FILES[path];
      if (!fixture) return errJson(404, "not_found", `文件不存在：${path}`);
      return okJson(fixture);
    }
    return errJson(404, "not_found", url);
  }) as typeof fetch;
}

interface FsFileFixture {
  project: string;
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string | null;
  mtime: number;
}

const baseFile: Omit<FsFileFixture, "path" | "content"> = {
  project: "/data/proj-a",
  size: 12,
  binary: false,
  truncated: false,
  mtime: 1700000000000,
};

const FS_FILES: Record<string, FsFileFixture> = {
  "src/modified.ts": { ...baseFile, path: "src/modified.ts", content: "const a = 1;\n" },
  "src/plain.ts": { ...baseFile, path: "src/plain.ts", content: "const b = 2;\n" },
  "src/added.ts": { ...baseFile, path: "src/added.ts", content: "const c = 3;\n" },
  "src/huge.ts": { ...baseFile, path: "src/huge.ts", content: "const d = 4;\n", truncated: true },
  "photo.png": { ...baseFile, path: "photo.png", content: null, binary: true, size: 2048 },
  "icon.svg": { ...baseFile, path: "icon.svg", content: '<svg xmlns="http://www.w3.org/2000/svg"/>', size: 48 },
};

function mountFile(path: string, props: { enableImageInline?: boolean } = {}): { root: ReturnType<typeof createRoot>; host: HTMLDivElement; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const el = createElement(FilePreview, { project: "/data/proj-a", path, ...props });
  act(() => {
    root.render(el);
  });
  return { root, host, unmount: () => act(() => root.unmount()) };
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

beforeEach(() => {
  installFetch();
  gitStatusCalls = [];
  mockHighlight.mockReset().mockResolvedValue(null);
  invalidateGitStatusCache();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("gitBadgeInfo 纯函数", () => {
  test("XY 各类别映射", () => {
    expect(gitBadgeInfo("M ")).toEqual({ letter: "M", tone: "amber" });
    expect(gitBadgeInfo(" M")).toEqual({ letter: "M", tone: "amber" });
    expect(gitBadgeInfo("A ")).toEqual({ letter: "A", tone: "emerald" });
    expect(gitBadgeInfo("??")).toEqual({ letter: "?", tone: "emerald" });
    expect(gitBadgeInfo("D ")).toEqual({ letter: "D", tone: "red" });
    expect(gitBadgeInfo("R ")).toEqual({ letter: "R", tone: "blue" });
    expect(gitBadgeInfo("  ")).toEqual({ letter: "", tone: "gray" });
    expect(gitBadgeInfo("MM")).toEqual({ letter: "M", tone: "amber" });
    expect(gitBadgeInfo("U ")).toEqual({ letter: "U", tone: "emerald" });
  });
});

describe("FilePreview 预览增强", () => {
  test("1. 文本文件：worker 返回 html 时 preview-text 内渲染高亮 html", async () => {
    mockHighlight.mockResolvedValue('<span class="shiki">const a = 1;</span>');
    const { host, unmount } = mountFile("src/modified.ts");
    await settle();
    const pre = host.querySelector('[data-testid="preview-text"]');
    expect(pre).not.toBeNull();
    expect(pre.innerHTML).toContain("shiki");
    expect(mockHighlight).toHaveBeenCalledWith("const a = 1;\n", "typescript");
    unmount();
  });

  test("2. worker 返回 null：纯文本 pre 保留原始内容", async () => {
    mockHighlight.mockResolvedValue(null);
    const { host, unmount } = mountFile("src/plain.ts");
    await settle();
    const pre = host.querySelector('[data-testid="preview-text"]');
    expect(pre.innerHTML).not.toContain("shiki");
    expect(pre.textContent).toBe("const b = 2;\n");
    unmount();
  });

  test("3. 截断文件：不进 worker，纯文本", async () => {
    const { host, unmount } = mountFile("src/huge.ts");
    await settle();
    expect(mockHighlight).not.toHaveBeenCalled();
    const pre = host.querySelector('[data-testid="preview-text"]');
    expect(pre.textContent).toBe("const d = 4;\n");
    unmount();
  });

  test("4. 位图内联点击开灯箱；点击遮罩/Esc 关闭", async () => {
    const { host, unmount } = mountFile("photo.png", { enableImageInline: true });
    await settle();
    const img = host.querySelector('[data-testid="preview-image"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(host.querySelector('[data-testid="preview-lightbox"]')).toBeNull();
    act(() => {
      img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    let box = host.querySelector('[data-testid="preview-lightbox"]') as HTMLDivElement;
    expect(box).not.toBeNull();
    const boxImg = box.querySelector("img") as HTMLImageElement;
    expect(boxImg.src).toBe(img.src);
    act(() => {
      box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="preview-lightbox"]')).toBeNull();
    act(() => {
      img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="preview-lightbox"]')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(host.querySelector('[data-testid="preview-lightbox"]')).toBeNull();
    unmount();
  });

  test("5. svg data URL 分支点击同样开灯箱", async () => {
    const { host, unmount } = mountFile("icon.svg");
    await settle();
    const img = host.querySelector('[data-testid="preview-image"]') as HTMLImageElement;
    expect(img.src.startsWith("data:image/svg+xml;base64,")).toBe(true);
    act(() => {
      img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="preview-lightbox"]')).not.toBeNull();
    unmount();
  });

  test("6. git 状态角标：有映射的文件渲染正确字母/色调，无映射不渲染", async () => {
    const { host, unmount } = mountFile("src/modified.ts");
    await settle();
    const badge = host.querySelector('[data-testid="preview-git-badge"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe("M");
    expect(badge.className).toContain("amber");
    expect(badge.title).toContain("修改");
    unmount();

    const { host: host2, unmount: unmount2 } = mountFile("src/plain.ts");
    await settle();
    expect(host2.querySelector('[data-testid="preview-git-badge"]')).toBeNull();
    unmount2();
  });

  test("7. 非 git 项目：无角标、预览正文照常；换文件零第二次 gitStatus 请求", async () => {
    installFetch({ gitStatusStatus: 409 });
    const { host, unmount } = mountFile("src/plain.ts");
    await settle();
    expect(host.querySelector('[data-testid="preview-git-badge"]')).toBeNull();
    expect(host.querySelector('[data-testid="preview-text"]').textContent).toBe("const b = 2;\n");
    unmount();

    const { unmount: unmount2 } = mountFile("src/modified.ts");
    await settle();
    expect(gitStatusCalls).toHaveLength(1);
    unmount2();
  });

  test("8. invalidateGitStatusCache 后下一次挂载重新请求", async () => {
    installFetch({ gitStatusStatus: 409 });
    const { unmount } = mountFile("src/plain.ts");
    await settle();
    expect(gitStatusCalls).toHaveLength(1);
    unmount();

    invalidateGitStatusCache();
    const { unmount: unmount2 } = mountFile("src/modified.ts");
    await settle();
    expect(gitStatusCalls).toHaveLength(2);
    unmount2();
  });
});
