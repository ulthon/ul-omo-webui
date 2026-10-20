// 权限确认卡片（todo 18）：四型映射为触控友好表单（按钮 ≥44px 高）。
// 应答契约（verification/02）：select 必须选项原文；confirm → confirmed bool；
// input/editor → value；取消 → {cancelled:true}（引擎对未知 id 不报错，防误弹死锁）。
// "Deny with feedback" 应答后引擎链出第二个独立 input 请求，由队列自然承接两段式。
import { useState } from "react";
import { ShieldAlert, X } from "lucide-react";
import { api } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { useUiStore } from "@/stores/ui";
import { parsePermissionTool, usePermissionsStore, type PermissionRequest } from "@/stores/permissions";
import { autoAllowKey } from "@/stores/permissions";

/** 四型标题键（t() 须在渲染期调用，模块级 Record 只存键名字面量） */
const METHOD_KEY: Record<PermissionRequest["method"], `chat.permissionCard.kind${"Select" | "Confirm" | "Input" | "Editor"}`> = {
  select: "chat.permissionCard.kindSelect",
  confirm: "chat.permissionCard.kindConfirm",
  input: "chat.permissionCard.kindInput",
  editor: "chat.permissionCard.kindEditor",
};

export function PermissionCard({
  sessionId,
  request,
  position,
  total,
}: {
  sessionId: string;
  request: PermissionRequest;
  position: number;
  total: number;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [editorValue, setEditorValue] = useState(request.prefill ?? "");
  const [alwaysAllow, setAlwaysAllow] = useState(false);

  const t = useT();
  const respond = async (payload: { value?: string; confirmed?: boolean }) => {
    if (busy) return;
    setBusy(true);
    try {
      if (alwaysAllow && request.method === "select") {
        const tool = parsePermissionTool(request.title);
        if (tool) {
          // 前端层"总是允许"：写 kv，同会话后续同工具 select 由队列容器自动应答
          // （引擎 Allow always 是会话内权限模式的权威，二者并存见 permissions.ts 注释）
          await api.putSettings({ [autoAllowKey(sessionId, tool)]: "allow-once" });
          usePermissionsStore.getState().markAutoAllow(sessionId, tool);
        }
      }
      await api.respondPermission(sessionId, { requestId: request.id, ...payload });
      usePermissionsStore.getState().removeRequest(sessionId, request.id);
      if (payload.value === "Deny with feedback") {
        showToast(t("chat.permissionCard.deniedToast"), "info");
      }
    } catch (err) {
      showToast(apiErrorMessage(err, "chat.permissionCard.submitFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.respondPermission(sessionId, { requestId: request.id, cancelled: true });
      usePermissionsStore.getState().removeRequest(sessionId, request.id);
    } catch (err) {
      showToast(apiErrorMessage(err, "chat.permissionCard.cancelFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid={`permission-card-${request.method}`}
      className="mx-auto w-full max-w-3xl rounded-xl border bg-card shadow-sm"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ShieldAlert className="size-4 shrink-0 text-amber-600" aria-hidden />
        <span className="text-sm font-medium">
          {t(METHOD_KEY[request.method])}
          {total > 1 && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {t("chat.permissionCard.position", { position, total })}
            </span>
          )}
        </span>
      </div>

      <div className="px-3 py-2.5">
        {request.title && (
          <p className="text-sm whitespace-pre-wrap break-words text-foreground">{request.title}</p>
        )}
        {request.message && (
          <p className="mt-1.5 text-sm whitespace-pre-wrap text-muted-foreground">{request.message}</p>
        )}

        {request.method === "select" && (
          <div className="mt-2.5 flex flex-col gap-1.5">
            {(request.options ?? []).map((option) => (
              <button
                key={option}
                type="button"
                disabled={busy}
                data-testid={`permission-option`}
                onClick={() => void respond({ value: option })}
                className="min-h-11 w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50"
              >
                {option}
              </button>
            ))}
            {parsePermissionTool(request.title) !== null && (
              <label className="mt-1 flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-1 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--primary)]"
                  checked={alwaysAllow}
                  onChange={(e) => setAlwaysAllow(e.target.checked)}
                />
                {t("chat.permissionCard.alwaysAllow", { tool: parsePermissionTool(request.title) })}
              </label>
            )}
          </div>
        )}

        {request.method === "confirm" && (
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              data-testid="permission-confirm-yes"
              onClick={() => void respond({ confirmed: true })}
              className="min-h-11 flex-1 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-50"
            >
              {t("chat.permissionCard.confirm")}
            </button>
            <button
              type="button"
              disabled={busy}
              data-testid="permission-confirm-no"
              onClick={() => void respond({ confirmed: false })}
              className="min-h-11 flex-1 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-muted disabled:opacity-50"
            >
              {t("chat.permissionCard.cancel")}
            </button>
          </div>
        )}

        {request.method === "input" && (
          <div className="mt-2.5 flex flex-col gap-2">
            <input
              data-testid="permission-input"
              value={inputValue}
              placeholder={request.placeholder ?? ""}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void respond({ value: inputValue });
                }
              }}
              className="min-h-11 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <button
              type="button"
              disabled={busy}
              data-testid="permission-submit"
              onClick={() => void respond({ value: inputValue })}
              className="min-h-11 w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-50"
            >
              {t("chat.permissionCard.submit")}
            </button>
          </div>
        )}

        {request.method === "editor" && (
          <div className="mt-2.5 flex flex-col gap-2">
            <textarea
              data-testid="permission-editor"
              value={editorValue}
              rows={6}
              onChange={(e) => setEditorValue(e.target.value)}
              className="w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <button
              type="button"
              disabled={busy}
              data-testid="permission-submit"
              onClick={() => void respond({ value: editorValue })}
              className="min-h-11 w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-50"
            >
              {t("chat.permissionCard.submitAll")}
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">{t("chat.permissionCard.blockHint")}</span>
        <button
          type="button"
          disabled={busy}
          data-testid="permission-dismiss"
          onClick={() => void cancel()}
          className="flex min-h-11 items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <X className="size-3" />
          {t("chat.permissionCard.dismiss")}
        </button>
      </div>
    </div>
  );
}
