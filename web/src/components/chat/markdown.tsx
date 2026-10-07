// Markdown 渲染（todo 16 建；W5 todo 27 深度调优重写渲染管线）。
//
// 管线：原依赖 react-markdown 的同步路径 = unified(remarkParse) → remarkRehype(allowDangerousHtml)
// → visit（raw 节点转纯文本 / URL 走协议白名单）→ hast-util-to-jsx-runtime。
// 本文件复刻同一管线（语义一致：不执行裸 HTML、URL 协议白名单），并把「文本 → React 元素树」
// 做模块级 LRU 缓存：虚拟列表滚动会反复卸载/重挂行组件，命中缓存即跳过全量重解析
// （实测长文解析 ~0.5ms/KB，重挂载重解析是长会话滚动长任务来源之一；决策记录 .omo/qa/W5/perf/）。
//
// 流式：memo + useDeferredValue + live 300ms 节流（todo 16 结论保留）；live 每次节流提交的
// 新文本自然写入缓存，settle 定格后的静态渲染直接命中。
//
// 大代码块：Shiki 高亮 HTML 每行数百 span，>10KB 代码块注入期产生 >100ms 长任务（W5-27
// 基线实测 100-219ms）——超过阈值退纯文本 pre/code（内容完整保留，仅跳过着色）。
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { memo, useDeferredValue, useEffect, isValidElement, useRef, useState, type ReactNode } from "react";
import { toJsxRuntime, type Options as ToJsxOptions } from "hast-util-to-jsx-runtime";
import { urlAttributes } from "html-url-attributes";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { visit } from "unist-util-visit";
import { unified } from "unified";
import { VFile } from "vfile";
import type { Element, Nodes, Parents } from "hast";
import { highlight } from "@/lib/highlight-client";

/** live 模式节流：值高频变化时按 intervalMs 尾沿提交（流式 markdown 专用） */
function useThrottledValue<T>(value: T, intervalMs: number, enabled: boolean): T {
  const [committed, setCommitted] = useState(value);
  const latestRef = useRef(value);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    latestRef.current = value;
    if (!enabled) return;
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setCommitted(latestRef.current);
    }, intervalMs);
  }, [value, enabled, intervalMs]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  // 非 live 模式直通；live 模式返回节流提交值
  return enabled ? committed : value;
}

/** 从 <pre> 的子节点提取代码文本与语言（markdown 生成单个 <code> 子元素） */
function extractCode(children: unknown): { code: string; lang: string } | null {
  if (!isValidElement<{ className?: string; children?: unknown }>(children)) return null;
  const className = typeof children.props.className === "string" ? children.props.className : "";
  const lang = /language-([\w+-]+)/.exec(className)?.[1]?.toLowerCase() ?? "";
  const raw = children.props.children;
  const code = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(String).join("") : String(raw ?? "");
  return { code: code.replace(/\n$/, ""), lang };
}

/** 超过该长度的代码块不做 Shiki 高亮（纯文本渲染；内容完整） */
const CODE_HIGHLIGHT_MAX_CHARS = 10_000;

/** 代码块：等待 worker 高亮期间先渲染纯文本（流式增长也在纯文本态，返回后整体换入） */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const highlightable = lang !== "" && lang !== "text" && lang !== "plain" && code.length <= CODE_HIGHLIGHT_MAX_CHARS;
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!highlightable) return;
    let stale = false;
    // 轻防抖：流式中同一代码块反复增长，等 120ms 静止再送 worker（缓存命中时几乎无感）
    const timer = setTimeout(() => {
      highlight(code, lang).then((result) => {
        if (!stale) setHtml(result);
      });
    }, 120);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [code, lang, highlightable]);

  // 不可高亮时不使用 html 残留态（渲染条件挡住），避免 effect 里同步清 state
  const showHtml = highlightable && html !== null;
  return (
    <div className="my-2 overflow-hidden rounded-lg border">
      <div className="border-b bg-muted/50 px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
        {lang || "text"}
      </div>
      {showHtml ? (
        // Shiki 输出为自产 HTML（代码内容已转义），安全；主题切换样式见 index.css
        <div className="overflow-x-auto p-3" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

const markdownComponents: ToJsxOptions["components"] = {
  pre: ({ children }) => {
    const extracted = extractCode(children);
    if (extracted) return <CodeBlock code={extracted.code} lang={extracted.lang} />;
    // 结构不合预期时兜底原样渲染
    return <pre className="overflow-x-auto rounded-lg border p-3 font-mono text-xs">{children}</pre>;
  },
  code: ({ children }) => (
    <code className="rounded-md bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
      {children}
    </a>
  ),
};

// ---- 渲染管线（react-markdown v10 同步路径复刻）----

const processor = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true });

// 与 react-markdown defaultUrlTransform 一致：仅放行安全协议，其余 URL 置空
const safeProtocol = /^(https?|ircs?|mailto|xmpp)$/i;
function sanitizeUrl(value: string): string {
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    safeProtocol.test(value.slice(0, colon))
  ) {
    return value;
  }
  return "";
}

