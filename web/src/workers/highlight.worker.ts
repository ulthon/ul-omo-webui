// Shiki 高亮 worker（todo 16）：主线程 postMessage 代码块 → 这里高亮 → 返回 HTML 片段。
// 语言加载失败 / 不识别时返回 html:null，调用方降级为纯文本渲染（不崩）。
// 长驻 highlighter：shiki 的 codeToHtml 内部维护单例引擎，语言与主题按需动态加载并缓存。
//
// 引擎选型（files-ux-revamp F3 缺陷修复）：不随 shiki 默认走 oniguruma wasm。默认链路
// 经 shiki/wasm 内嵌二进制，其解压实例化依赖 DecompressionStream/Blob/Response.bytes()
// 等较新平台 API——旧浏览器（如 Chromium 131，无 Response.bytes）引擎创建即抛
// TypeError，codeToHtml 逐请求失败、全语言静默降级纯文本（基线 9939546 与本分支产物
// 同字节复现，属先在缺陷而非本重构回归）。改用 JavaScript 正则引擎
// （shiki/engine/javascript，纯 JS 零二进制资产）：forgiving 跳过个别不支持的语法
// 模式而不是整个语言失败；预览/聊天代码块量级下性能足够。降级语义保持：仅真正的
// 不支持语言（bundle 无该语言 id / 语法不可用）才 html:null。
import { createBundledHighlighter, createSingletonShorthands, guessEmbeddedLanguages } from "shiki/core";
import { bundledLanguages } from "shiki/langs";
import { bundledThemes } from "shiki/themes";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// 与 shiki 包内 bundle-full 同构的组合：全量语言/主题保持按需动态加载（构建产物
// 逐语言 chunk），仅引擎换成 JS 正则实现
const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: () => createJavaScriptRegexEngine({ forgiving: true }),
});

const { codeToHtml } = createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages });

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
