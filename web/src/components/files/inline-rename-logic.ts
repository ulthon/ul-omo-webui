// 行内重命名纯校验（files-ux-revamp 任务 9）：与 UI 分离，便于单测与宿主复用。
// trim 后为空、含 "/"、与原名相同三种畸形一律判非法（调用方静默取消，不发请求）。
/** 提交值校验：合法返回 trim 后名称；非法返回 null */
export function normalizeRenameValue(initial: string, raw: string): string | null {
  const value = raw.trim();
  if (!value || value.includes("/") || value === initial) return null;
  return value;
}
