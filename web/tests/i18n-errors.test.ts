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
// docs08-2026-10-22 批次任务 21（schedule 后端）追加 8 码：invalid_due/invalid_event/
// invalid_every/invalid_prompt/invalid_session/schedule_limit/schedule_runner_unavailable/
// docs08-2026-10-22 批次任务 23（模型发现后端）追加 10 码：discover_bad_listing/
// discover_upstream_failed/invalid_baseurl/invalid_import/invalid_provider/models_invalid/
// models_unreadable/models_write_failed/provider_not_compatible/provider_not_found；docs08-2026-10-22 批次任务 24（扩展资源面）
// 追加 4 码：extension_not_found/invalid_enabled/invalid_kind/invalid_source，合计 84。
// docs08-2026-10-23/24 批次 t17（附件双通道）追加 2 码：attachment_expired/
// attachment_too_large（前端映射由任务 18 补齐），合计 86。docs08-2026-10-23/24 批次
// 任务 19 追加 1 码：image_attachment_failed，合计 87。r9 2026-10-26 批次任务 1
// （标签定义整替冲突防护）追加 1 码：tag_conflict，合计 88。r9 2026-10-26 批次
// F1-B1（常用语整替 + 会话标签挂载整替冲突防护）追加 2 码：snippet_conflict/
// tag_mount_conflict，合计 90。内置文件管理（routes-fs-write）追加 7 码：
// copy_failed/engine_busy/exists/target_exists/kind_mismatch/root_not_deletable/
// insufficient_storage，合计 97。内置文件管理任务 5（上传下载端点）追加 1 码：
// upload_too_large，合计 98。内置文件管理任务 9（保存端点）追加 1 码：file_changed
// （409 携带 mtimeNs/size 兄弟字段，c.json 直构非 ApiError 构造，路由注释内以
// ApiError(409, "file_changed", …) 形式留痕供扫描），合计 99。r10 2026-10-27 批次
// 任务 18（会话 rebind）追加 4 码：invalid_old_path/invalid_session_ids/
// old_store_not_found/rebind_conflict，合计 103。
const SCANNED_CODES = [
  "already_compacted",
  "already_processing",
  "attachment_escape",
  "attachment_expired",
  "attachment_not_found",
  "attachment_too_large",
  "compact_timeout",
  "compact_unsupported",
  "content_too_large",
  "copy_failed",
  "cursor_invalid",
  "discover_bad_listing",
  "discover_upstream_failed",
  "engine_busy",
  "engine_not_ready",
  "exists",
  "extension_not_found",
  "file_changed",
  "fork_cancelled",
  "fork_failed",
  "git_error",
  "image_attachment_failed",
  "insufficient_storage",
  "invalid_archived",
  "invalid_baseurl",
  "invalid_content",
  "invalid_deleted",
  "invalid_due",
  "invalid_enabled",
  "invalid_entry",
  "invalid_event",
  "invalid_every",
  "invalid_hidden",
  "invalid_images",
  "invalid_import",
  "invalid_json",
  "invalid_kind",
  "invalid_last_opened_at",
  "invalid_limit",
  "invalid_model",
  "invalid_name",
  "invalid_old_path",
  "invalid_path",
  "invalid_permission_preset",
  "invalid_pinned",
  "invalid_position",
  "invalid_preferred_model",
  "invalid_preferred_thinking_level",
  "invalid_project",
  "invalid_prompt",
  "invalid_provider",
  "invalid_purge",
  "invalid_renamed_title",
  "invalid_request",
  "invalid_scope",
  "invalid_session",
  "invalid_session_ids",
  "invalid_settings",
  "invalid_snippets",
  "invalid_source",
  "invalid_streaming_behavior",
  "invalid_tags",
  "invalid_text",
  "invalid_thinking_level",
  "invalid_title",
  "kind_mismatch",
  "memory_escape",
  "mkdir_failed",
  "mkdir_forbidden",
  "models_invalid",
  "models_unreadable",
  "models_write_failed",
  "no_project",
  "not_a_directory",
  "not_a_file",
  "not_a_git_repo",
  "not_found",
  "not_registered",
  "not_started",
  "note_not_found",
  "nothing_to_compact",
  "old_store_not_found",
  "path_escape",
  "project_not_found",
  "project_not_registered",
  "provider_not_compatible",
  "provider_not_found",
  "purge_requires_deleted",
  "rebind_conflict",
  "root_not_deletable",
  "schedule_limit",
  "schedule_runner_unavailable",
  "session_not_found",
  "session_not_persisted",
  "snippet_conflict",
  "tag_conflict",
  "tag_mount_conflict",
  "target_exists",
  "title_gen_failed",
  "title_gen_unavailable",
  "unauthorized",
  "upload_too_large",
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
 * 不影响 distinct 集合（与 tests/i18n.test.ts 的源码扫描断言同款思路）。
 * 生成物排除：static-assets.generated.ts（根构建内嵌 web 产物）里的压缩前端代码
 * 同样含 ApiError 字面量（如客户端 network/unauthorized），但那是 web 侧构造非 server
 * 码——凡 *.generated.ts 一律跳过（任务 22 实证：根构建后该文件入扫致计数漂移）。 */
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
      if (name.endsWith(".generated.ts")) continue; // 根构建生成物（内嵌 web 产物），见上注
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
  test("映射恰好覆盖 server 扫描集（103 个：活扫 == 留痕清单 == 映射键集，含计数断言）", () => {
    const scanned = scanServerCodes();
    expect(scanned).toEqual(SCANNED_CODES);
    expect(scanned).toHaveLength(103);
    expect(Object.keys(ERROR_CODE_KEYS).sort()).toEqual(scanned);
    expect(Object.keys(ERROR_CODE_KEYS)).toHaveLength(103);
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
