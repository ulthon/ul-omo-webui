// 会话选中的 URL 载体（B1）：?session=<id> 是选中态的唯一持久载体（用户裁决仅 URL，
// 无服务端状态无 localStorage）。写走 history.replaceState——不进历史栈，回退键行为不变；
// 其余查询参数原样保留。读侧唯一入口：shell.tsx（右栏兜底）与 chat-view.tsx（消息视图
// 兜底）收敛到本助手，避免两处读取逻辑漂移。

const SESSION_PARAM = "session";

/** 读 ?session= 参数值；无参数或非浏览器环境返回 null */
export function readSessionUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(SESSION_PARAM);
}

/** 写（id 非空）或清（id 为 null）?session= 参数，replaceState 原地替换。
 * 写入方需保证 id 是真实落盘会话 id：未落盘占位会话（别名 id）由调用方传 null 清参，
 * 不得把别名 id 写入 URL（刷新命中间名落现有 listMessages 错误态）。 */
export function writeSessionUrl(id: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete(SESSION_PARAM);
  else url.searchParams.set(SESSION_PARAM, id);
  window.history.replaceState(null, "", url);
}
