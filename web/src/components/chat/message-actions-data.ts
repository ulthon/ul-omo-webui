// 消息级操作纯助手（todo 25 → session-branching todo 8）：气泡原文提取、fork 重试
// 目标定位（parentId 链上溯，F17 修复）、消息菜单可见项派生与三个菜单动作体
// （从此处分支/编辑重发/重试双路径）。动作体依赖注入（queue-actions 同款模式），
// 组件薄壳传真实实现、测试注入 fake 断言调用序列。
import type { WireEntry, WireMessage } from "@/lib/api";
import type { SwitchLeafDeps, SwitchLeafResult } from "@/stores/messages";
import { staleLeafOf } from "@/stores/messages";
import type { MessageKey } from "@/i18n/i18n";

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

export type MessageMenuItem =
  | "copy"
  | "branchFromHere"
  | "editResend"
  | "editReply"
  | "copyContinue"
  | "retry";

/**
 * 消息菜单可见项派生（todo 8 + todo 9）：复制/重试恒在（重试的 fork 目标缺席由组件层
 * disabled 兜底）；「从此处分支」「编辑重发」仅 user 条目且 treeNavigation=true
 * （IS-4/IS-5：select 语义挂在 user 消息上）；assistant 侧编辑按 editResend 能力位
 * 分流（IS-6，D12）：true=「编辑回复」（edit+continue 原会话续跑链，F12）；false=
 * 降级「复制到新会话续跑」（fork at 含该回复另起会话，功能不砍，F22）。能力位翻转
 * 回退时仅文案与路径切换，入口永不消失。
 */
