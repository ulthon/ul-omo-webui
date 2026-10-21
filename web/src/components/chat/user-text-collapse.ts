// user 长文本折叠阈值（docs08-r6 任务 14）。独立叶模块——message-bubble 组件文件保持
// 仅导出组件（fast-refresh lint 口径），单测直接驱动本模块。
const USER_TEXT_CHARS_PER_LINE = 40;
const USER_TEXT_MAX_LINES = 3;

/** user 文本估算行数是否超过折叠阈值（导出仅供测试） */
export function isLongUserText(text: string): boolean {
  let lines = 0;
  for (const seg of text.split("\n")) {
    lines += Math.max(1, Math.ceil(seg.length / USER_TEXT_CHARS_PER_LINE));
    if (lines > USER_TEXT_MAX_LINES) return true;
  }
  return false;
}
