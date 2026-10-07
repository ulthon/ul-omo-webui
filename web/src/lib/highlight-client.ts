// Shiki worker 主线程客户端：单例 worker + 请求 id 关联 + 结果缓存。
// 降级路径：worker 创建失败 / 运行出错 / 单次高亮失败 → highlight() resolve null，
// 调用方（markdown 组件）保持纯文本 <pre><code> 渲染，不影响页面。
import type { HighlightResponse } from "@/workers/highlight.worker";

type Resolve = (html: string | null) => void;

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, Resolve>();
/** code+lang → html 缓存（流式期间同块反复高亮，完整代码块命中缓存直出） */
const cache = new Map<string, string>();
const CACHE_LIMIT = 200;

function cacheKey(code: string, lang: string): string {
  return `${lang}\u0000${code}`;
}

function createWorker(): Worker | null {
  try {
    const w = new Worker(new URL("../workers/highlight.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<HighlightResponse>) => {
      const { id, html } = ev.data;
      const resolve = pending.get(id);
      if (!resolve) return;
      pending.delete(id);
      resolve(html);
    };
    w.onerror = () => {
      // worker 崩溃：所有在途请求降级为 null，后续请求不再尝试 worker
      workerBroken = true;
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
      w.terminate();
      worker = null;
    };
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** 高亮一段代码；返回 Shiki HTML 片段，null = 降级（调用方渲染纯文本） */
export function highlight(code: string, lang: string): Promise<string | null> {
  const key = cacheKey(code, lang);
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);

  if (workerBroken) return Promise.resolve(null);
  worker ??= createWorker();
  if (!worker) return Promise.resolve(null);

  return new Promise<string | null>((resolve) => {
    const id = ++seq;
    pending.set(id, (html) => {
      if (html !== null) {
        if (cache.size >= CACHE_LIMIT) {
          // 简单 FIFO 淘汰，防长会话内存无界
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, html);
      }
      resolve(html);
    });
    worker!.postMessage({ id, code, lang });
  });
}