export function messageMenuItems(opts: {
  role: string | null;
  treeNavigation: boolean;
  editResend?: boolean;
}): MessageMenuItem[] {
  const items: MessageMenuItem[] = ["copy"];
  if (opts.treeNavigation && opts.role === "user") {
    items.push("branchFromHere", "editResend");
  }
  if (opts.role === "assistant") {
    items.push(opts.editResend === false ? "copyContinue" : "editReply");
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
  /** assistant 回复编辑（todo 9，api.editAssistantMessage）：改写副本成新叶不自动续跑。
   *  回传 leafId 为编辑后的新叶（可能是副本下的簿记嫁接条目 id，不假设消息形） */
  editAssistant: (
    sessionId: string,
    body: { entryId: string; text: string; expectedLeafId?: string },
  ) => Promise<{ outcome: string; leafId: string | null; entry?: WireEntry }>;
  /** 从当前叶无新 prompt 续跑（todo 9，api.continueFromLeaf）：编辑后的副本就位后
   *  触发真实回合；expectedLeafId 透传（引擎 wire 面暂不携带，宿主预留 CAS 通道） */
  continueFromLeaf: (sessionId: string, body?: { expectedLeafId?: string }) => Promise<unknown>;
  /** 续跑后刷新编排（todo 9，stores/messages refreshAfterContinue）：full 整替+回跟
   *  活叶+usage 沿；fetch 失败返回 ok:false 不抛（状态保持由调用方处置） */
  refreshAfterContinue: (
    sessionId: string,
    deps: Pick<SwitchLeafDeps, "fetchFull">,
  ) => Promise<{ ok: boolean }>;
  /** 409 stale_leaf 校准（task-10 缺陷 C，stores/messages recalibrateAfterStale）：
   *  full 整替重置本地叶指针并返回新叶；取数失败/槽拆返回 null */
  recalibrateAfterStale: (
    sessionId: string,
    deps: Pick<SwitchLeafDeps, "fetchFull">,
  ) => Promise<string | null>;
  /** 动作失败文案（apiErrorMessage 包装：editFailed/editContinueFailed/copyContinueFailed
   *  作 fallbackKey；失败注入返回固定串即可） */
  actionFailedMessage: (err: unknown, fallbackKey: MessageKey) => string;
  texts: {
    branchNavigateFailed: string;
    retryResent: string;
    retryBranchCreated: string;
    /** todo 9：降级 fork(at) 成功 toast / 续跑后刷新失败的错误卡文案（静态） */
    copyContinueCreated: string;
    editRefreshFailed: string;
  };
}

/** switchLeaf 拒绝分流（task-10 缺陷 D/C）：前置门拒绝（busy/blocked）store 内已出
 *  轻提示 toast，此处不再重复推错误卡（双反馈防线）；引擎/网络拒绝（rejected）
 *  走常驻错误卡（对齐 CLI 可回看），但 errorCarded=true（二次 stale store 已推过
 *  stale_leaf 错误卡）时跳过，防双卡。 */
function pushIfRejected(sessionId: string, res: SwitchLeafResult, deps: MessageActionDeps): void {
  if (res.reason !== "rejected" || res.errorCarded === true) return;
  deps.pushError(sessionId, deps.texts.branchNavigateFailed);
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
    pushIfRejected(sessionId, res, deps);
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
    pushIfRejected(sessionId, res, deps);
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
      pushIfRejected(sessionId, res, deps);
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

/**
 * 「编辑回复」（IS-6 能力位 true 主路径，todo 9；F12 CLI 官配两段链）：
 * editAssistantMessage（改写副本成新叶，expectedLeafId=本地叶指针 CAS 透传）→
 * continueFromLeaf（编辑回传叶再作 CAS 透传，从副本无新 prompt 触发真实回合，
 * 引擎自带 continue-from-leaf system-notice）→ refreshAfterContinue（todo 6 链刷新：
 * full 整替+回跟活叶+usage 沿）。编辑成功后链路不可回滚（引擎无逆操作）：continue
 * 失败仍刷新视图让副本可见（用户可稍后重发消息续跑），错误卡明示续跑未启动。
 * task-10 缺陷 C：edit 的 CAS 跳同受冷引擎挂接簿记漂移波及——首拒 409 stale_leaf
 * 时全量整替校准（recalibrateAfterStale）后带新叶自动重试恰一次（F19 同款，
 * switchLeaf stale 重试镜像）；二次失败交既有错误卡路径。
 */
export async function runEditReply(
  sessionId: string,
  entryId: string,
  text: string,
  expectedLeafId: string | undefined,
  deps: MessageActionDeps,
): Promise<void> {
  let editLeafId: string | null;
  try {
    const edited = await editAssistantWithStaleRetry(sessionId, entryId, text, expectedLeafId, deps);
    editLeafId = edited.leafId;
  } catch (err) {
    deps.pushError(sessionId, deps.actionFailedMessage(err, "chat.messageActions.editFailed"));
    return;
  }
  let continueError: unknown = null;
  try {
    await deps.continueFromLeaf(sessionId, {
      ...(typeof editLeafId === "string" && editLeafId !== "" ? { expectedLeafId: editLeafId } : {}),
    });
  } catch (err) {
    continueError = err;
  }
  const refreshed = await deps.refreshAfterContinue(sessionId, { fetchFull: deps.fetchFull });
  if (continueError !== null) {
    deps.pushError(
      sessionId,
      deps.actionFailedMessage(continueError, "chat.messageActions.editContinueFailed"),
    );
  } else if (!refreshed.ok) {
    // 续跑已启动但视图未刷新（fetch 失败，状态保持）：错误卡明示，SSE/重开可自愈
    deps.pushError(sessionId, deps.texts.editRefreshFailed);
  }
}

/** editAssistantMessage 带 409 stale_leaf 校准重试（task-10 缺陷 C，恰一次）：
 *  非 stale 原样上抛；stale 先全量整替校准（新叶落库）再以引擎拒答自带新叶
 *  （可能缺席→用校准页叶）重发一次，二次失败上抛交调用方错误卡。 */
async function editAssistantWithStaleRetry(
  sessionId: string,
  entryId: string,
  text: string,
  expectedLeafId: string | undefined,
  deps: MessageActionDeps,
): Promise<{ outcome: string; leafId: string | null; entry?: WireEntry }> {
  try {
    return await deps.editAssistant(sessionId, {
      entryId,
      text,
      ...(expectedLeafId !== undefined ? { expectedLeafId } : {}),
    });
  } catch (err) {
    const stale = staleLeafOf(err);
    if (!stale.stale) throw err;
    const pageLeaf = await deps.recalibrateAfterStale(sessionId, { fetchFull: deps.fetchFull }).catch(
      () => null,
    );
    if (pageLeaf === null) throw err; // 校准失败：按原拒绝上抛（错误卡文案取原错误）
    return await deps.editAssistant(sessionId, {
      entryId,
      text,
      expectedLeafId: stale.leafId ?? pageLeaf,
    });
  }
}

/**
 * 「复制到新会话续跑」（IS-6 降级路径，能力位 false，F22）：fork(position="at")
 * 含该 assistant 回复本身另起会话（实调环境差异回退时功能不砍），切到新会话 +
 * 列表刷新 + toast；不自动发送（用户在新会话自由续写；编辑原文能力不在此重建，
 * 菜单文案「复制到新会话续跑」已明示语义差异）。
 */
export async function runCopyContinueNewSession(
  sessionId: string,
  entryId: string,
  deps: MessageActionDeps,
): Promise<void> {
  try {
    const forked = await deps.forkSession(sessionId, { entryId, position: "at" });
    // 切到 fork 会话（human 视图不列 fork 子会话，"全部活动"视图按血缘归组可见）+ 列表刷新
    deps.selectSession(forked.session.id);
    deps.refreshSessions();
    deps.showToast(deps.texts.copyContinueCreated);
  } catch (err) {
    deps.pushError(sessionId, deps.actionFailedMessage(err, "chat.messageActions.copyContinueFailed"));
  }
}
