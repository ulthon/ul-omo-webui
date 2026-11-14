// 会话分支树全屏层（session-branching todo 7）：createPortal + fixed inset-0 遮罩，
// Esc / 点遮罩关闭（复刻 image-lightbox.tsx 骨架）。内容 = GET /api/sessions/:id/tree
// 轻量树（服务端已截 160 字预览，全文绝不下发）：嵌套缩进列表 + role 徽标 +
// line-clamp 预览 + 时间戳；当前路径（activeLeafId 沿 parentId 回溯）高亮、离径
// 分支半透明、分支点子数徽标；unreachableIds 节点不导航且点击出轻提示（task-10
// 缺陷 E-2：禁用态事件穿透只关浮层零反馈）+「已压缩」提示（F14 压缩契约：被压缩
// 剪除的节点仅存于磁盘口径，引擎树已不可达）。点击可达节点 → switchLeaf 编排
// （todo 6，F19 全序收口在 store；resume 意图——task-10 缺陷 E-1 切视图语义，
// 叶=目标本身，绝无 select(user) 编辑位陷阱）→ 关闭浮层回消息流。
// 压缩事件（store compacting 位）置位/结束后树数据失效重拉；不做虚拟化（预览级
// 载荷）、不做跨会话聚合（仅会话内树）。
// task-10 缺陷 G（QA attempt-5 判别实验钉死 overlay 侧）：旧嵌套渲染 li 含整棵子树、
// 按钮 marginLeft 缩进留出左侧条，行命中盒与按钮盒错位——行中心点击落按钮之外
//（缩进条/子树区/行间隙），冒泡到遮罩根 onClick=onClose 静默关浮层零请求零反馈
//（image-lightbox 骨架的卡片层 stopPropagation 复刻时漏掉）。修复三件套：① 行改
// DFS 先序扁平（每行 li 只含自身按钮，缩进走按钮 paddingLeft，w-full 撑满整行
// 命中盒，任意深度行中心必落按钮）；② 卡片层 stopPropagation（卡内非按钮点击
// 不再关浮层）；③ 生产 onSwitchLeaf 由 chat-view 注入 pager 同款回调
//（resolveBranchLeaf+switchLeaf resume 单一代码路径），缺省 fallback 仅为测试 DI 缝。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ListTree, X } from "lucide-react";
import { api } from "@/lib/api";
import type { SessionTreeNode, SessionTreePayload } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { useMessagesStore } from "@/stores/messages";
import { useUiStore } from "@/stores/ui";

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
  /** 缺省接 stores/messages 的 switchLeaf 编排（F19 全序）；生产路径由 chat-view
 *  注入 pager 同款回调（缺陷 G 单一代码路径），此处仅测试 DI 缝 */
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
  // 扁平行（缺陷 G ①）：DFS 先序展平，每行 li 只含自身按钮——按钮 w-full 撑满 li
  // 命中盒（缩进改 paddingLeft），行盒与按钮盒重合，任意深度行中心点击必落按钮
  const rows = useMemo(() => {
    const out: Array<{ node: SessionTreeNode; depth: number }> = [];
    const walk = (list: SessionTreeNode[], depth: number) => {
      for (const n of list) {
        out.push({ node: n, depth });
        const kids = groups.get(n.id) ?? [];
        if (kids.length > 0) walk(kids, depth + 1);
      }
    };
    walk(groups.get(null) ?? [], 0);
    return out;
  }, [groups]);

  const switchLeaf = useCallback(
    (entryId: string) => {
      (onSwitchLeaf ??
        ((id: string) => {
          // resume 意图（task-10 缺陷 E-1）：树点击是切视图——叶=目标条目本身
          //（与角色无关），绝不能以 select 发 user 节点 id（编辑位陷阱）。
          // 生产路径：chat-view 注入 pager 同款回调（resolveBranchLeaf 先行，缺陷
          // G ③）；本缺省仅测试 DI 缝，直连 store 原样 id + resume
          void useMessagesStore.getState().switchLeaf(
            sessionId,
            id,
            {
              navigate: (body) => api.navigate(sessionId, body),
              fetchFull: () => api.listMessages(sessionId, { full: true }),
            },
            "resume",
          );
        }))(entryId);
      onClose();
    },
    [onSwitchLeaf, onClose, sessionId],
  );

  // 行渲染（缺陷 G ① 扁平化）：预览/徽标/路径高亮/不可达口径与旧嵌套版一致
  //（视觉不变：缩进 marginLeft→paddingLeft，根行 8px 与 px-2 等宽）
  const renderRow = ({ node, depth }: { node: SessionTreeNode; depth: number }) => {
    const onPath = pathIds.has(node.id);
    const isUnreachable = unreachable.has(node.id);
    const ts = formatTimestamp(node.timestamp);
    return (
      <li key={node.id} data-testid="session-tree-node" data-node-id={node.id}>
        <button
          type="button"
          aria-disabled={isUnreachable}
          onClick={(e) => {
            // stopPropagation：切叶关闭不走遮罩关闭通道（防双重 onClose）
            e.stopPropagation();
            // 不可达（压缩剪除）点击出轻提示（task-10 缺陷 E-2：不再静默吞——
            // 禁用按钮的事件穿透只关浮层零反馈）；仍不导航不关浮层（F14 禁切不变）
            if (isUnreachable) {
              useUiStore.getState().showToast(t("chat.tree.compactedBlocked"));
              return;
            }
            switchLeaf(node.id);
          }}
          className={`flex w-full items-start gap-2 rounded-lg border px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted ${
            onPath ? "border-primary/50 bg-muted/60" : "border-transparent"
          } ${!onPath && !isUnreachable ? "opacity-50" : ""} ${
            isUnreachable ? "cursor-not-allowed opacity-40" : ""
          }`}
          style={{ paddingLeft: 8 + depth * 16 }}
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
      </li>
    );
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("chat.tree.title")}
      data-testid="session-tree-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      {/* 点卡内不关浮层（缺陷 G ②：image-lightbox.tsx 骨架同款卡片层 stopPropagation——
          旧版缺此行，卡内任意非按钮点击冒泡到遮罩根 onClick=onClose 静默关浮层） */}
      <div
        className="flex max-h-full w-full max-w-2xl flex-col rounded-xl border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
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
            <ul className="flex flex-col gap-1">{rows.map(renderRow)}</ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
