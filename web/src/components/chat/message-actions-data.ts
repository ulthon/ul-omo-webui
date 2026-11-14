// 消息级操作纯助手（todo 25 → session-branching todo 8）：气泡原文提取、fork 重试
// 目标定位（parentId 链上溯，F17 修复）、消息菜单可见项派生与三个菜单动作体
// （从此处分支/编辑重发/重试双路径）。动作体依赖注入（queue-actions 同款模式），
// 组件薄壳传真实实现、测试注入 fake 断言调用序列。
import type { WireEntry, WireMessage } from "@/lib/api";
import type { SwitchLeafDeps, SwitchLeafResult } from "@/stores/messages";

/** 气泡消息的 markdown 原文：text part 按序拼接（thinking/toolCall/image 等 part 不算原文） */
export function messageRawText(message: WireMessage): string {
  const parts = Array.isArray(message.content) ? message.content : [];
  const texts = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string);
  return texts.join("\n\n");
}

/** 条目的消息角色（双形态兼容：GET 定格 type="message"，SSE 实时 message_start/message_end） */
export function entryRole(entry: WireEntry | undefined): string | null {
  const msg = entry?.message as WireMessage | undefined;
  return typeof msg?.role === "string" ? msg.role : null;
}

/**
 * fork 重试目标：重试 = 从触发回复的那条 user 消息重新生成分支。
 * role=user 取自身；role=assistant 沿 parentId 链上溯找最近一条 user 条目
 * （F17 修复：原数组序向前扫描在多分支平铺下会串到别的分支的 user 消息，
 * 上溯只走本条祖先链，跨支不串台）。
 * 引擎 fork position="before" 仅接受 user 消息条目，找不到返回 null（入口禁用）。
 * parentId 指向不在场条目（未加载窗/被压缩）即止步；visited 防环（坏数据收敛）。
 */
export function findForkTargetEntry(entries: WireEntry[], entryId: string, role: string): WireEntry | null {
  const byId = new Map<string, WireEntry>();
  for (const e of entries) {
    const id = e.id;
    if (typeof id === "string" && id !== "" && !byId.has(id)) byId.set(id, e);
  }
  if (role === "user") return byId.get(entryId) ?? null;
  let cur: WireEntry | undefined = byId.get(entryId);
  const visited = new Set<string>();
  while (cur && typeof cur.id === "string" && !visited.has(cur.id)) {
    visited.add(cur.id);
    if (entryRole(cur) === "user" && cur.id) return cur;
    const parent = cur.parentId;
    cur = typeof parent === "string" && parent !== "" ? byId.get(parent) : undefined;
  }
  return null;
}

export type MessageMenuItem = "copy" | "branchFromHere" | "editResend" | "retry";

/**
 * 消息菜单可见项派生（todo 8）：复制/重试恒在（重试的 fork 目标缺席由组件层
 * disabled 兜底）；「从此处分支」「编辑重发」仅 user 条目且 treeNavigation=true
 * （IS-4/IS-5：select 语义挂在 user 消息上，assistant 侧编辑是 todo 9 域）。
 */
export function messageMenuItems(opts: { role: string | null; treeNavigation: boolean }): MessageMenuItem[] {
  const items: MessageMenuItem[] = ["copy"];
  if (opts.treeNavigation && opts.role === "user") {
    items.push("branchFromHere", "editResend");
  }
  items.push("retry");
  return items;
}

/** 菜单动作依赖注入（组件传真实实现；测试注入 fake 断言调用序列） */
export interface MessageActionDeps {
  /** 叶切换编排（todo 6 switchLeaf）：已含 navigate(select)+清流式态+full 整替+viewLeafId */
  switchLeaf: (
    sessionId: string,
    entryId: string,
    deps: SwitchLeafDeps,
  ) => Promise<SwitchLeafResult>;
  navigate: SwitchLeafDeps["navigate"];
  fetchFull: SwitchLeafDeps["fetchFull"];
  /** 服务端草稿写入（api.putDraft）——编辑重发/从此此处分支的唯一回填文本载体 */
  putDraft: (sessionId: string, content: string) => Promise<unknown>;
  /** 回填信号 bump（uiStore.bumpDraftRefill）：输入框重拉服务端草稿（非文本载体） */
  bumpDraftRefill: (sessionId: string) => void;
  /** 常规发送通道（既有 prompt 路径，长新分支） */
  prompt: (sessionId: string, body: { text: string }) => Promise<unknown>;
  /** 降级 fork 路径（IS-8：能力位 false 时重试保留） */
  forkSession: (
    sessionId: string,
    body: { entryId: string; position?: "before" | "at" },
  ) => Promise<{ session: { id: string }; text: string }>;
  selectSession: (sessionId: string) => void;
  refreshSessions: () => void;
  /** 会话内错误卡（重试失败等，对齐 CLI 常驻可回看） */
  pushError: (sessionId: string, message: string) => void;
  showToast: (text: string) => void;
  /** ApiError → 本地化文案（apiErrorMessage 包装；失败注入返回固定串即可） */
  retryFailedMessage: (err: unknown) => string;
  texts: {
    branchNavigateFailed: string;
    retryResent: string;
    retryBranchCreated: string;
  };
}

