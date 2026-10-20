// 权限请求队列容器（todo 18）：渲染会话内未决请求（FIFO），挂在输入区上方。
// 自动放行拦截：队首为权限型 select 且命中前端 auto-allow 缓存时，自动应答选项原文
// "Allow once" 并出队，不弹卡（与引擎 Allow always 并存，语义见 permissions.ts 注释）。
import { useEffect } from "react";
import { api } from "@/lib/api";
// tSnap：effect 异步续体在完成时刻取词（getState 即时态）；本组件无渲染期文案，无需 useT
import { t as tSnap } from "@/i18n/i18n";
import { useUiStore } from "@/stores/ui";
import { autoAllowKey, parsePermissionTool, usePermissionsStore } from "@/stores/permissions";
import { PermissionCard } from "./permission-card";

function AutoAllowResolver({ sessionId }: { sessionId: string }) {
  const head = usePermissionsStore((s) => s.bySession[sessionId]?.[0]);
  const showToast = useUiStore((s) => s.showToast);

  useEffect(() => {
    if (!head || head.method !== "select") return;
    const tool = parsePermissionTool(head.title);
    if (tool === null) return;
    if (usePermissionsStore.getState().autoAllow[autoAllowKey(sessionId, tool)] !== true) return;
    // 自动应答：先 POST 成功再出队（失败保留卡片转人工）
    let cancelled = false;
    api
      .respondPermission(sessionId, { requestId: head.id, value: "Allow once" })
      .then(() => {
        if (cancelled) return;
        usePermissionsStore.getState().removeRequest(sessionId, head.id);
        showToast(tSnap("chat.permissionQueue.autoAllowed", { tool }), "info");
      })
      .catch(() => {
        // 静默保留卡片，人工应答
      });
    return () => {
      cancelled = true;
    };
  }, [head, sessionId, showToast]);

  return null;
}

export function PermissionQueue({ sessionId }: { sessionId: string }) {
  const requests = usePermissionsStore((s) => s.bySession[sessionId]);

  return (
    <div className="shrink-0 px-3 pb-1.5 sm:px-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <AutoAllowResolver sessionId={sessionId} />
        {(requests ?? []).map((request, i) => (
          <PermissionCard key={request.id} sessionId={sessionId} request={request} position={i + 1} total={requests!.length} />
        ))}
      </div>
    </div>
  );
}
