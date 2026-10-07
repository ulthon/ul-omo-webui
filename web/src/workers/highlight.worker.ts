// Shiki 高亮 worker（todo 16）：主线程 postMessage 代码块 → 这里高亮 → 返回 HTML 片段。
// 语言加载失败 / 不识别时返回 html:null，调用方降级为纯文本渲染（不崩）。
// 长驻 highlighter：shiki 的 codeToHtml 内部维护单例引擎，语言与主题按需动态加载并缓存。
import { codeToHtml } from "shiki";

export interface HighlightRequest {
  id: number;
  code: string;
  lang: string;
}

export interface HighlightResponse {
  id: number;
  html: string | null;
}

// DOM lib 下 self 类型是 Window（postMessage 需要 targetOrigin），这里收窄为 DedicatedWorkerGlobalScope 所需的最小面
const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<HighlightRequest>) => void) | null;
  postMessage(message: HighlightResponse): void;
};

workerScope.onmessage = async (ev: MessageEvent<HighlightRequest>) => {
  const { id, code, lang } = ev.data;
  try {
    const html = await codeToHtml(code, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
    });
    workerScope.postMessage({ id, html });
  } catch {
    workerScope.postMessage({ id, html: null });
  }
};
