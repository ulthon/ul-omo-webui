// 请求关联上下文（2026-10-31 日志采集增强批）。
// 前端每请求生成 8 位 rid 放 X-Request-Id；http 层接收后经 AsyncLocalStorage
// 贯穿 gateway/adapter 埋点行——前后端日志按 rid 串联，导出诊断包后可对齐一次
// 交互的完整链路。业务接口签名零改动（无侵入传递）。
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface ReqCtx {
  rid: string;
}

const als = new AsyncLocalStorage<ReqCtx>();

/** 生成 8 位十六进制请求关联 id（前端同款算法，两侧格式一致便于肉眼对齐） */
export function newRid(): string {
  return randomBytes(4).toString("hex");
}

/** 在 rid 作用域内执行 fn（http 层进入 handler 时包裹一次） */
export function withRid<T>(rid: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ rid }, fn);
}

/** 当前作用域 rid（gateway/adapter 埋点读取；无作用域返回 undefined） */
export function currentRid(): string | undefined {
  return als.getStore()?.rid;
}
