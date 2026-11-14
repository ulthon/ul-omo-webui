// 会话分支树全屏层（session-branching todo 7）：createPortal + fixed inset-0 遮罩，
// Esc / 点遮罩关闭（复刻 image-lightbox.tsx 骨架）。内容 = GET /api/sessions/:id/tree
// 轻量树（服务端已截 160 字预览，全文绝不下发）：嵌套缩进列表 + role 徽标 +
// line-clamp 预览 + 时间戳；当前路径（activeLeafId 沿 parentId 回溯）高亮、离径
// 分支半透明、分支点子数徽标；unreachableIds 节点禁用 +「已压缩」提示（F14 压缩
// 契约：被压缩剪除的节点仅存于磁盘口径，引擎树已不可达）。点击可达节点 →
// switchLeaf 编排（todo 6，F19 全序收口在 store）→ 关闭浮层回消息流。
// 压缩事件（store compacting 位）置位/结束后树数据失效重拉；不做虚拟化（预览级
// 载荷）、不做跨会话聚合（仅会话内树）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ListTree, X } from "lucide-react";
import { api } from "@/lib/api";
import type { SessionTreeNode, SessionTreePayload } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { useMessagesStore } from "@/stores/messages";

/** 扁平节点列表 → parentId 分组（孤儿/悬空 parentId 兜底挂根，绝不让节点消失：
 *  malformed 防护——空树/缺 activeLeafId 渲染空态提示，不白屏） */
function groupByParent(nodes: SessionTreeNode[]): Map<string | null, SessionTreeNode[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const groups = new Map<string | null, SessionTreeNode[]>();
  for (const node of nodes) {
    const key = typeof node.parentId === "string" && ids.has(node.parentId) ? node.parentId : null;
    const bucket = groups.get(key);
    if (bucket) bucket.push(node);
    else groups.set(key, [node]);
  }
  return groups;
}

/** 当前路径 id 集：从 activeLeafId 沿 parentId 回溯到根（visited 防环） */
function pathIdsOf(nodes: SessionTreeNode[], activeLeafId: string | null): Set<string> {
  const path = new Set<string>();
  if (!activeLeafId) return path;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let cur: SessionTreeNode | undefined = byId.get(activeLeafId);
  while (cur && !path.has(cur.id)) {
    path.add(cur.id);
    const pid = typeof cur.parentId === "string" ? cur.parentId : null;
    cur = pid ? byId.get(pid) : undefined;
  }
  return path;
}

/** 时间戳展示：无效/缺席时间戳渲染空串，不报错 */
function formatTimestamp(ts: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function SessionTreeOverlay({
  sessionId,
  onClose,
  fetchTree,
  onSwitchLeaf,
}: {
  sessionId: string;
  onClose: () => void;
  /** 注入解耦（switchLeaf deps 同款先例）：测试免 mock api 模块；缺省走真实端点 */
  fetchTree?: () => Promise<SessionTreePayload>;
  /** 缺省接 stores/messages 的 switchLeaf 编排（F19 全序）；测试注入桩 */
  onSwitchLeaf?: (entryId: string) => void;
}) {
  const t = useT();
  const [payload, setPayload] = useState<SessionTreePayload | null>(null);
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  // 压缩事件（F14）：store compacting 位置位/结束后树数据失效重拉（浮层开着时）；
  // 关着重开走挂载拉取，无需缓存层
  const compacting = useMessagesStore((s) => s.bySession[sessionId]?.compacting ?? false);

  const load = useCallback(() => {
    let cancelled = false;
    setState("loading");
    (fetchTree ?? (() => api.getSessionTree(sessionId)))().then(
      (data) => {
        if (cancelled) return;
        setPayload(data);
        setState("done");
      },
      () => {
        if (cancelled) return;
        setState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchTree, sessionId]);

  useEffect(() => load(), [load]);

  const firstCompactionRef = useRef(true);
  useEffect(() => {
    if (firstCompactionRef.current) {
      firstCompactionRef.current = false;
      return;
    }
    load();
  }, [compacting, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const nodes = payload?.nodes ?? [];
  const unreachable = useMemo(() => new Set(payload?.unreachableIds ?? []), [payload]);
  const pathIds = useMemo(() => pathIdsOf(nodes, payload?.activeLeafId ?? null), [payload]);
  const groups = useMemo(() => groupByParent(nodes), [payload]);

  const switchLeaf = useCallback(
    (entryId: string) => {
      (onSwitchLeaf ??
        ((id: string) => {
          void useMessagesStore.getState().switchLeaf(sessionId, id, {
            navigate: (body) => api.navigate(sessionId, body),
            fetchFull: () => api.listMessages(sessionId, { full: true }),
          });
        }))(entryId);
      onClose();
    },
    [onSwitchLeaf, onClose, sessionId],
  );

  const renderNodes = (list: SessionTreeNode[], depth: number): React.ReactNode =>
    list.map((node) => {
      const onPath = pathIds.has(node.id);
      const isUnreachable = unreachable.has(node.id);
      const children = groups.get(node.id) ?? [];
      const ts = formatTimestamp(node.timestamp);
      return (
        <li key={node.id} data-testid="session-tree-node" data-node-id={node.id}>
          <button
            type="button"
            disabled={isUnreachable}
            onClick={(e) => {
              // stopPropagation：切叶关闭不走遮罩关闭通道（防双重 onClose）
              e.stopPropagation();
              if (!isUnreachable) switchLeaf(node.id);
            }}
            className={`flex w-full items-start gap-2 rounded-lg border px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted ${
              onPath ? "border-primary/50 bg-muted/60" : "border-transparent"
            } ${!onPath && !isUnreachable ? "opacity-50" : ""} ${
              isUnreachable ? "cursor-not-allowed opacity-40" : ""
            }`}
            style={{ marginLeft: depth * 16 }}
          >
            <span className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
              {node.role}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block line-clamp-2 break-words text-foreground">
                {node.preview || t("chat.tree.emptyPreview")}
              </span>
              <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                {ts && <span>{ts}</span>}
                {node.childCount > 1 && (
                  <span
                    data-testid="session-tree-branch-count"
                    className="rounded-full bg-muted px-1.5 py-0.5 tabular-nums"
                  >
                    {t("chat.tree.branchCount", { n: node.childCount })}
                  </span>
                )}
                {onPath && <span className="text-primary">{t("chat.tree.currentLeaf")}</span>}
                {isUnreachable && <span>{t("chat.tree.compacted")}</span>}
              </span>
            </span>
          </button>
          {children.length > 0 && <ul className="mt-1 flex flex-col gap-1">{renderNodes(children, depth + 1)}</ul>}
        </li>
      );
    });

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("chat.tree.title")}
      data-testid="session-tree-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col rounded-xl border bg-background shadow-lg">
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
          <ListTree className="size-5 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-medium">{t("chat.tree.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("chat.tree.close")}
            className="ml-auto flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="session-tree-body">
          {state === "loading" && <p className="p-4 text-sm text-muted-foreground">{t("chat.tree.loading")}</p>}
          {state === "error" && <p className="p-4 text-sm text-muted-foreground">{t("chat.tree.loadFailed")}</p>}
          {state === "done" && nodes.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">{t("chat.tree.empty")}</p>
          )}
          {state === "done" && nodes.length > 0 && (
            <ul className="flex flex-col gap-1">{renderNodes(groups.get(null) ?? [], 0)}</ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