/**
 * 「从此此处分支」（IS-5）：navigate(select 该 user 条目)→switchLeaf 编排——叶移到
 * 该消息之前的位置，绝不自动发送（用户自由输入新方向）；引擎 select user 命中时回传
 * editorText，按编辑重发同纪律回填（putDraft 单源 + 回填信号，见 refillDraft）。
 */
export async function runBranchFromHere(
  sessionId: string,
  entryId: string,
  deps: MessageActionDeps,
): Promise<void> {
  const res = await deps.switchLeaf(sessionId, entryId, {
    navigate: deps.navigate,
    fetchFull: deps.fetchFull,
  });
  if (!res.ok) {
    deps.pushError(sessionId, deps.texts.branchNavigateFailed);
    return;
  }
  if (res.editorText) await refillDraft(sessionId, res.editorText, deps);
}

/**
 * 「编辑重发」（IS-4）：navigate(select)→switchLeaf 编排（叶移到该 user 消息之前）→
 * putDraft(editorText ?? 本地原文) 单一回填源 + 回填信号——putDraft 之后绝无内存
 * handoff（composerInject 通道不复用，防双源赛跑）；输入框重拉时受空才回填守卫
 * （canRestoreRef）保护。用户改完经既有 prompt 通道发送即长新分支，原消息永在树中。
 */
export async function runEditResend(
  sessionId: string,
  entryId: string,
  localText: string,
  deps: MessageActionDeps,
): Promise<void> {
  const res = await deps.switchLeaf(sessionId, entryId, {
    navigate: deps.navigate,
    fetchFull: deps.fetchFull,
  });
  if (!res.ok) {
    deps.pushError(sessionId, deps.texts.branchNavigateFailed);
    return;
  }
  const text = res.editorText ?? localText;
  if (text) await refillDraft(sessionId, text, deps);
}

/** 服务端草稿落库 + 重拉信号（单一回填源纪律 F20：文本只走 putDraft，信号只触发拉取） */
async function refillDraft(sessionId: string, text: string, deps: MessageActionDeps): Promise<void> {
  await deps.putDraft(sessionId, text);
  deps.bumpDraftRefill(sessionId);
}

/**
 * 「重试」双路径（IS-8）：treeNavigation=true → navigate(select)+prompt 原会话长
 * 新分支（与编辑重发同链，不回填草稿——重试立即重发原文，命令文本维持现状直发
 * 不过新门）；false → 既有 fork 降级路径（fork before + 切会话 + 自动重发）。
 * toast 文案随路径。
 */
export async function runRetry(
  sessionId: string,
  entryId: string,
  text: string,
  treeNavigation: boolean,
  deps: MessageActionDeps,
): Promise<void> {
  if (treeNavigation) {
    const res = await deps.switchLeaf(sessionId, entryId, {
      navigate: deps.navigate,
      fetchFull: deps.fetchFull,
    });
    if (!res.ok) {
      deps.pushError(sessionId, deps.texts.branchNavigateFailed);
      return;
    }
    try {
      await deps.prompt(sessionId, { text });
      deps.showToast(deps.texts.retryResent);
    } catch (err) {
      deps.pushError(sessionId, deps.retryFailedMessage(err));
    }
    return;
  }
  try {
    const forked = await deps.forkSession(sessionId, { entryId, position: "before" });
    // 切到 fork 会话（human 视图不列 fork 子会话，"全部活动"视图按血缘归组可见）+ 列表刷新
    deps.selectSession(forked.session.id);
    deps.refreshSessions();
    deps.showToast(deps.texts.retryBranchCreated);
    // 重试语义：fork 的新会话是该消息之前的上下文，自动重发原消息触发新一轮生成
    if (forked.text) {
      await deps.prompt(forked.session.id, { text: forked.text });
    }
  } catch (err) {
    deps.pushError(sessionId, deps.retryFailedMessage(err));
  }
}
