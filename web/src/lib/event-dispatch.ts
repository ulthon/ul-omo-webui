// SSE 帧分发（计划 todo 14）：把 {projectPath, event, durableSessionId?} wire 帧按会话路由进 stores。
// 路由键优先取信封 durableSessionId（durable 会话 id，与 REST 的会话 id 一致），缺席回退
// wire sessionId（holder 别名 rpc-N，服务端映射不明时如实不注入）。主通道 messages.applyWireEvent
// （消息/流式/工具生命周期，未知类型静默忽略）；会话级运行状态（agent_start/end/settled/idle）
// 同步进 sessions store，供 todo 15 状态点消费。
// gap 帧 / 游标回退（服务端重启游标归零）→ 对已加载会话做全量 refetch（GET messages
// 先取后换，重取期间界面不清空），替代增量补发——覆盖手机杀后台数分钟的场景。
// docs08-r5 任务 5：服务端重放窗口标记（replay_begin/replay_done 桥级帧，包夹重放序列）
// 转译为 messages store 恢复窗口置位/复位，窗口内抑制已落库段的重播重建（语义见 store）。
// 运行态自愈（W1 缺陷 #3）：服务重启会孤儿化前端 runStates（状态点永卡「运行中」）。
// 两路修复——(1) 周期清扫：每 60s 把无活动超阈值的 running/waiting 回落 idle（阈值
// 常量在 stores/sessions.ts），该会话任何 SSE 帧都刷新活动时刻，活跃会话不被误回落；
// (2) 游标回退（=服务重启强信号）时在 refetchLoadedSessions 旁并行 fire-and-forget
// GET /api/sessions 重同步（active 三态校准，见 resyncRunStatesFromServer）。
import { api } from "@/lib/api";
import { sseDebugEnabled } from "@/lib/events";
import { t } from "@/i18n/i18n";
import { broadcastUsageRefresh } from "@/components/chat/compact-run";
import { useMessagesStore, type WireEvent } from "@/stores/messages";
import { usePermissionsStore, type PermissionMethod, type PermissionRequest } from "@/stores/permissions";
import { useQuestionsStore, type QuestionRequest, type QuestionSpec } from "@/stores/questions";
import { useQueueStore } from "@/stores/queue";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

/** 最后见到的全局游标（SSE id 行）；null = 尚未收到任何事件。用于服务端游标归零检测。 */
let lastCursor: number | null = null;

/** 进行中的全量重取（按会话去重：gap + 游标回退连击时不重复拉取） */
const refetching = new Set<string>();

/** 运行态清扫周期（W1 缺陷 #3）：60s 一扫；回落阈值常量见 stores/sessions.ts。 */
export const SWEEP_INTERVAL_MS = 60_000;

/** 运行态清扫定时器（首个 SSE 帧到达时布防——runStates 只能由 SSE 写入，先有帧后有态；
 * resetDispatchState 拆防，单测隔离用） */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function armRunStateSweep(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    useSessionsStore.getState().sweepStaleRunStates();
  }, SWEEP_INTERVAL_MS);
  // bun 单测环境不挂住进程退出（浏览器 Timer 无 unref，可选调用自动跳过）
  (sweepTimer as unknown as { unref?: () => void }).unref?.();
}

