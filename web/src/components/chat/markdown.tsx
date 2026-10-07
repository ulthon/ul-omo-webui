// Markdown 渲染（todo 16）：react-markdown 默认配置（不执行裸 HTML，防注入）；
// 代码块高亮走 Shiki worker（lib/highlight-client），worker 失败降级纯文本不崩。
// memo + useDeferredValue + live 节流：流式 delta 高频更新时按 ~150ms 节流重新解析，
// 避免每个 delta 都做一次完整 markdown 解析形成长任务（深度调优留 W5）。
import { memo, useDeferredValue, useEffect, isValidElement, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
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

/** 从 <pre> 的子节点提取代码文本与语言（react-markdown 生成单个 <code> 子元素） */
function extractCode(children: unknown): { code: string; lang: string } | null {
  if (!isValidElement<{ className?: string; children?: unknown }>(children)) return null;
  const className = typeof children.props.className === "string" ? children.props.className : "";
  const lang = /language-([\w+-]+)/.exec(className)?.[1]?.toLowerCase() ?? "";
  const raw = children.props.children;
  const code = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(String).join("") : String(raw ?? "");
  return { code: code.replace(/\n$/, ""), lang };
}

/** 代码块：等待 worker 高亮期间先渲染纯文本（流式增长也在纯文本态，返回后整体换入） */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const highlightable = lang !== "" && lang !== "text" && lang !== "plain" && code.length <= 100_000;
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

const markdownComponents: Components = {
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

export const Markdown = memo(function Markdown({ text, live = false }: { text: string; live?: boolean }) {
  const deferred = useDeferredValue(text);
  // 300ms：长文流式 re-parse 单次即超 50ms 长任务线，节流优先压频率（深度调优留 W5）
  const display = useThrottledValue(deferred, 300, live);
  return (
    <div className="md-body text-sm leading-relaxed">
      <ReactMarkdown components={markdownComponents}>{display}</ReactMarkdown>
    </div>
  );
});
