// 编辑资格纯函数模块（从 file-editor.tsx 移出，供宿主 files.tsx 与测试复用；
// 避免在组件文件中混合导出非组件内容）。
import type { FsFileResponse } from "@/lib/api";

/** 编辑资格大小上限（对齐 server/src/api/routes-fs.ts FILE_MAX_BYTES） */
export const FILE_EDIT_MAX_BYTES = 2 * 1024 * 1024;

/** 编辑资格三条件（计划口径）：2MB 内、未截断、非二进制 */
export function isEditableFile(data: Pick<FsFileResponse, "size" | "truncated" | "binary">): boolean {
  return data.size <= FILE_EDIT_MAX_BYTES && !data.truncated && !data.binary;
}

/** 不可编辑原因词条键（binary 优先——二进制时 size/truncated 不构成真实障碍） */
export function editBlockReasonKey(
  data: Pick<FsFileResponse, "size" | "truncated" | "binary">,
): "files.edit.reasonBinary" | "files.edit.reasonTruncated" | "files.edit.reasonTooLarge" {
  if (data.binary) return "files.edit.reasonBinary";
  if (data.truncated) return "files.edit.reasonTruncated";
  return "files.edit.reasonTooLarge";
}