function disarmRunStateSweep(): void {
  if (sweepTimer === null) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

/** 清扫是否已布防（单测断言用） */
export function isRunStateSweepArmed(): boolean {
  return sweepTimer !== null;
}

/** 四型对话框 UI method（verification/02）；extension_ui_request 其余 method
 *  （omo 扩展的 setStatus/notify 等噪音）不计入"等待权限"。
 *  question（q1 提问卡片）单独分支处理——结构化载荷（questions 数组）与四型的
 *  title/options 平铺不同，且 waitForAnswer 语义不同（false 不阻塞回合）。 */
const DIALOG_UI_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

/** question 帧的 questions 数组窄化（wire 从宽甄别：异形条目跳过，全空则不入队）；
 * 丢弃路径在 DEBUG_SSE 下留诊断（ul_omo_debug_sse=1 或 ?debugSse=1）——否则
 * question 帧静默消失无从排查（引擎侧 questions 载荷漂移的直接线索）。 */
function narrowQuestionSpecs(raw: unknown): QuestionSpec[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    if (sseDebugEnabled()) {
      console.debug(`[sse-dispatch] question questions 载荷丢弃：非数组或空（${Array.isArray(raw) ? "empty" : typeof raw}）`)
    }
    return null
  }
  const out: QuestionSpec[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const q = item as Record<string, unknown>;
    if (typeof q.id !== "string" || typeof q.question !== "string") continue;
    const options = Array.isArray(q.options)
      ? q.options.filter(
          (o): o is { label: string; description?: string } =>
            typeof o === "object" && o !== null && typeof (o as { label?: unknown }).label === "string",
        )
      : [];
    out.push({
      id: q.id,
      header: typeof q.header === "string" ? q.header : "",
      question: q.question,
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  if (out.length === 0) {
    if (sseDebugEnabled()) {
      console.debug(`[sse-dispatch] question questions 全部异形丢弃：count=${raw.length}`)
    }
    return null
  }
  return out
}

/** 页面可见性（bun 单测环境无 document，按可见兜底） */
function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/** 当前分发游标（单测断言用） */
export function getDispatchCursor(): number | null {
  return lastCursor;
}

/** 重置分发层状态（单测隔离用） */
export function resetDispatchState(): void {
  lastCursor = null;
  refetching.clear();
  disarmRunStateSweep();
}

/** 单会话全量重取（gap/游标回退校准与 synthetic settle 补拉共用）：
 * GET messages 后 setEntries 整替（先取后换，重取期间界面不清空）。
 * store 外会话不拉（客户端未关心过）；进行中的重取按会话去重。
 * 失败静默——下一次 gap / 游标回退 / 重连重放再兜底，不打断实时流。 */
function refetchSession(sessionId: string): void {
  if (refetching.has(sessionId)) return;
  if (!useMessagesStore.getState().bySession[sessionId]) return;
  refetching.add(sessionId);
  api
    .listMessages(sessionId)
    .then((page) => {
      // 重取完成时会话可能已被 clearSession（删除/切换清理），仅在仍存在时替换
      if (useMessagesStore.getState().bySession[sessionId]) {
        useMessagesStore.getState().setEntries(sessionId, page.entries, page.cursor, page.leafId);
      }
    })
    .catch(() => {
      // 网络瞬断等；401 已由 api 层跳登录。留待下次兜底。
    })
    .finally(() => {
      refetching.delete(sessionId);
    });
}

/** 已加载 / 有过活动的会话全量重取。
 * store 中存在的会话 = 客户端关心过的会话（打开过或流式过），gap/游标回退时全部
 * 校准；refetch 的 setEntries 会置 loaded=true，语义诚实（确实做了全量加载）。 */
export function refetchLoadedSessions(): void {
  const { bySession } = useMessagesStore.getState();
  for (const [sessionId] of Object.entries(bySession)) {
    refetchSession(sessionId);
  }
}

/** 排队快照对账（docs08-r4 任务 11，spike 指引 2）：断线重连（游标回退）时对已加载
 * 会话拉一次 GET queue——queue_update 是增量事件不重放，重连窗口内的入队/出队只有
 * 快照能校准。失败静默（下次回退/渲染兜底）。 */
export function resyncQueues(): void {
  for (const sessionId of Object.keys(useMessagesStore.getState().bySession)) {
    api
      .getQueue(sessionId)
      .then((snapshot) => {
        useQueueStore.getState().setSnapshot(sessionId, snapshot);
      })
      .catch(() => {
        // 网络瞬断 / 引擎未就绪静默：下一次回退或打开会话兜底
      });
  }
}

/** 服务重启（游标回退）后的运行态重同步（W1 缺陷 #3）：与 refetchLoadedSessions 并行
 * fire-and-forget——refetchSession 本身逐会话发射，没有「全部完成」时刻可耦合。
 * GET /api/sessions 聚合快照按服务端 runState 三态直接对齐（docs08-r6 任务 11：
 * 服务端为真相源，三源推导见 EngineGateway.peekRunStates）：
 *   runState === null / 列表缺席（引擎未就绪 / 跨端已删）→ 不动；
 *   running / waiting / idle → 直接对齐（含 error——服务端已无回合在途；同态不重写，
 *   不刷活动账本时刻，不推迟清扫兜底）；旧服务端未下发字段时全体不动，交清扫兜底。
 * 快照竞态（快照 running 但回合恰在拉取后落定）短暂误 running 可接受——10min 无
 * 活动清扫自愈。失败静默同 refetch。 */
function resyncRunStatesFromServer(): void {
  api
    .listSessions({ archived: "all" })
    .then(({ sessions }) => {
      const byId = new Map(sessions.map((item) => [item.id, item]));
      const store = useSessionsStore.getState();
      for (const [id, state] of Object.entries(store.runStates)) {
        const server = byId.get(id)?.runState;
        if (server !== "running" && server !== "waiting" && server !== "idle") continue; // 缺席 / null（引擎未就绪）不动
        if (state !== server) store.setRunState(id, server);
      }
    })
    .catch(() => {
      // 网络瞬断静默：无活动清扫兜底
    });
}

/**
 * SSE 帧统一入口（events.ts 调用）。
 * eventType = event: 行原文（wire type 或 "gap"）；data = data: 行 JSON 原文；
 * cursor = id: 行游标（缺失/非法为 null）。
 */
export function dispatchSseEvent(eventType: string, data: string, cursor: number | null): void {
  armRunStateSweep(); // 首帧布防运行态清扫（幂等）
  let frame: { event?: unknown; durableSessionId?: unknown };
  try {
    frame = JSON.parse(data) as { event?: unknown; durableSessionId?: unknown };
  } catch {
    return; // 非 JSON 帧容错忽略
  }

  // 游标记账 + 回退检测：新纪元 id 小于旧游标即服务端重启归零，有不可补的丢失
  if (typeof cursor === "number") {
    if (lastCursor !== null && cursor < lastCursor) {
      refetchLoadedSessions();
      resyncQueues();
      // 运行态重同步并行发射（W1 缺陷 #3）：消息全量重取不覆盖 runStates，两路独立校准
      resyncRunStatesFromServer();
    }
    lastCursor = cursor;
  }

  if (eventType === "gap") {
    refetchLoadedSessions();
    resyncQueues();
    return;
  }

  // docs08-r5 任务 5：服务端重放窗口标记（桥级帧，无会话身份，data 为纯元数据非信封）→
  // store 恢复窗口置位/复位。begin/done 只包夹实际重放的帧，实时扇出路径零改动；
  // 游标记账已在上方完成（marker id 取重放帧流水，单调不触发回退）。
  if (eventType === "replay_begin") {
    useMessagesStore.getState().beginReplayRecovery();
    return;
  }
  if (eventType === "replay_done") {
    useMessagesStore.getState().endReplayRecovery();
    return;
  }

  const event = frame.event;
  if (event === null || typeof event !== "object") return;
  const wire = event as WireEvent;
  // store 路由键：信封 durableSessionId 优先（与 REST 会话 id 一致），缺席回退 wire sessionId
  const durableSessionId =
    typeof frame.durableSessionId === "string" && frame.durableSessionId.length > 0 ? frame.durableSessionId : null;
  const wireSessionId = typeof wire.sessionId === "string" ? wire.sessionId : null;
  const sessionId = durableSessionId ?? wireSessionId;
  if (!sessionId) return; // 无会话路由信息的桥级事件不进 store

  // D18 诊断（ul_omo_debug_sse 开关）：帧到达 + 分发目标键 + 与选中键的错配信号。
  // route ≠ selected 且为消息类帧 = "消息写进不可见槽"（durableLookup miss 键错配嫌疑）的直接证据。
  if (sseDebugEnabled()) {
    const selected = useSessionsStore.getState().selectedId;
    const mismatch = selected !== null && sessionId !== selected;
    console.debug(
      `[sse-dispatch] type=${eventType} cursor=${cursor ?? "-"} durable=${durableSessionId ?? "-"} wire=${wireSessionId ?? "-"} route=${sessionId} selected=${selected ?? "-"}${mismatch ? " MISMATCH" : ""}`,
    );
  }

  // 活动记账（W1 缺陷 #3）：该会话任何 SSE 帧都刷新运行态活动时刻——流式 chunk / 工具
  // 事件持续到达即活跃，永不被 60s 清扫回落；无运行态时 no-op。
  useSessionsStore.getState().touchRunStateAt(sessionId);

  // 会话级运行状态（active 语义对齐 GET /api/sessions 的引擎活跃探询；runStates 供状态点）
  const sessions = useSessionsStore.getState();
  if (wire.type === "agent_start") {
    sessions.patchSession(sessionId, { active: true });
    sessions.setRunState(sessionId, "running");
  } else if (wire.type === "agent_end" || wire.type === "agent_settled" || wire.type === "agent_idle") {
    sessions.patchSession(sessionId, { active: false });
    // 回合落定即落 idle（权威空闲：GET sessions 的 active 不回落，learnings todo 14；
    // 权限门阻塞回合，P0-2 实证：挂起权限回合不结束——agent_end 到达即权限已落定）
    sessions.setRunState(sessionId, "idle");
    // 回合自然结束补拉会话列表（task 19h，fire-and-forget）：对齐服务端真相——
    // durable=true 创建的占位行由 pendingIds 保护至列表带回，此后真实行落位，
    // 消息计数/标题等元数据同步；失败静默（下次回合结束/手动刷新兜底）。
    void sessions.refreshSessions();
    // 回合落定即权限队列全落定（含应答后 UI 未及时移除的残留），整队清空
    usePermissionsStore.getState().clearSession(sessionId);
    // synthetic settle（server settle_watchdog / engine_crash 合成）：真实回合事件
    // 未送达（引擎事件断流），applyWireEvent 定格不到 assistant 内容——按 server
    // 设计约定补拉 GET messages，兜底显示已落盘的回复（真实事件流零此开销）
    if (wire.type === "agent_settled" && wire.synthetic === true) {
      refetchSession(sessionId);
    }
  } else if (wire.type === "extension_ui_request") {
    const method = typeof wire.method === "string" ? wire.method : null;
    if (method === "question") {
      // q1 提问卡片：结构化问题帧（waitForAnswer=true 阻塞回合 → waiting）
      const questions = narrowQuestionSpecs(wire.questions);
      if (typeof wire.id === "string" && wire.id && questions) {
        if (wire.waitForAnswer === true) sessions.setRunState(sessionId, "waiting");
        const request: QuestionRequest = {
          id: wire.id,
          waitForAnswer: wire.waitForAnswer === true,
          questions,
          deadlineAtMs: typeof wire.deadlineAtMs === "number" ? wire.deadlineAtMs : Date.now() + 30 * 60_000,
          timeout: typeof wire.timeout === "number" ? wire.timeout : 30 * 60_000,
        };
        useQuestionsStore.getState().pushRequest(sessionId, request);
      }
    } else if (method !== null && DIALOG_UI_METHODS.has(method)) {
      sessions.setRunState(sessionId, "waiting");
      // 四型载荷入权限队列（todo 18）：无 toolCallId，按会话内未决请求建模
      const request = wire as unknown as PermissionRequest & { id?: unknown; method?: unknown };
      if (typeof request.id === "string" && request.id) {
        usePermissionsStore.getState().pushRequest(sessionId, {
          id: request.id,
          method: method as PermissionMethod,
          title: typeof request.title === "string" ? request.title : "",
          options: Array.isArray(request.options) ? request.options.map(String) : undefined,
          message: typeof request.message === "string" ? request.message : undefined,
          placeholder: typeof request.placeholder === "string" ? request.placeholder : undefined,
          prefill: typeof request.prefill === "string" ? request.prefill : undefined,
        });
      }
    } else if (method === "notify") {
      // fire-and-forget 型决策（计划 249）：notify 做轻提示不应答；setStatus/setWidget/setTitle
      // 纯引擎/扩展内部状态，忽略不渲染（决策记录见 learnings todo 18）。
      const message = typeof wire.message === "string" ? wire.message : "";
      if (message) useUiStore.getState().showToast(message, "info");
    }
  } else if (wire.type === "error" || wire.type.endsWith("_error")) {
    // 引擎 wire 类型为开放集且无专用出错事件；容错识别 error 尾缀类型映射出错状态点
    sessions.setRunState(sessionId, "error");
  }

  // 未读计数：新 assistant 消息到达且非查看态（未选中或页面后台）→ +1。
  // 清零由列表组件在选中且页面可见时 POST /:id/read（"任一设备查看即清零"）。
  if (wire.type === "message_end") {
    const msg = wire.message;
    const isAssistant = typeof msg === "object" && msg !== null && (msg as { role?: unknown }).role === "assistant";
    const viewing = sessions.selectedId === sessionId && pageVisible();
    if (isAssistant && !viewing) sessions.bumpUnread(sessionId);
  }

  // 排队列表增量（docs08-r4 任务 11，spike (b)-2）：queue_update 载荷
  // {steering[], followUp[], ordered:[{text,mode,enqueueOrder}]}，ordered 为引擎侧
  // 全量真相（入队与出队都宣布）。主通道 applyWireEvent 对未知类型静默忽略，此处分流。
  if (wire.type === "queue_update") {
    const ordered = Array.isArray(wire.ordered) ? (wire.ordered as Array<Record<string, unknown>>) : [];
    useQueueStore.getState().applyUpdate(sessionId, ordered);
  }

  // 模型切换可观测（docs08-r6 任务 8 ③④⑤⑥）：
  // - model_changed（引擎每次成功切换必发：本端 prompt 注入 setModel、异端/CLI 切换、
  //   引擎 fallback 同源）：归一 "provider/model" 写会话生效模型——胶囊待生效徽标、
  //   水位环 tooltip 与分母校准的数据源。不写 selectedModel（不回写偏好语义）。
  // - model_change_rejected（引擎守卫拒绝：reason=context-budget/auth，会话 jsonl 落
  //   model_change_rejected 条目）：error toast 明示切换未生效；不动 runState——拒绝
  //   不改变回合进行状态（toast 不得污染状态点）。载荷形态 engine agent-session
  //   _recordRejectedModelChange：{model:{provider,id}, reason, detail}。
  if (wire.type === "model_changed") {
    const m = wire.model as { provider?: unknown; id?: unknown } | undefined;
    if (
      typeof m === "object" && m !== null && typeof m.provider === "string" && m.provider &&
      typeof m.id === "string" && m.id
    ) {
      useSessionsStore.getState().setAppliedModel(sessionId, `${m.provider}/${m.id}`);
    }
  } else if (wire.type === "model_change_rejected") {
    const m = wire.model as { id?: unknown } | undefined;
    const model = typeof m === "object" && m !== null && typeof m.id === "string" && m.id ? m.id : "";
    const detail = typeof wire.detail === "string" && wire.detail ? wire.detail : "";
    useUiStore.getState().showToast(t("common.lib.modelChangeRejected", { model, detail }), "error");
  }

  // 压缩生命周期（docs08-r6 任务 18 ①②⑥，引擎事件形态实测：start 携 reason
  //  threshold/overflow/manual，end 携 status completed/declined）：
  // - start/progress → 消息流顶部「正在压缩上下文…」进行条置位（end 消除，帧丢失由
  //   store 兑底回落）；主通道 applyWireEvent 对这两类静默忽略，此处分流。
  // - start 且 reason!=manual（自动压缩，用户无感知触发）→ 轻提示 toast；重放窗口内
  //   （replay_begin/done 包夹）不提示，防重连重播重复弹。
  // - end → 进行条消除；status!=declined（实际压缩发生）时广播 usage 重拉（水位环/
  //   状态条重拉权威快照，504 超时路径的后台完成补偿）。
  if (wire.type === "compaction_start" || wire.type === "compaction_progress") {
    useMessagesStore.getState().setCompacting(sessionId, true);
    if (
      wire.type === "compaction_start" &&
      wire.reason !== "manual" &&
      !useMessagesStore.getState().replayRecovering
    ) {
      useUiStore.getState().showToast(t("chat.compact.autoStarted"), "info");
    }
  } else if (wire.type === "compaction_end") {
    useMessagesStore.getState().setCompacting(sessionId, false);
    if (wire.status !== "declined") {
      broadcastUsageRefresh();
      // 摘要条目对账（docs08-r6 任务 19g）：压缩完成后渲染层依赖 type:"compaction"
      // 条目入列派生标记块，实时通道靠 entry_appended（stores 白名单放行）。帧丢失场景
      // （压缩期间断线重连 / 传输粘滞切换，F3 走查实录）下补拉一次 GET messages
      // （游标增量、失败静默，与 synthetic settle 补拉同模式），标记块不等到刷新才出现。
      refetchSession(sessionId);
    }
  }

  // 提问卡片生命周期（q1）：updated 刷截止；resolved 终局出队（超时/取消/异端应答）
  if (wire.type === "question_updated" && typeof wire.id === "string") {
    if (typeof wire.deadlineAtMs === "number") {
      useQuestionsStore.getState().updateDeadline(sessionId, wire.id, wire.deadlineAtMs);
    }
  } else if (wire.type === "question_resolved" && typeof wire.id === "string") {
    useQuestionsStore.getState().removeRequest(sessionId, wire.id);
  }

  // 消息主通道（未知类型在 store 内静默忽略）
  useMessagesStore.getState().applyWireEvent(sessionId, wire);
}
