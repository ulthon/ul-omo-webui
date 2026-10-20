// 任务11 错误码映射测试：映射表与 server 扫描集严格一致（计数断言 + 留痕清单比对）、
// 命中出双语词典文案、未知/缺失 code 回退原文或兜底键、绝不显示键名。
// 全部断言为静态结构与纯函数行为，无时间/随机/网络因素，按构造无抖动。
import { describe, expect, test, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError } from "@/lib/api";
import { apiErrorMessage, ERROR_CODE_KEYS } from "@/i18n/errors";
import { useLocaleStore } from "@/i18n/i18n";
import { zh } from "@/i18n/zh";
import { en } from "@/i18n/en";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SRC = path.resolve(WEB_ROOT, "..", "server", "src");

// 2026-10-20 扫描留痕：rg 'ApiError\(' server/src 全量字面量构造点的 distinct code，
// 实测 60 个（编排口述 59 与实测差 1，含 routes-project.ts 两处多行构造；以本清单为准）。
const SCANNED_CODES = [
  "already_compacted",
  "already_processing",
  "attachment_escape",
  "attachment_not_found",
  "compact_unsupported",
  "content_too_large",
  "engine_not_ready",
  "fork_cancelled",
  "fork_failed",
  "git_error",
  "invalid_archived",
  "invalid_content",
  "invalid_deleted",
  "invalid_entry",
  "invalid_hidden",
  "invalid_images",
  "invalid_json",
  "invalid_last_opened_at",
  "invalid_limit",
  "invalid_model",
  "invalid_name",
  "invalid_path",
  "invalid_permission_preset",
  "invalid_pinned",
  "invalid_position",
  "invalid_preferred_model",
  "invalid_preferred_thinking_level",
  "invalid_project",
  "invalid_purge",
  "invalid_renamed_title",
  "invalid_request",
  "invalid_scope",
  "invalid_settings",
  "invalid_snippets",
  "invalid_streaming_behavior",
  "invalid_tags",
  "invalid_text",
  "invalid_thinking_level",
  "invalid_title",
  "memory_escape",
  "mkdir_failed",
  "mkdir_forbidden",
  "no_project",
  "not_a_directory",
  "not_a_file",
  "not_a_git_repo",
  "not_found",
  "not_registered",
  "not_started",
  "note_not_found",
  "nothing_to_compact",
  "path_escape",
  "project_not_found",
  "project_not_registered",
  "purge_requires_deleted",
  "session_not_found",
  "session_not_persisted",
  "title_gen_failed",
  "title_gen_unavailable",
  "version_not_found",
];

type Catalog = Record<string, unknown>;

/** 按点分路径取目录叶子值（与 i18n.ts pick 同规则；测试本地实现，不依赖内部导出） */
function leafAt(root: Catalog, keyPath: string): string {
  let node: unknown = root;
  for (const part of keyPath.split(".")) {
    if (typeof node !== "object" || node === null) throw new Error(`缺键: ${keyPath}`);
    node = (node as Catalog)[part];
  }
  if (typeof node !== "string") throw new Error(`非字符串词条: ${keyPath}`);
  return node;
}

/** 活扫 server/src：提取全部 ApiError(status, "code", ...) 字面量构造的 distinct code。
 * \s* 跨行覆盖多行构造；注释中的 ApiError(...) 同形命中——仓库注释只复述真实构造码，
 * 不影响 distinct 集合（与 tests/i18n.test.ts 的源码扫描断言同款思路）。 */
function scanServerCodes(): string[] {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".ts")) continue;
      const text = fs.readFileSync(full, "utf8");
      for (const m of text.matchAll(/ApiError\(\s*\d+\s*,\s*"([a-z0-9_]+)"/g)) out.add(m[1]);
    }
  };
  walk(SERVER_SRC);
  return [...out].sort();
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "zh-CN" });
});

describe("任务11 ApiError code → 词典键映射", () => {
  test("映射恰好覆盖 server 扫描集（60 个：活扫 == 留痕清单 == 映射键集，含计数断言）", () => {
    const scanned = scanServerCodes();
    expect(scanned).toEqual(SCANNED_CODES);
    expect(scanned).toHaveLength(60);
    expect(Object.keys(ERROR_CODE_KEYS).sort()).toEqual(scanned);
    expect(Object.keys(ERROR_CODE_KEYS)).toHaveLength(60);
  });

  test("每个映射键在 zh/en 双语目录均存在且为非空字符串", () => {
    for (const key of Object.values(ERROR_CODE_KEYS)) {
      expect(leafAt(zh as Catalog, key).length).toBeGreaterThan(0);
      expect(leafAt(en as Catalog, key).length).toBeGreaterThan(0);
    }
  });

  test("命中码：zh 输出词典文案（非服务端原文）", () => {
    const err = new ApiError(400, "invalid_json", "请求体必须是合法 JSON");
    expect(apiErrorMessage(err, "notes.actionFailed")).toBe(leafAt(zh as Catalog, "errors.invalidJson"));
    expect(apiErrorMessage(err, "notes.actionFailed")).not.toBe("请求体必须是合法 JSON");
  });

  test("命中码：en 档输出英文词典文案", () => {
    useLocaleStore.setState({ locale: "en" });
    const err = new ApiError(503, "engine_not_ready", "项目引擎未就绪");
    expect(apiErrorMessage(err, "notes.actionFailed")).toBe(leafAt(en as Catalog, "errors.engineNotReady"));
  });

  test("未知码：回退服务端原文，绝不显示键名", () => {
    const err = new ApiError(500, "future_unknown_code", "服务端未来新增的原始消息");
    expect(apiErrorMessage(err, "notes.actionFailed")).toBe("服务端未来新增的原始消息");
    expect(apiErrorMessage(err, "notes.actionFailed")).not.toContain("errors.");
    expect(apiErrorMessage(err, "notes.actionFailed")).not.toContain("notes.actionFailed");
  });

  test("缺失 code 的纯 Error：走兜底键文案", () => {
    const err = new Error("纯前端错误");
    expect(apiErrorMessage(err, "notes.actionFailed")).toBe("操作失败");
  });

  test("非 Error 抛出值：走兜底键文案", () => {
    expect(apiErrorMessage("boom", "notes.actionFailed")).toBe("操作失败");
  });
});
