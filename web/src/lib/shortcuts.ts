// 快捷键注册表（docs08-r7 任务 12）：键位显示串与描述词条键的唯一事实来源。
// 帮助对话框（shortcuts-dialog.tsx）按此渲染；主要 handler（shell 的模型快捷键：
// Ctrl+P 收藏循环 / Ctrl+L 选择弹层，及帮助触发、composer 的 Enter 发送）经下方谓词
// 共用同一判定——组件内不得复制键串，只允许引用注册表。触发键显示串不本地化
// （descKey 词条在 i18n zh/en 双语齐键）。
import type { MessageKey } from "@/i18n/i18n";

/** 谓词入参最小结构：原生与 React 合成键盘事件都满足（结构化，不做类型耦合） */
export interface ShortcutTriggerLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Ctrl/Cmd+P 正向循环切换收藏模型（shell useModelShortcuts，r9 2026-10-26 批次
 * 对齐 native 键位；原 Ctrl+P 开弹层改由 Ctrl+L 承担）。Shift 变体归反向谓词，
 * 两谓词经 !shiftKey / shiftKey 互斥，一次按键不双触发。 */
export function isModelCycleForward(e: ShortcutTriggerLike): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "p";
}

/** Shift+Ctrl/Cmd+P 反向循环切换收藏模型（shell useModelShortcuts）。带 Shift 时
 * key 为大写 "P"，判定统一走 toLowerCase。 */
export function isModelCycleBackward(e: ShortcutTriggerLike): boolean {
  return e.shiftKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p";
}

/** Ctrl/Cmd+L 打开模型选择（shell useModelShortcuts）：与浏览器默认（地址栏聚焦）
 * 冲突，调用方负责 preventDefault。 */
export function isModelPickerTrigger(e: ShortcutTriggerLike): boolean {
  return (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l";
}

/** ? 或 Ctrl/Cmd+K 打开快捷键帮助（shell useShortcutsHelp）。
 * 带修饰键的 ? 一律让路（Windows AltGr+? 产生 ctrlKey+altKey，绝不可吞打字）。 */
export function isHelpTrigger(e: ShortcutTriggerLike): boolean {
  if (e.ctrlKey || e.metaKey) return !e.altKey && e.key.toLowerCase() === "k";
  if (e.altKey) return false;
  return e.key === "?";
}

/** Enter 发送（composer onKeyDown 主发送分支）：Shift+Enter 留给换行 */
export function isSendKey(e: ShortcutTriggerLike): boolean {
  return e.key === "Enter" && !e.shiftKey;
}

/** 快捷键条目：id 稳定（testid/测试锚点）；keys 为等价触发组合，一串一徽标 */
export interface ShortcutEntry {
  id: string;
  keys: string[];
  descKey: MessageKey;
}

export interface ShortcutGroup {
  id: string;
  titleKey: MessageKey;
  entries: ShortcutEntry[];
}

/** 全部现有快捷键，按来源 handler 分组（grep keydown 全量枚举核对，双向一致）：
 * - global：shell.tsx（Ctrl+P/Shift+Ctrl+P 收藏循环、Ctrl+L 模型选择）+ 帮助触发（?/Ctrl+K）
 * - composer：composer.tsx onKeyDown（Enter 发送、Shift+Enter 换行、@ 文件引用）
 * - history：composer.tsx 历史翻阅分支（↑ 调出/翻旧、↓ 翻新、Esc 退出）
 * - slash：composer.tsx 斜杠下拉域（/ 打开、↑/↓ 高亮、Enter 选择、Esc 关闭回退）
 * - overlay：Esc 关闭类（anchored-panel/right-rail/image-lightbox/radix 弹层） */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    id: "global",
    titleKey: "shortcuts.group.global",
    entries: [
      {
        id: "model-cycle",
        keys: ["Ctrl+P", "Shift+Ctrl+P", "⌘P", "Shift+⌘P"],
        descKey: "shortcuts.desc.modelCycle",
      },
      { id: "model-picker", keys: ["Ctrl+L", "⌘L"], descKey: "shortcuts.desc.modelPicker" },
      { id: "shortcuts-help", keys: ["?", "Ctrl+K", "⌘K"], descKey: "shortcuts.desc.shortcutsHelp" },
    ],
  },
  {
    id: "composer",
    titleKey: "shortcuts.group.composer",
    entries: [
      { id: "send", keys: ["Enter"], descKey: "shortcuts.desc.send" },
      { id: "newline", keys: ["Shift+Enter"], descKey: "shortcuts.desc.newline" },
      { id: "file-ref", keys: ["@"], descKey: "shortcuts.desc.fileRef" },
    ],
  },
  {
    id: "history",
    titleKey: "shortcuts.group.history",
    entries: [
      { id: "history-older", keys: ["↑"], descKey: "shortcuts.desc.historyOlder" },
      { id: "history-newer", keys: ["↓"], descKey: "shortcuts.desc.historyNewer" },
      { id: "history-exit", keys: ["Esc"], descKey: "shortcuts.desc.historyExit" },
    ],
  },
  {
    id: "slash",
    titleKey: "shortcuts.group.slash",
    entries: [
      { id: "slash-open", keys: ["/"], descKey: "shortcuts.desc.slashOpen" },
      { id: "slash-nav", keys: ["↑", "↓"], descKey: "shortcuts.desc.slashNav" },
      { id: "slash-select", keys: ["Enter"], descKey: "shortcuts.desc.slashSelect" },
      { id: "slash-close", keys: ["Esc"], descKey: "shortcuts.desc.slashClose" },
    ],
  },
  {
    id: "overlay",
    titleKey: "shortcuts.group.overlay",
    entries: [{ id: "overlay-close", keys: ["Esc"], descKey: "shortcuts.desc.overlayClose" }],
  },
];
