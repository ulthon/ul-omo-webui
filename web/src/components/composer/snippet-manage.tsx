// 常用语管理视图（todo 14）：两 scope 分组（项目级/全局）经 SnippetGroupEditor 渲染
// 与编辑，「从输入历史导入」子面板（SnippetImport）。每个操作经 PUT /api/snippets 按
// scope 整替（响应回显更新本地副本，模式同 tag-manage-dialog；面板列表在返回视图
// 重新挂载时自然重取）。
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api, ApiError, type SnippetEntry } from "@/lib/api";
import { t } from "@/i18n/i18n";
import { Button } from "@/components/ui/button";
import { DialogTitle } from "@/components/ui/dialog";
import { SnippetGroupEditor } from "./snippet-group";
import { SnippetImport } from "./snippet-import";
import { renumberSnippets } from "./snippet-logic";

type Scope = "global" | "project";

export function SnippetManage({ project, onBack }: { project: string | null; onBack: () => void }) {
  // 本地条目副本（PUT 响应回显即更新）
  const [entries, setEntries] = useState<{ global: SnippetEntry[]; project: SnippetEntry[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // effect 只发请求（oxlint set-state-in-effect 消警模式）；每次打开管理全新挂载重取
  useEffect(() => {
    let cancelled = false;
    api
      .listSnippets(project ?? undefined)
      .then((res) => {
        if (!cancelled) setEntries(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t("composer.snippet.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  /** 提交该 scope 整替并更新本地副本（失败保持原状并展示错误） */
  const putScope = async (scope: Scope, next: SnippetEntry[]): Promise<boolean> => {
    if (busy) return false;
    if (scope === "project" && !project) {
      setError(t("composer.snippet.noProjectSave"));
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.putSnippets({
        scope,
        ...(scope === "project" && project ? { project } : {}),
        snippets: renumberSnippets(next),
      });
      setEntries((prev) => ({ global: prev?.global ?? [], project: prev?.project ?? [], [scope]: res.snippets }));
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("composer.snippet.saveFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const importContents = (contents: string[]) => {
    if (!project) return;
    const next = [...(entries?.project ?? []), ...contents.map((content) => ({ content, sort: 0 }))];
    void putScope("project", next).then((ok) => {
      if (ok) setImporting(false);
    });
  };

  if (importing && project) {
    return (
      <SnippetImport project={project} busy={busy} onBack={() => setImporting(false)} onImport={importContents} />
    );
  }

  const projectName = project ? (project.split("/").filter(Boolean).pop() ?? project) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label={t("composer.snippet.backToPanel")}
          data-testid="snippet-manage-back"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <DialogTitle className="text-base font-medium">{t("composer.snippet.manageTitle")}</DialogTitle>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-0.5">
        <SnippetGroupEditor
          scope="project"
          label={t("composer.snippet.projectGroup", { name: projectName ?? t("composer.snippet.noProject") })}
          entries={entries?.project ?? []}
          busy={busy}
          canEdit={Boolean(project)}
          showImportButton={Boolean(project)}
          onImportOpen={() => setImporting(true)}
          onSubmit={(next) => (project ? putScope("project", next) : Promise.resolve(false))}
        />
        <SnippetGroupEditor
          scope="global"
          label={t("composer.snippet.globalGroup")}
          entries={entries?.global ?? []}
          busy={busy}
          canEdit
          showImportButton={false}
          onImportOpen={() => {}}
          onSubmit={(next) => putScope("global", next)}
        />
        {error && (
          <p className="text-xs text-destructive" data-testid="snippet-manage-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
