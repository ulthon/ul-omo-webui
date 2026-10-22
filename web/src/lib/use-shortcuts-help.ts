// 快捷键帮助全局触发（docs08-r7 任务 12）：shell 挂载，"?" 或 Ctrl/Cmd+K 打开帮助。
// 与 useCtrlPModelPicker 同款探针可测形态（键位判定收拢 lib/shortcuts 注册表）；
// 开关状态落 ui store（顶栏帮助钮与全局键共用，modelPickerOpen 先例）。
// 独立成文件：oxlint react(only-export-components) 要求 hook 与组件分文件（基线 7 警告只减不增）。
import { useEffect } from "react";
import { useUiStore } from "@/stores/ui";
import { isHelpTrigger } from "@/lib/shortcuts";

/** 全局快捷键触发（shell 挂载）："?" 或 Ctrl/Cmd+K 打开帮助。
 * 三重让路（行为保护，均不改既有行为）：[role=dialog] 目标让路（Ctrl+P 对话框
 * 守卫先例）；可编辑目标让路——输入区的 ? 必须照常插入字符；IME 组合中让路
 * （合成期按键不劫持）。 */
export function useShortcutsHelp(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!isHelpTrigger(e)) return;
      const target = e.target;
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      e.preventDefault();
      useUiStore.getState().setShortcutsHelpOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
