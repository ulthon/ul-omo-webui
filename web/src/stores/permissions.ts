// 权限确认数据面（todo 18）：会话内未决请求队列。
// 实证契约（verification/02）：四型请求均无 toolCallId，按"会话内未决请求"建模；
// select 应答必须选项原文；Deny with feedback 链出的 input 是第二个独立请求，由队列
// 顺序承接（两段式）；同一会话可堆叠多个请求（FIFO 逐个应答）。
// 队列清理：回合落定（agent_end/settled/idle，event-dispatch 调用 clearSession）时整队
// 清空——权限门阻塞回合，agent_end 到达即全部请求已落定；孤儿请求（引擎重启等）由
// 卡片上的"忽略"按钮 POST {cancelled:true} 手动清除（引擎对未知 id 不报错）。
//
// auto-answer（前端层"总是允许"）：
//   kv 键 `permission-auto-allow:<sessionId>:<tool>`（PUT /api/settings，值 "allow-once"），
//   仅对 title 以 "Permission required: " 开头的 select 生效，解析工具名精确匹配；
//   命中即自动应答选项原文 "Allow once"，不弹卡。
//   与引擎 Allow always 并存：引擎记忆是会话内权限模式的权威（选 Allow always 后引擎
//   本会话不再询问）；此 kv 是前端层兜底（防引擎重复问），二者互不替代。
import { create } from "zustand";
import { api } from "@/lib/api";

export type PermissionMethod = "select" | "confirm" | "input" | "editor";

export interface PermissionRequest {
  /** wire extension_ui_request 的 id（应答回传用） */
  id: string;
  method: PermissionMethod;
  /** 原文标题（权限型含多行上下文：Command: $ ls / Patterns: ...，pre-wrap 展示） */
  title: string;
  /** select 选项原文数组 */
  options?: string[];
  /** confirm 附加说明 */
  message?: string;
  /** input 占位提示 */
  placeholder?: string;
  /** editor 预填全文 */
  prefill?: string;
}

/** 权限型 select 的标题前缀（引擎权限门固定形态；/commands 等非权限 select 不此前缀） */
const PERMISSION_TITLE_PREFIX = "Permission required:";

/** 从 select 标题解析工具名（"Permission required: bash\n..." → "bash"）；非权限型返回 null */
export function parsePermissionTool(title: string): string | null {
  if (!title.startsWith(PERMISSION_TITLE_PREFIX)) return null;
  const rest = title.slice(PERMISSION_TITLE_PREFIX.length);
  const tool = rest.split("\n", 1)[0]?.trim() ?? "";
  return tool.length > 0 ? tool : null;
}

/** 前端 auto-allow 的 kv 键（值固定 "allow-once"，语义见文件头注释） */
export function autoAllowKey(sessionId: string, tool: string): string {
  return `permission-auto-allow:${sessionId}:${tool}`;
}

interface PermissionsState {
  /** 会话 → 未决请求队列（FIFO，先到先应答） */
  bySession: Record<string, PermissionRequest[]>;
  /** 前端 auto-allow 缓存（键 = autoAllowKey；命中即自动应答 Allow once 不弹卡） */
  autoAllow: Record<string, true>;

  /** 入队（同 id 去重：SSE 重连/重放可能重投同一帧） */
  pushRequest(sessionId: string, request: PermissionRequest): void;
  /** 应答/取消后出队 */
  removeRequest(sessionId: string, id: string): void;
  /** 回合落定整队清空（event-dispatch 在 agent_end/settled/idle 调用） */
  clearSession(sessionId: string): void;
  /** 勾选"总是允许"后登记缓存（kv 写入由调用方完成） */
  markAutoAllow(sessionId: string, tool: string): void;
  /** 打开会话时从服务端 kv 预取本会话的 auto-allow 列表（单用户跨窗口一致性尽力而为） */
  refreshAutoAllow(sessionId: string): void;
}

export const usePermissionsStore = create<PermissionsState>()((set) => ({
  bySession: {},
  autoAllow: {},

  pushRequest: (sessionId, request) =>
    set((s) => {
      const queue = s.bySession[sessionId] ?? [];
      if (queue.some((r) => r.id === request.id)) return s;
      return { bySession: { ...s.bySession, [sessionId]: [...queue, request] } };
    }),

  removeRequest: (sessionId, id) =>
    set((s) => {
      const queue = s.bySession[sessionId];
      if (!queue) return s;
      const next = queue.filter((r) => r.id !== id);
      if (next.length === queue.length) return s;
      return { bySession: { ...s.bySession, [sessionId]: next } };
    }),

  clearSession: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const bySession = { ...s.bySession };
      delete bySession[sessionId];
      return { bySession };
    }),

  markAutoAllow: (sessionId, tool) =>
    set((s) => ({ autoAllow: { ...s.autoAllow, [autoAllowKey(sessionId, tool)]: true as const } })),

  refreshAutoAllow: (sessionId) => {
    const prefix = `permission-auto-allow:${sessionId}:`;
    void api
      .getSettings()
      .then(({ settings }) => {
        const hits: Record<string, true> = {};
        for (const key of Object.keys(settings)) {
          if (key.startsWith(prefix)) hits[key] = true;
        }
        if (Object.keys(hits).length > 0) set((s) => ({ autoAllow: { ...s.autoAllow, ...hits } }));
      })
      .catch(() => {
        // 拉取失败仅影响自动放行（全部弹卡人工应答），不提示
      });
  },
}));
