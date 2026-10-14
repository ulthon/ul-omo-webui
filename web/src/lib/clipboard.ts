// 剪贴板写入助手（A8 自 message-actions 提取共享）：产品主部署为纯 HTTP 局域网，
// 非安全源 navigator.clipboard 恒为 undefined，禁止调用方裸用 clipboard API。
// clipboard API 失败（非 https/未授权）降级隐藏 textarea + execCommand("copy")。
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
