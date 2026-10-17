// 路径校验单测：绝对性判定的平台正确性与包含性判定的纯逻辑。
// Linux 环境下 node:path 为 posix 实现：isAbsolute 只认 / 开头，盘符形态
// （D:\x）在 Linux 上必须被拒（否则会被 resolve 当相对路径落到 cwd 附近），
// win32 形态的完整验收依赖 Windows 端到端（QA 记录）。
import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectInput, insideBase, resolveInsideProject, validateProjectInput } from "../src/api/paths";
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
