// 设置页「工具启停」分区（r10 todo 17）：项目级逐工具开关。
// 工具目录来自 GET /api/projects/tools（内置工具静态清单，与引擎 CLI help 同源——
// spike-16 实证引擎无工具列表 RPC）；启停态写项目 .ul-omo-webui.json excludedTools
// （黑名单语义，null = 全部启用），spawn 参数级 --exclude-tools 透传，保存后需重启
// 项目引擎生效——保存成功即弹重启提示，一键走既有 POST /api/projects/restart 路由。
// 全部关闭 = 显式空集降级（引擎 --no-tools 零工具），出明确降级提示不崩。
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useUiStore } from "@/stores/ui";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function ToolsSection() {
  const currentProject = useUiStore((s) => s.currentProject);
  const excluded = useUiStore(
    (s) => s.projects.find((p) => p.projectPath === s.currentProject)?.excludedTools ?? null,
  );
  const [catalog, setCatalog] = useState<Array<{ name: string; builtin: boolean }> | null>(null);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const t = useT();
  const showError = (err: unknown, fallbackKey: Parameters<typeof apiErrorMessage>[1]) => {
    if (err instanceof ApiError && err.status === 401) return;
    useUiStore.getState().showToast(apiErrorMessage(err, fallbackKey), "error");
  };

  // 目录加载一次 + 服务端启停态灌入草稿（项目切换/服务端 refetch 后重灌）
  useEffect(() => {
    let cancelled = false;
    api
      .listToolCatalog()
      .then((res) => {
        // 目录缺失/异形（夹具无路由、旧服务端）→ 维持加载态 null，绝不落 undefined 进渲染
        if (!cancelled) setCatalog(Array.isArray(res?.tools) ? res.tools : null);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    setDraft(excluded === null ? new Set() : new Set(excluded));
  }, [currentProject, excluded]);

  const allDisabled = !!catalog && !!draft && catalog.every((tool) => draft.has(tool.name));
  const dirty = useMemo(() => {
    if (draft === null) return false;
    const saved = excluded === null ? new Set<string>() : new Set(excluded);
    if (saved.size !== draft.size) return true;
    for (const name of draft) if (!saved.has(name)) return true;
    return false;
  }, [draft, excluded]);

  const save = async () => {
    if (!currentProject || draft === null || saving) return;
    setSaving(true);
    try {
      const excludedTools = [...draft].sort();
      await api.patchProjectMeta({ path: currentProject, excludedTools });
      const ui = useUiStore.getState();
      ui.setProjects(
        ui.projects.map((p) => (p.projectPath === currentProject ? { ...p, excludedTools } : p)),
      );
      ui.showToast(t("tools.saved"), "info");
      // 保存成功即弹重启提示（spawn 参数级生效口，一键复用既有重启路由）
      setRestartOpen(true);
    } catch (err) {
      showError(err, "tools.saveFailed");
    } finally {
      setSaving(false);
    }
  };

  const restart = async () => {
    if (!currentProject || restarting) return;
    setRestarting(true);
    try {
      await api.restartProject(currentProject);
      setRestartOpen(false);
      useUiStore.getState().showToast(t("tools.restarted"), "info");
    } catch (err) {
      showError(err, "tools.restartFailed");
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="border-t pt-1" data-testid="tools-section">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">
          {t("tools.heading")}
          {currentProject && (
            <span className="ml-1.5 font-normal text-muted-foreground" title={currentProject}>
              {basename(currentProject)}
            </span>
          )}
        </p>
        {currentProject ? (
          loadFailed ? (
            <p className="text-sm text-muted-foreground" data-testid="tools-load-failed">
              {t("tools.loadFailed")}
            </p>
          ) : (
            <>
              <div className="space-y-1" data-testid="tools-list">
                {(catalog ?? []).map((tool) => {
                  const enabled = draft === null || !draft.has(tool.name);
                  return (
                    <div
                      key={tool.name}
                      data-testid={`tools-item-${tool.name}`}
                      className="flex min-h-9 items-center gap-2 rounded-md border px-2 py-1"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">{tool.name}</span>
                      <button
                        type="button"
                        data-testid={`tools-toggle-${tool.name}`}
                        role="switch"
                        aria-checked={enabled}
                        disabled={saving}
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-none transition-colors disabled:opacity-50 ${
                          enabled
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "border-border bg-muted text-muted-foreground"
                        }`}
                        onClick={() =>
                          setDraft((prev) => {
                            const next = new Set(prev ?? []);
                            if (next.has(tool.name)) next.delete(tool.name);
                            else next.add(tool.name);
                            return next;
                          })
                        }
                      >
                        {enabled ? t("extensions.enabled") : t("extensions.disabled")}
                      </button>
                    </div>
                  );
                })}
              </div>
              {allDisabled && (
                <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="tools-degraded-notice">
                  {t("tools.degraded")}
                </p>
              )}
              <p className="text-xs text-muted-foreground">{t("tools.note")}</p>
              <div className="flex items-center justify-end gap-2">
                {draft !== null && draft.size > 0 && (
                  <span className="mr-auto text-xs text-muted-foreground" data-testid="tools-disabled-count">
                    {t("tools.disabledCount", { n: draft.size })}
                  </span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  data-testid="tools-save-button"
                  disabled={saving || !dirty}
                  onClick={() => void save()}
                >
                  {saving ? t("tools.saving") : t("tools.save")}
                </Button>
              </div>
            </>
          )
        ) : (
          <p className="text-sm text-muted-foreground">{t("tools.noProject")}</p>
        )}
      </div>

      <Dialog
        open={restartOpen}
        onOpenChange={(open) => {
          if (!restarting) setRestartOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("tools.restartPromptTitle")}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-1.5 text-left">
                <p>{t("tools.restartPromptDesc")}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" disabled={restarting} onClick={() => setRestartOpen(false)}>
              {t("tools.restartLater")}
            </Button>
            <Button type="button" disabled={restarting} data-testid="tools-restart-confirm" onClick={() => void restart()}>
              {restarting ? t("tools.saving") : t("tools.restartNow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