/** 元素树 LRU 缓存：条目数与累计字符双预算（元素树内存为数倍文本量，防单条巨文吃满） */
const CACHE_MAX_ENTRIES = 120;
const CACHE_MAX_CHARS = 2_000_000;
const CACHE_SKIP_CHARS = 300_000;
const elementCache = new Map<string, ReactNode>();
let cachedChars = 0;

function cacheGet(text: string): ReactNode | undefined {
  const hit = elementCache.get(text);
  if (hit !== undefined) {
    // 触碰即刷新 LRU 位次
    elementCache.delete(text);
    elementCache.set(text, hit);
  }
  return hit;
}

function cacheSet(text: string, node: ReactNode): void {
  if (text.length > CACHE_SKIP_CHARS) return;
  while (
    (elementCache.size >= CACHE_MAX_ENTRIES || cachedChars + text.length > CACHE_MAX_CHARS) &&
    elementCache.size > 0
  ) {
    const oldestKey = elementCache.keys().next().value;
    if (oldestKey === undefined) break;
    elementCache.delete(oldestKey);
    cachedChars -= oldestKey.length;
  }
  elementCache.set(text, node);
  cachedChars += text.length;
}

/** 管线后处理（与 react-markdown post 一致）：raw → 纯文本；URL 属性过白名单 */
function transformTree(tree: Nodes): void {
  visit(tree, (node: Nodes, index: number | undefined, parent: Parents | undefined): number | undefined => {
    if (node.type === "raw" && parent && typeof index === "number") {
      parent.children[index] = { type: "text", value: node.value };
      return index;
    }
    if (node.type === "element") {
      const element: Element = node;
      for (const key in urlAttributes) {
        if (Object.hasOwn(urlAttributes, key) && Object.hasOwn(element.properties, key)) {
          const test = urlAttributes[key];
          if (test === null || test.includes(element.tagName)) {
            element.properties[key] = sanitizeUrl(String(element.properties[key] ?? ""));
          }
        }
      }
    }
    return undefined;
  });
}

/** 文本 → React 元素树（带缓存）。语义与 react-markdown v10 默认配置一致。 */
export function renderMarkdownCached(text: string): ReactNode {
  const hit = cacheGet(text);
  if (hit !== undefined) return hit;
  const file = new VFile();
  file.value = text;
  const tree = processor.runSync(processor.parse(file), file);
  transformTree(tree);
  const elements = toJsxRuntime(tree, {
    Fragment,
    components: markdownComponents,
    development: false,
    ignoreInvalidStyle: true,
    jsx: jsx as unknown as ToJsxOptions["jsx"],
    jsxs: jsxs as unknown as ToJsxOptions["jsxs"],
    passKeys: true,
    passNode: true,
  });
  cacheSet(text, elements);
  return elements;
}

export const Markdown = memo(function Markdown({ text, live = false }: { text: string; live?: boolean }) {
  const deferred = useDeferredValue(text);
  // 300ms：长文流式 re-parse 单次即超 50ms 长任务线，节流优先压频率（todo 16 结论保留）
  const display = useThrottledValue(deferred, 300, live);
  return <div className="md-body text-sm leading-relaxed">{renderMarkdownCached(display)}</div>;
});
