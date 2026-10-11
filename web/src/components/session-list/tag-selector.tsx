// 标签选择器（todo 11）：复选式 Dialog——全局标签组/项目标签组两段勾选，勾选即时 PUT 整替
//（无"确定"按钮）。单会话 = 完整复选（初始勾选 = 当前挂载）；批量 = 对选中集合循环 PUT
//（进度反馈复用批量模式口径，失败逐条收集统一汇报）。底部"新建标签"输入 + scope 选择
//（默认 project）：先 PUT /api/tags 追加定义、成功后再勾选挂载，两步都成功才入列（计划 115 行）。
// 勾选态基于打开时的挂载快照计算（连续勾选不依赖行数据回流，规避竞态）。
import { useState } from "react";
import { Check, Loader2, Plus } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { SessionListItem, TagRef } from "@/lib/api";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { appendTagEntry, dedupeTagDefs, nextSessionTags, tagKey, type TagDefs } from "./tag-data";

interface TagSelectorProps {
  /** 1 个 = 单会话完整复选；多个 = 批量（勾选作用于全部选中会话） */
  sessions: SessionListItem[];
  /** 两源定义（session-list 合并了全部涉及项目的项目级标签） */
  defs: TagDefs;
  /** 新建 project 标签的落点项目（当前项目） */
  project: string;
  /** 定义集变更通知（父级重拉两源定义，孤儿判定/过滤选项同步） */
  onDefsChanged: () => void;
  onClose: () => void;
}

/** 初始挂载快照：id → 当前挂载（批量各会话可能不同） */
function initialMounts(sessions: SessionListItem[]): Map<string, TagRef[]> {
  return new Map(sessions.map((s) => [s.id, s.tags ?? []]));
}

/** 初始勾选态：单会话 = 其挂载；批量 = 各会话挂载的并集 */
function initialSelected(sessions: SessionListItem[]): Set<string> {
  const out = new Set<string>();
  for (const s of sessions) for (const t of s.tags ?? []) out.add(tagKey(t));
  return out;
}

