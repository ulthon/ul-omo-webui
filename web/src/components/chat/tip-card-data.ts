// 空态用法提示卡纯逻辑助手（docs08-2026-10-22 批次任务 25）：localStorage 关闭记忆
// 与轮换索引（与组件分离，规避 react/only-export-components；同 composer-logic/
// message-actions-data 先例）。导出供 tips-section 与单测复用。
/** 「关闭」记忆键（localStorage）："1"=本会话不再显 */
export const TIPS_DISMISSED_KEY = "ul-omo-webui:tips-dismissed";

export function readTipsDismissed(): boolean {
  try {
    return window.localStorage.getItem(TIPS_DISMISSED_KEY) === "1";
  } catch {
    return false; // 隐私模式等存储不可用：按未关闭处理（卡片可显可关，只是关不持久）
  }
}

export function dismissTips(): void {
  try {
    window.localStorage.setItem(TIPS_DISMISSED_KEY, "1");
  } catch {
    // 存储不可用：仅组件态生效（本次挂载内隐藏），不阻断
  }
}

export function clearTipsDismissed(): void {
  try {
    window.localStorage.removeItem(TIPS_DISMISSED_KEY);
  } catch {
    // 清不掉则卡片维持隐藏（下次重开设置时再清），不阻断
  }
}

/** 「换一条」轮换下一索引：本地循环；空清单回退 0（调用方保证 length>0 才渲染） */
export function nextTipIndex(index: number, length: number): number {
  return length > 0 ? (index + 1) % length : 0;
}
