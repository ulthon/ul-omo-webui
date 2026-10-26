// 打标签锚定下拉（docs08-r3 A6）：复用 AnchoredPanel 的非模态浮层，全局/项目两段
// 多选、勾选即存——每次勾选按打开时刻的挂载快照算整替数组，PUT /api/sessions/:id/tags
// 全量替换（applyToggle 语义迁移自原 TagSelector 复选弹框，PUT 语义不改）。单会话与
// 批量同一组件：批量对受影响会话循环 PUT 并显示进度，失败逐条收集统一汇报。
// 纯选择不做快捷新建；底部「管理…」兜底打开 TagManageDialog（scope 由父级按会话
// 归属规则写死传入，跨项目批量传 null 置灰不可用）。设计语言与常用语下拉一致
// （同 AnchoredPanel 同间距规范：w-80 面板 + p-2 滚动区 + border-t 底栏 min-h-9 钮）。
import { useState } from "react";
import { Check, Settings2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { SessionListItem, TagRef } from "@/lib/api";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { useT } from "@/i18n/i18n";
import { apiErrorMessage } from "@/i18n/errors";
import { AnchoredPanel } from "@/components/ui/anchored-panel";
import { tagColorMap, tagKey, nextSessionTags, type TagDefs } from "./tag-data";
import type { TagManageScope } from "./tag-manage-dialog";

interface TagDropdownProps {
  /** 锚定参照元素（触发钮；AnchoredPanel null 时不渲染，父级条件挂载下恒非空） */
  anchor: HTMLElement | null;
  /** 1 个 = 单会话完整复选；多个 = 批量（勾选作用于全部选中会话） */
  sessions: SessionListItem[];
  /** 两段列表的定义集（父级已按会话归属选好：单/同项目 = 该项目单组，跨项目 = 合并去重集） */
  defs: TagDefs;
  /** 底部「管理…」的落点域；null = 跨项目批量，按钮置灰 */
  manageScope: TagManageScope | null;
  onManage: () => void;
  onClose: () => void;
}

/** 初始勾选态：单会话 = 其挂载；批量 = 各会话挂载的并集 */
function initialSelected(sessions: SessionListItem[]): Set<string> {
  const out = new Set<string>();
  for (const s of sessions) for (const t of s.tags ?? []) out.add(tagKey(t));
  return out;
}

export function TagDropdown({ anchor, sessions, defs, manageScope, onManage, onClose }: TagDropdownProps) {
  const showToast = useUiStore((s) => s.showToast);
  const t = useT();
  const batch = sessions.length > 1;
  // 打开时刻的挂载快照：id → 当前挂载 + revision（r9 F1-B1 挂载乐观锁）。连续勾选基于
  // 快照计算（不依赖行数据回流，规避竞态）；每次成功 PUT 后以服务端返回的整替与新
  // revision 进快照，保证同一下拉内连续勾不同标签不互相覆盖、且每次都携最新 baseRevision；
  // 409 = 打开期间被其他端整替：toast 提示并重拉该会话最新挂载进快照（下次点击按新
  // 快照重算可成功），勾选态不变由用户重试
  const [mounts, setMounts] = useState(
    () => new Map(sessions.map((s) => [s.id, { tags: s.tags ?? [], revision: s.tagsRevision }])),
  );
  const [selected, setSelected] = useState(() => initialSelected(sessions));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  /** 勾选/取消：对受影响会话循环 PUT 整替，成功更新快照、行内数据与勾选态 */
  const applyToggle = async (ref: TagRef, on: boolean) => {
    if (busy) return;
    setBusy(true);
    const key = tagKey(ref);
    // 目标会话：on = 不含该标签的；off = 含该标签的（未受影响会话不发请求）
    const targets = sessions.filter((s) => {
      const cur = mounts.get(s.id)?.tags ?? [];
      const has = cur.some((t) => t.scope === ref.scope && t.name === ref.name);
      return on ? !has : has;
    });
    let done = 0;
    const failedIds: string[] = [];
    for (const s of targets) {
      if (targets.length > 1) setProgress({ done, total: targets.length });
      const payload = nextSessionTags(mounts.get(s.id)?.tags ?? [], ref, on);
      try {
        const res = await api.setSessionTags(s.id, payload, "tag-dropdown", mounts.get(s.id)?.revision);
        setMounts((prev) => new Map(prev).set(s.id, { tags: res.tags, revision: res.revision }));
        useSessionsStore.getState().patchSession(s.id, { tags: res.tags });
      } catch (err) {
        failedIds.push(s.title || s.id);
        showToast(apiErrorMessage(err, "sessionList.tagDropdown.saveFailed"), "error");
        if (err instanceof ApiError && err.status === 409) {
          // 冲突会话重拉最新挂载进快照（对端改动不丢），下次点击按新快照重算可成功
          try {
            const fresh = await api.getSessionTags(s.id);
            setMounts((prev) => new Map(prev).set(s.id, { tags: fresh.tags, revision: fresh.revision }));
            useSessionsStore.getState().patchSession(s.id, { tags: fresh.tags });
          } catch {
            // 重拉失败保留旧快照：下次点击仍携旧 revision，服务端 409 继续拦截
          }
        }
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
          ? t(on ? "sessionList.tagDropdown.appliedTo" : "sessionList.tagDropdown.removedFrom", {
              n: targets.length,
              name: ref.name,
            })
          : t("sessionList.tagDropdown.batchResult", {
              ok: targets.length - failedIds.length,
              total: targets.length,
              failed: failedIds.length,
            }),
        failedIds.length === 0 ? undefined : "error",
      );
    }
    setProgress(null);
    setBusy(false);
  };

  const empty = defs.global.length === 0 && defs.project.length === 0;
  // 选择面永远文字+色点（todo 20 (e)）：名称→有效色（显式色 ?? hash），跨 scope 同名全局优先
  const colors = tagColorMap(defs);

  const renderGroup = (scope: "global" | "project", label: string) => {
    const entries = scope === "global" ? defs.global : defs.project;
    return (
      <section data-testid={`tag-group-${scope}`}>
        <h3 className="px-1 pb-1 text-xs font-medium text-muted-foreground">{label}</h3>
        <ul className="rounded-md border">
          {entries.map((d) => {
            const key = tagKey({ scope, name: d.name });
            const checked = selected.has(key);
            return (
              <li key={d.name} className="border-b last:border-b-0">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  data-testid="tag-option"
                  data-tag={d.name}
                  disabled={busy}
                  className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-2 py-2 text-left text-sm transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => void applyToggle({ scope, name: d.name }, !checked)}
                >
                  <span
                    className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                      checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                    }`}
                  >
                    {checked && <Check className="size-3" />}
                  </span>
                  {/* 文字+色点（todo 20 (e)：选择面不做颜色模式） */}
                  <span
                    aria-hidden
                    className="inline size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: colors.get(d.name) }}
                  />
                  <span className="min-w-0 flex-1 truncate" title={d.name}>
                    {d.name}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    );
  };

  return (
    <AnchoredPanel anchor={anchor} open onClose={onClose} data-testid="tag-dropdown" maxHeight={360} className="w-80">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        {batch && (
          <p className="px-1 text-xs text-muted-foreground" data-testid="tag-batch-hint">
            {t("sessionList.tagDropdown.batchHint", { n: sessions.length })}
          </p>
        )}
        {empty ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground" data-testid="tag-dropdown-empty">
            {t("sessionList.tagDropdown.empty")}
          </p>
        ) : (
          <>
            {renderGroup("global", t("sessionList.tagDropdown.globalGroup"))}
            {renderGroup("project", t("sessionList.tagDropdown.projectGroup"))}
          </>
        )}
        {progress && (
          <p className="px-1 text-xs text-muted-foreground" data-testid="tag-progress">
            {t("sessionList.tagDropdown.taggingProgress", { done: progress.done, total: progress.total })}
          </p>
        )}
      </div>
      <div className="shrink-0 border-t p-1">
        <button
          type="button"
          data-testid="tag-manage-open"
          disabled={manageScope === null}
          title={manageScope === null ? t("sessionList.tagDropdown.manageUnavailable") : undefined}
          onClick={onManage}
          className="flex min-h-9 w-full cursor-pointer items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Settings2 className="size-3.5" />
          {t("sessionList.tagDropdown.manage")}
        </button>
      </div>
    </AnchoredPanel>
  );
}
