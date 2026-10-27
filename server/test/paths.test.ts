// 路径校验单测：绝对性判定的平台正确性与包含性判定的纯逻辑。
// Linux 环境下 node:path 为 posix 实现：isAbsolute 只认 / 开头，盘符形态
// （D:\x）在 Linux 上必须被拒（否则会被 resolve 当相对路径落到 cwd 附近），
// win32 形态的完整验收依赖 Windows 端到端（QA 记录）。
import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRealpathInside,
  createProjectInput,
  insideBase,
  resolveInsideProject,
  resolveInsideProjectForWrite,
  validateProjectInput,
  WIN32_RESERVED_NAME_CHARS,
} from "../src/api/paths";
import { isAbsolute } from "node:path";

describe("validateProjectInput（绝对性 = 运行平台语义）", () => {
  test("POSIX 绝对路径照常接受（存在目录）", () => {
    const dir = mkdtempSync(join(tmpdir(), "paths-abs-"));
    try {
      expect(validateProjectInput(dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("相对路径拒绝：invalid_project", () => {
    expect(() => validateProjectInput("relative/path")).toThrowError(/绝对路径/);
  });

  test("win32 盘符形态在 posix 上拒绝（isAbsolute 平台正确，不当相对路径误处理）", () => {
    expect(isAbsolute("D:\\projects\\x")).toBe(false); // 运行平台锚点：posix
    expect(() => validateProjectInput("D:\\projects\\x")).toThrowError(/绝对路径/);
    expect(() => createProjectInput("D:\\projects\\x")).toThrowError(/绝对路径/);
  });

  test("不存在路径 → project_not_found", () => {
    expect(() => validateProjectInput("/definitely/not/exists-xyz")).toThrowError(/不存在/);
  });
});

describe("createProjectInput", () => {
  test("相对路径拒绝：invalid_project（不进入 mkdir 探测）", () => {
    expect(() => createProjectInput("rel/deep/path")).toThrowError(/绝对路径/);
  });
});

describe("insideBase（包含性判定纯逻辑，posix 语义）", () => {
  test("相等/内部/越界/前缀相似目录", () => {
    expect(insideBase("/data/proj", "/data/proj")).toBe(true);
    expect(insideBase("/data/proj", "/data/proj/sub")).toBe(true);
    expect(insideBase("/data/proj", "/data/proj-2")).toBe(false);
    expect(insideBase("/data/proj", "/data")).toBe(false);
  });

  test("根 base：一切绝对路径都在内（POSIX 单根）", () => {
    expect(insideBase("/", "/etc")).toBe(true);
  });
});

describe("resolveInsideProject（win 形态子路径在 posix 服务器上被中和为项目内相对路径）", () => {
  test("D:\\x 注入 → 拼在项目内，不算逃逸（绝对路径注入中和机制平台无关）", () => {
    const dir = mkdtempSync(join(tmpdir(), "paths-inject-"));
    try {
      const { path } = resolveInsideProject(dir, "D:\\x");
      expect(path.startsWith(`${dir}/`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("../ 逃逸 403 与符号链接逃逸 403 不回归；绝对路径注入被中和为项目内路径", () => {
    const dir = mkdtempSync(join(tmpdir(), "paths-escape-"));
    try {
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "f.txt"), "x");
      symlinkSync("/etc", join(dir, "out"));
      expect(() => resolveInsideProject(dir, "../x")).toThrowError(/逃逸/);
      // /etc 注入：./ 前缀中和为项目内路径（不逃逸；不存在 → real: null）
      const neutralized = resolveInsideProject(dir, "/etc");
      expect(neutralized.path).toBe(`${dir}/etc`);
      expect(neutralized.real).toBeNull();
      expect(() => resolveInsideProject(dir, "sub")).not.toThrow();
      expect(() => resolveInsideProject(dir, "out")).toThrowError(/逃逸/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- 写路径守卫矩阵（builtin-file-management 任务 3） ----------

/** 捕获 ApiError 的数据形状（跨模块实例不做 instanceof，只看字段；win32 块复用） */
function writeGuardError(fn: () => unknown): { status: number; code: string; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    return { status: e.status ?? -1, code: e.code ?? "none", message: e.message ?? "" };
  }
  throw new Error("预期抛出 ApiError，但未抛出");
}

function makeWriteFixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "plain.txt"), "x");
  return root;
}

describe("resolveInsideProjectForWrite（写路径四层守卫矩阵）", () => {
  test("合法新建路径：返回目标与最深已存在祖先（全缺失时回溯项目根）", () => {
    const root = makeWriteFixture("paths-w-ok-");
    try {
      const r1 = resolveInsideProjectForWrite(root, "docs/new-report.md");
      expect(r1.path).toBe(join(root, "docs/new-report.md"));
      expect(r1.existingAncestor).toBe(join(root, "docs"));
      const r2 = resolveInsideProjectForWrite(root, "a/b/c/deep.txt");
      expect(r2.path).toBe(join(root, "a/b/c/deep.txt"));
      expect(r2.existingAncestor).toBe(root);
      // r2 未真正建目录："a" 仍不存在，r3 独立重新走查后祖先回溯到项目根（无缓存漂移）
      const r3 = resolveInsideProjectForWrite(root, "a/deeper/file.txt");
      expect(r3.existingAncestor).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("../ 逃逸：403 path_escape（单级与多级）", () => {
    const root = makeWriteFixture("paths-w-esc-");
    try {
      const single = writeGuardError(() => resolveInsideProjectForWrite(root, "../x.txt"));
      expect(single.status).toBe(403);
      expect(single.code).toBe("path_escape");
      const multi = writeGuardError(() =>
        resolveInsideProjectForWrite(root, "docs/../../x.txt"),
      );
      expect(multi.status).toBe(403);
      expect(multi.code).toBe("path_escape");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("绝对路径注入：纯注入被中和为项目内路径；注入后借 .. 逃逸仍 403", () => {
    const root = makeWriteFixture("paths-w-inject-");
    try {
      // /etc/target.txt → ./ 前缀中和为项目内相对路径（与读面同语义）
      const neutralized = resolveInsideProjectForWrite(root, "/etc/target.txt");
      expect(neutralized.path).toBe(join(root, "etc/target.txt"));
      expect(neutralized.existingAncestor).toBe(root);
      // 中和后仍携带 ..，逃逸被拒
      const escape = writeGuardError(() =>
        resolveInsideProjectForWrite(root, "/../outside.txt"),
      );
      expect(escape.status).toBe(403);
      expect(escape.code).toBe("path_escape");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("中间目录符号链接（含悬空、含指向项目内）一律 403；最终段链接不归本层拦", () => {
    const root = makeWriteFixture("paths-w-sym-");
    try {
      symlinkSync("/etc", join(root, "out-link"));
      symlinkSync(join(root, "missing-target"), join(root, "dang-link"));
      symlinkSync(join(root, "docs"), join(root, "in-link"));
      for (const link of ["out-link", "dang-link", "in-link"]) {
        const err = writeGuardError(() =>
          resolveInsideProjectForWrite(root, `${link}/new.txt`),
        );
        expect(err.status).toBe(403);
        expect(err.code).toBe("path_escape");
      }
      // 最终段是符号链接：本层不 lstat 最终段（第 3 层 wx/O_EXCL 原语与第 4 层
      // assertRealpathInside 回查负责），守卫放行不误伤
      symlinkSync(join(root, "plain.txt"), join(root, "docs/final-link.md"));
      const r = resolveInsideProjectForWrite(root, "docs/final-link.md");
      expect(r.path).toBe(join(root, "docs/final-link.md"));
      expect(r.existingAncestor).toBe(join(root, "docs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("非法最终段：win32 保留字符全集/含 ../反斜杠 → 400 invalid_name", () => {
    const root = makeWriteFixture("paths-w-name-");
    try {
      // WIN32_RESERVED_NAME_CHARS 逐字符验证（机器可读常量，不用散文钉死）
      for (const ch of WIN32_RESERVED_NAME_CHARS) {
        const err = writeGuardError(() =>
          resolveInsideProjectForWrite(root, `docs/a${ch}b.txt`),
        );
        expect(err.status).toBe(400);
        expect(err.code).toBe("invalid_name");
      }
      // validateAttachmentName 口径的剩余两类：含 ".." 与反斜杠分隔符
      for (const name of ["a..b.txt", "a\\b.txt"]) {
        const err = writeGuardError(() =>
          resolveInsideProjectForWrite(root, `docs/${name}`),
        );
        expect(err.status).toBe(400);
        expect(err.code).toBe("invalid_name");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("非目录中间组件：400 not_a_directory", () => {
    const root = makeWriteFixture("paths-w-notdir-");
    try {
      const err = writeGuardError(() =>
        resolveInsideProjectForWrite(root, "plain.txt/child.txt"),
      );
      expect(err.status).toBe(400);
      expect(err.code).toBe("not_a_directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("输入形状：非字符串/NUL/超长/项目根本身 → 400 invalid_path", () => {
    const root = makeWriteFixture("paths-w-shape-");
    try {
      expect(writeGuardError(() => resolveInsideProjectForWrite(root, 123)).code).toBe(
        "invalid_path",
      );
      expect(writeGuardError(() => resolveInsideProjectForWrite(root, "a\0b")).code).toBe(
        "invalid_path",
      );
      expect(
        writeGuardError(() => resolveInsideProjectForWrite(root, "x".repeat(4097))).code,
      ).toBe("invalid_path");
      // ""/"." 经 resolve 退化为项目根本身，写守卫只面向具体条目
      expect(writeGuardError(() => resolveInsideProjectForWrite(root, "")).code).toBe(
        "invalid_path",
      );
      expect(writeGuardError(() => resolveInsideProjectForWrite(root, ".")).code).toBe(
        "invalid_path",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("assertRealpathInside（事后回查信号）", () => {
  test("项目内 ok；项目外 outside_project；不存在 realpath_failed；链接劫持出界", () => {
    const root = mkdtempSync(join(tmpdir(), "paths-w-assert-"));
    const outside = mkdtempSync(join(tmpdir(), "paths-w-assert-out-"));
    try {
      writeFileSync(join(root, "done.txt"), "x");
      writeFileSync(join(outside, "canary.txt"), "x");
      expect(assertRealpathInside(root, join(root, "done.txt"))).toEqual({
        ok: true,
        real: join(root, "done.txt"),
      });
      expect(assertRealpathInside(root, join(outside, "canary.txt"))).toEqual({
        ok: false,
        reason: "outside_project",
      });
      expect(assertRealpathInside(root, join(root, "no-such.md"))).toEqual({
        ok: false,
        reason: "realpath_failed",
      });
      // 项目内最终段符号链接劫持：realpath 归一后出界 → outside_project
      symlinkSync(join(outside, "canary.txt"), join(root, "hijack.md"));
      expect(assertRealpathInside(root, join(root, "hijack.md"))).toEqual({
        ok: false,
        reason: "outside_project",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("resolveInsideProjectForWrite win32 形态（vi.mock(“node:process”) 翻 platform，mock 级验证）", () => {
  // 说明：paths.ts 以全局 process.platform 在模块初始化时定格 IS_WIN，且本仓 CI 的
  // node:path 仍是 posix 实现——本块只证 win32 分支逻辑（分隔符切分、大小写不敏感
  // 包含判定）；win32 全量验收沿本文件头部口径以 Windows e2e 为准。
  test("混合分隔符 .. 段被拒 path_escape；insideBase 大小写不敏感", async () => {
    const realPlatform = process.platform;
    vi.doMock("node:process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:process")>();
      return { ...actual, platform: "win32" };
    });
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      vi.resetModules();
      const pathsWin = await import("../src/api/paths");
      // 大小写不敏感包含判定（posix 精确匹配下同参数为 false）
      expect(pathsWin.insideBase("/data/proj", "/data/PROJ/sub")).toBe(true);
      // win32 切分把 "/" 与 "\\" 都当分隔符：混合形态的 .. 段被第 0 层拦下
      const err = writeGuardError(() =>
        pathsWin.resolveInsideProjectForWrite("/data/proj", "docs\\..\\..\\x.txt"),
      );
      expect(err.status).toBe(403);
      expect(err.code).toBe("path_escape");
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
      vi.doUnmock("node:process");
      vi.resetModules();
    }
  });
});