export function TagSelector({ sessions, defs, project, onDefsChanged, onClose }: TagSelectorProps) {
  const showToast = useUiStore((s) => s.showToast);
  const batch = sessions.length > 1;
  const [mounts, setMounts] = useState(() => initialMounts(sessions));
  const [selected, setSelected] = useState(() => initialSelected(sessions));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // 本地定义副本：新建成功即入列（父级重拉异步完成前选择器内立即可见）；
  // 项目组合并了多项目定义，按名去重（挂载键 (project,name) 与归属项目无关）
  const [localDefs, setLocalDefs] = useState<TagDefs>(() => dedupeTagDefs(defs));
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<"global" | "project">("project");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  /** 勾选/取消：对受影响会话循环 PUT 整替，成功更新快照与行内数据 */
  const applyToggle = async (ref: TagRef, on: boolean) => {
    if (busy) return;
    setBusy(true);
    const key = tagKey(ref);
    // 目标会话：on = 不含该标签的；off = 含该标签的（未受影响会话不发请求）
    const targets = sessions.filter((s) => {
      const cur = mounts.get(s.id) ?? [];
      const has = cur.some((t) => t.scope === ref.scope && t.name === ref.name);
      return on ? !has : has;
    });
    let done = 0;
    const failedIds: string[] = [];
    for (const s of targets) {
      if (targets.length > 1) setProgress({ done, total: targets.length });
      const payload = nextSessionTags(mounts.get(s.id), ref, on);
      try {
        const res = await api.setSessionTags(s.id, payload);
        setMounts((prev) => new Map(prev).set(s.id, res.tags));
        useSessionsStore.getState().patchSession(s.id, { tags: res.tags });
      } catch (err) {
        failedIds.push(s.title || s.id);
        showToast(err instanceof ApiError ? err.message : "标签保存失败", "error");
      }
      done++;
      if (targets.length > 1) setProgress({ done, total: targets.length });
    }
    // 勾选态只对成功会话生效（失败项下次点击按快照重算，可重试）
    if (failedIds.length === 0) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (on) next.add(key);
        else next.delete(key);
        return next;
      });
    }
    if (targets.length > 1) {
      showToast(
        failedIds.length === 0
          ? `已为 ${targets.length} 个会话${on ? "打上" : "移除"}标签「${ref.name}」`
          : `${targets.length - failedIds.length}/${targets.length} 成功，${failedIds.length} 个失败`,
        failedIds.length === 0 ? undefined : "error",
      );
    }
    setProgress(null);
    setBusy(false);
  };

  const toggle = (ref: TagRef) => {
    void applyToggle(ref, !selected.has(tagKey(ref)));
  };

  /** 新建标签（计划 115 行两步语义）：空名前端拦截 → 定义整替追加 → 成功后立即勾选挂载 */
  const submitNew = async () => {
    if (creating) return;
    const name = newName.trim();
    if (name === "") {
      setCreateError("标签名不能为空");
      return;
    }
    if (newScope === "project" && !project) {
      setCreateError("无当前项目，无法创建项目标签");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const source = newScope === "global" ? localDefs.global : localDefs.project;
      const next = appendTagEntry(source, name);
      await api.putTags({
        scope: newScope,
        ...(newScope === "project" ? { project } : {}),
        tags: next,
      });
      setLocalDefs((prev) => ({ ...prev, [newScope]: next }));
      onDefsChanged();
      setNewName("");
      await applyToggle({ scope: newScope, name }, true);
    } catch (err) {
      // 重名等 400 直接展示服务端 message（invalid_tags）
      setCreateError(err instanceof ApiError ? err.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const renderGroup = (scope: "global" | "project", label: string) => {
    const entries = scope === "global" ? localDefs.global : localDefs.project;
    return (
      <section data-testid={`tag-group-${scope}`}>
        <h3 className="px-1 pb-1 text-xs font-medium text-muted-foreground">{label}</h3>
        {entries.length === 0 ? (
          <p className="px-1 py-1.5 text-xs text-muted-foreground/60">暂无标签</p>
        ) : (
          <ul>
            {entries.map((d) => {
              const key = tagKey({ scope, name: d.name });
              const checked = selected.has(key);
              return (
                <li key={d.name}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    data-testid="tag-option"
                    data-tag={d.name}
                    disabled={busy}
                    className="flex min-h-11 w-full items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-accent/50 disabled:opacity-50 lg:min-h-8"
                    onClick={() => toggle({ scope, name: d.name })}
                  >
                    <span
                      className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                        checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                      }`}
                    >
                      {checked && <Check className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-sm" data-testid="tag-selector">
        <DialogHeader>
          <DialogTitle>{batch ? `批量标签（${sessions.length} 个会话）` : "会话标签"}</DialogTitle>
          <DialogDescription>
            {batch ? "勾选立即为全部选中会话追加，取消则移除" : "勾选立即保存，无需确认"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {renderGroup("global", "全局标签")}
          {renderGroup("project", "项目标签")}
          {progress && (
            <p className="text-xs text-muted-foreground" data-testid="tag-progress">
              打标中 {progress.done}/{progress.total}…
            </p>
          )}
        </div>
        <div className="space-y-1.5 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">新建标签</p>
          <div className="flex items-center gap-1.5">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="标签名"
              className="h-11 text-sm lg:h-8"
              data-testid="tag-new-input"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitNew();
                }
              }}
            />
            <select
              value={newScope}
              onChange={(e) => setNewScope(e.target.value === "global" ? "global" : "project")}
              className="h-11 shrink-0 rounded-md border bg-transparent px-1.5 text-xs lg:h-8"
              aria-label="新标签 scope"
              data-testid="tag-new-scope"
            >
              <option value="project">项目</option>
              <option value="global">全局</option>
            </select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 shrink-0 gap-1 px-2 text-xs lg:h-8"
              disabled={creating || busy}
              onClick={() => void submitNew()}
              data-testid="tag-new-submit"
            >
              {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              添加
            </Button>
          </div>
          {createError && (
            <p className="text-xs text-destructive" data-testid="tag-new-error">
              {createError}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
