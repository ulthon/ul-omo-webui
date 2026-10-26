// server ApiError code → 词典键全量映射（任务11）。
// 码清单采集：rg 'ApiError\(' server/src 全量字面量构造点提取（2026-10-20 实测 distinct
// 60 个，含 routes-project.ts 两处多行构造的 invalid_preferred_thinking_level 与
// invalid_permission_preset；编排口径 59 与实测差 1，以本清单与扫描测试为准）。
// 故意不入映射（未命中一律回退 err.message 原文，绝不显示键名）：
// - EngineAdapterError 直达码（http.ts toErrorResponse 原样序列化 code）：
//   bad_options / export_failed / media_not_found / no_active_session / open_failed /
//   timeout / unsupported
// - 客户端自造码（lib/api.ts）：network / unauthorized / unknown；服务端兜底码 internal
import { t } from "./i18n";
import type { MessageKey } from "./i18n";

/** ApiError code → errors.* 词典键；键集由 tests/i18n-errors.test.ts 对 server 扫描锁定 */
export const ERROR_CODE_KEYS: Record<string, MessageKey> = {
  already_compacted: "errors.alreadyCompacted",
  already_processing: "errors.alreadyProcessing",
  attachment_escape: "errors.attachmentEscape",
  attachment_expired: "errors.attachmentExpired",
  attachment_not_found: "errors.attachmentNotFound",
  attachment_too_large: "errors.attachmentTooLarge",
  compact_unsupported: "errors.compactUnsupported",
  compact_timeout: "errors.compactTimeout",
  content_too_large: "errors.contentTooLarge",
  cursor_invalid: "errors.cursorInvalid",
  engine_not_ready: "errors.engineNotReady",
  fork_cancelled: "errors.forkCancelled",
  fork_failed: "errors.forkFailed",
  git_error: "errors.gitError",
  image_attachment_failed: "errors.imageAttachmentFailed",
  invalid_archived: "errors.invalidArchived",
  extension_not_found: "errors.extensionNotFound",
  invalid_content: "errors.invalidContent",
  invalid_deleted: "errors.invalidDeleted",
  invalid_due: "errors.invalidDue",
  invalid_entry: "errors.invalidEntry",
  invalid_event: "errors.invalidEvent",
  invalid_enabled: "errors.invalidEnabled",
  invalid_kind: "errors.invalidKind",
  invalid_source: "errors.invalidSource",
  invalid_every: "errors.invalidEvery",
  invalid_hidden: "errors.invalidHidden",
  invalid_images: "errors.invalidImages",
  invalid_json: "errors.invalidJson",
  invalid_last_opened_at: "errors.invalidLastOpenedAt",
  invalid_limit: "errors.invalidLimit",
  invalid_model: "errors.invalidModel",
  invalid_name: "errors.invalidName",
  invalid_path: "errors.invalidPath",
  invalid_permission_preset: "errors.invalidPermissionPreset",
  invalid_pinned: "errors.invalidPinned",
  invalid_position: "errors.invalidPosition",
  invalid_preferred_model: "errors.invalidPreferredModel",
  invalid_preferred_thinking_level: "errors.invalidPreferredThinkingLevel",
  invalid_prompt: "errors.invalidPrompt",
  invalid_project: "errors.invalidProject",
  invalid_purge: "errors.invalidPurge",
  invalid_renamed_title: "errors.invalidRenamedTitle",
  invalid_request: "errors.invalidRequest",
  invalid_scope: "errors.invalidScope",
  invalid_session: "errors.invalidSession",
  invalid_settings: "errors.invalidSettings",
  invalid_snippets: "errors.invalidSnippets",
  invalid_streaming_behavior: "errors.invalidStreamingBehavior",
  invalid_tags: "errors.invalidTags",
  invalid_text: "errors.invalidText",
  invalid_thinking_level: "errors.invalidThinkingLevel",
  invalid_title: "errors.invalidTitle",
  memory_escape: "errors.memoryEscape",
  mkdir_failed: "errors.mkdirFailed",
  mkdir_forbidden: "errors.mkdirForbidden",
  no_project: "errors.noProject",
  not_a_directory: "errors.notADirectory",
  not_a_file: "errors.notAFile",
  not_a_git_repo: "errors.notAGitRepo",
  not_found: "errors.notFound",
  not_registered: "errors.notRegistered",
  not_started: "errors.notStarted",
  note_not_found: "errors.noteNotFound",
  nothing_to_compact: "errors.nothingToCompact",
  path_escape: "errors.pathEscape",
  project_not_found: "errors.projectNotFound",
  project_not_registered: "errors.projectNotRegistered",
  purge_requires_deleted: "errors.purgeRequiresDeleted",
  schedule_limit: "errors.scheduleLimit",
  schedule_runner_unavailable: "errors.scheduleRunnerUnavailable",
  session_not_found: "errors.sessionNotFound",
  session_not_persisted: "errors.sessionNotPersisted",
  snippet_conflict: "errors.snippetConflict",
  tag_conflict: "errors.tagConflict",
  tag_mount_conflict: "errors.tagMountConflict",
  title_gen_failed: "errors.titleGenFailed",
  title_gen_unavailable: "errors.titleGenUnavailable",
  unauthorized: "errors.unauthorized",
  version_not_found: "errors.versionNotFound",
  // 模型发现（docs08-2026-10-22 批次任务 23 后端新增 10 码）
  discover_bad_listing: "errors.discoverBadListing",
  discover_upstream_failed: "errors.discoverUpstreamFailed",
  invalid_baseurl: "errors.invalidBaseurl",
  invalid_import: "errors.invalidImport",
  invalid_provider: "errors.invalidProvider",
  models_invalid: "errors.modelsInvalid",
  models_unreadable: "errors.modelsUnreadable",
  models_write_failed: "errors.modelsWriteFailed",
  provider_not_compatible: "errors.providerNotCompatible",
  provider_not_found: "errors.providerNotFound",
};

/** ApiError 形状最小结构（结构化判定，不 import lib/api，避免 i18n ↔ api 模块环） */
interface ErrorWithCode {
  code?: unknown;
}

/** 错误 toast/行内文案统一入口（任务11）：
 * - err 为带 string code 的 Error（客户端 ApiError 形状）且 code 命中映射 → 当前语言词典文案；
 * - 未命中映射 → 保留 err.message 服务端原文（未知 code 绝不回退为键名）；
 * - 其余（无 code 的纯 Error、非 Error 抛出值、message 为空）→ 兜底键文案 t(fallbackKey)。
 * t() 为快照取词，供 toast/事件回调等非 React 场景；组件内语言切换重渲染由调用方
 * 后续触发的新 toast 自然吸收。 */
export function apiErrorMessage(err: unknown, fallbackKey: MessageKey): string {
  if (err instanceof Error) {
    const code = (err as Error & ErrorWithCode).code;
    if (typeof code === "string") {
      const mapped = ERROR_CODE_KEYS[code];
      if (mapped) return t(mapped);
      if (err.message) return err.message;
    }
  }
  return t(fallbackKey);
}
