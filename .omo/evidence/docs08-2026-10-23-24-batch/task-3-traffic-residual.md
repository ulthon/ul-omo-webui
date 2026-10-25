# 任务 3：残余全量路径证据固化与流量收敛设计

- 计划：docs08-2026-10-23-24-batch 任务 3（READ-ONLY 分析 + 设计 spike，无产品代码改动）
- 基线：main@64d90f2（本 worktree docs08-batch/w0-t3）
- 已知背景：r7 已落地首载尾窗直读（`readTailEntries`、`TAIL_WINDOW=200`，无 cursor 首载走磁盘尾窗、`?before=` 后向翻页）；流量计量基建 8b18a9a 在源码但生产未运行（量化留部署后）。

---

## 一、三条残余全量路径证据（file:line + 实读代码摘录）

### 路径 1：SSE 新连接全量回放（无 Last-Event-ID → afterId=0 → replay 整个环形缓冲）

**行为链**：浏览器新开标签（或首连）时原生 EventSource 不带 `Last-Event-ID` → 服务端按 0 处理 → `bus.replay(0)` 返回缓冲内全部帧（`id > 0`）→ 逐帧写入 SSE 流。每个标签独立一条连接、各自独立回放同一份缓冲；缓冲内含流式大帧 `message_update`（部分内容累计帧，单帧可携带整段已流式内容），是字节量主体。环形缓冲容量 1000（生产装配 `index.ts:104`）。

**证据 1 —— 无 Last-Event-ID 归零**（`server/src/api/sse.ts:313-316`，实读摘录）：

```ts
// Last-Event-ID：原生 EventSource 重连自动携带；非法值按 0 处理
//（0 = 从头/从缓冲最旧开始，越界时自然走 gap 路径）
const raw = c.req.header("Last-Event-ID")
const parsed = raw === undefined ? 0 : Number.parseInt(raw, 10)
const afterId = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
```

首连 `raw === undefined` → `afterId = 0`。

**证据 2 —— replay(0) 快照全量入队**（`server/src/api/sse.ts:386-401`，实读摘录）：

```ts
const replay = bus.replay(afterId)
...
const replayEvents = filterStaleUiRequests(
  replay.events,
  durableLookup,
  isEngineRunning ?? (() => true),
)
```

`replay.events` 未做条数截断（只有陈旧 UI 请求过滤），全部进入下方的 `for (const e of replayEvents) conn.queue.push(...)` 逐帧写出（sse.ts:426-429）。多标签 = 多连接，各自独立执行本路径。

**证据 3 —— replay 过滤即 `id > afterId`，无窗口上限**（`server/src/engine/events.ts:122-140`，实读摘录）：

```ts
replay(afterId: number): ReplayResult {
  const events = this.buffer.filter((e) => e.id > afterId)
  ...
  const oldest = this.buffer.length > 0 ? this.buffer[0].id : null
  if (oldest !== null && afterId + 1 < oldest) {
    return { gap: true, gapFrom: afterId + 1, gapTo: oldest - 1, events }
  }
  return { gap: false, gapFrom: 0, gapTo: 0, events }
}
```

**证据 4 —— 环形缓冲容量 1000**（`server/src/engine/events.ts:87-92` + 生产装配 `server/src/index.ts:104`，实读摘录）：

```ts
this.capacity = Math.max(options.capacity ?? 1000, 1)
...
this.buffer.push(bridge)
if (this.buffer.length > this.capacity) {
  this.buffer.splice(0, this.buffer.length - this.capacity)
}
```

```ts
const eventBus = new EventBus({ capacity: 1000 });
```

即最坏情况单标签新连即回放 1000 帧 × 平均帧字节（流式 `message_update` 累计内容帧占大头）。

### 路径 2：gap 对账全量重取（客户端固定 `{full:true}`）

**行为链**：SSE `gap` 帧或游标回退（服务重启强信号）到达时，客户端对 store 内全部已加载会话逐一发 `GET messages?full=1` 全量；每次全量都绕过 r7 尾窗直读、触发引擎路径整体取回。

**证据 1 —— 单会话重取固定 full**（`web/src/lib/event-dispatch.ts:125-131`，实读摘录）：

```ts
function refetchSession(sessionId: string): void {
  if (refetching.has(sessionId)) return;
  if (!useMessagesStore.getState().bySession[sessionId]) return;
  refetching.add(sessionId);
  api
    .listMessages(sessionId, { full: true })
```

注释明示：「任务 16：首载改尾窗直读后，gap 对账必须回全量不被尾窗截断——full=1 保持引擎全量路径」。

**证据 2 —— 全部已加载会话逐一全量**（`web/src/lib/event-dispatch.ts:148-156`，实读摘录）：

```ts
export function refetchLoadedSessions(): void {
  const { bySession } = useMessagesStore.getState();
  for (const [sessionId] of Object.entries(bySession)) {
    refetchSession(sessionId);
  }
}
```

**证据 3 —— 两个触发点**（`web/src/lib/event-dispatch.ts:210-224`，实读摘录）：

```ts
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
```

```ts
if (eventType === "gap") {
  refetchLoadedSessions();
  resyncQueues();
  return;
}
```

`resyncRunStatesFromServer`（event-dispatch.ts:172-198）再叠加一次 `GET /api/sessions` 会话列表全量。

### 路径 3：`?full=1` 与 `?cursor=` 前向路径仍走引擎全量

**行为链**：messages 路由中，只要请求带 `cursor` 或 `full=1`（或网关无 `sessionPath` 直读面），就整体回退引擎路径 `deps.engines.messages(id, cursor)`——引擎 `switchTo` 会话后向引擎进程整体取消息。注意：**`?full=1` 是服务重启对账承重路径，不可删，方案必须保留其语义**（见下证据 1 注释原文）。

**证据 1 —— 路由分支**（`server/src/api/routes-session.ts:318-337`，实读摘录）：

```ts
// 会话消息分页：cursor = 上页 leafId，传回取增量（verification/01 游标语义）。
// 任务 16（GAP-6 修复）：无 cursor 首载改服务端尾窗直读（resolveSession 取
// sessionPath，SDK 直读不 spawn 引擎不进 runExclusive 不switchTo；读不到会话
// 文件的新会话/别名回退引擎全量）；?before= 上一窗（无效 409 cursor_invalid）；
// ?cursor= 前向增量与 ?full=1 全量（SSE gap 重连对账依赖）走引擎不变。
...
const full = c.req.query("full") === "1";
...
if (cursor || full || !deps.engines.sessionPath) {
  // 前向增量 / 全量 / fake 网关（无直读面）：引擎路径原样
  page = await deps.engines.messages(id, cursor);
```

**证据 2 —— 引擎路径 switchTo + 整取**（`server/src/api/engine-runtime.ts:991-997`，实读摘录）：

```ts
async messages(sessionId: string, cursor?: string): Promise<EngineMessagesPage> {
  return this.runTraced("messages", sessionId, async (span) => {
    const tSwitch = performance.now();
    await this.switchTo(sessionId);
    ...
    const page = await this.requireAdapter().messages(cursor);
```

`full=1` → `cursor === undefined` → 引擎返回全量条目。对照：无参数首载走磁盘直读（routes-session.ts:339-356 的 `readEntriesBefore` / `readTailEntries` 分支），两条前向路径不经过它。

---

## 二、回放窗口 N 帧取值论证（真实会话统计）

### 数据源与方法

样本：`/root/.omo/agent/sessions/--data-projects-senpi-webui--/2026-10-22T11-33-46-959Z_*.jsonl`（1,538 条 entry，全文件 4,529,578 字节，即本仓库 r7 规划批次的真实会话，流式/工具/自定义帧俱全）。只读分析，副本在 `/tmp/docs08-t3-session.jsonl`。口径：取文件尾 200 条（与 r7 `TAIL_WINDOW=200` 同宽）统计帧型分布与字节量；SSE `message_update` 流式中间帧不落盘，jsonl 中的 `message:assistant` 终态条目是其终点，流式中间帧量按下文单独推导。

### 尾窗 200 条帧型分布（实测）

| 帧型 | 条数 | 字节 | 占比 |
|---|---|---|---|
| custom_message | 37 | 152,230 | 43.0% |
| message:assistant | 56 | 102,914 | 29.1% |
| message:toolResult | 33 | 59,856 | 16.9% |
| custom:goal-cache-warmup | 23 | 11,681 | 3.3% |
| custom:senpi-memory.reflection-comple | 3 | 10,525 | 3.0% |
| custom:omo-memory:projection-pin | 14 | 5,544 | 1.6% |
| custom:senpi-memory.session-binding | 10 | 3,170 | 0.9% |
| custom:pi-rules.scan | 10 | 2,130 | 0.6% |
| message:user | 3 | 1,895 | 0.5% |
| custom:senpi-memory.reflection-laun | 3 | 1,580 | 0.4% |
| custom:omo-kibitzer:nudged | 2 | 962 | 0.3% |
| custom:omo-memory:accepted-turns | 2 | 538 | 0.2% |
| custom:engine-turn-start | 2 | 356 | 0.1% |
| custom:loop-tick | 1 | 353 | 0.1% |
| session_info | 1 | 130 | 0.0% |
| 合计 | **200** | 353,864 | 100% |

上表 15 行为完整枚举，计数总和精确等于 200（37+56+33+70+3+1），无未分类或不可解析条目；此前版本表格的「custom:* 杂项 58」「session_info 等 3」两行是手工聚合行且抄录计数错（实际分别为 70 与 2），加总 190 的缺口完全来自该抄录错，不是数据缺口。

敏感度：尾 100 条 145KB、尾 300 条 547KB——字节量随窗宽近线性，主载体是 `custom_message`（均值 4.1KB/条）与 `message:assistant`（均值 1.8KB/条）。

### N 的推导

关键不对称：**落盘条目（上表）与 SSE 环形缓冲帧不是一回事**。环形缓冲里每条 assistant 消息在流式期间产生大量 `message_update` 中间帧（内容累计式，第 k 帧携带前 k 个 chunk 的拼接，单回合 1.8KB 终态按典型 chunk 粒度可产生数十帧、累计字节是终态的数倍到数十倍）；这些帧对新连接毫无价值——终态已由 `message_end`/`entry_appended` 表达，且新标签首屏本来就走 REST 尾窗直读。

因此回放窗口 N 的计量基准应是「**新连接必须重建的活性状态帧**」而非消息内容：

**必须回放（不可跳）**——跳了 UI 状态就错：
- `extension_ui_request`（permission / question；已有 `filterStaleUiRequests` 陈旧过滤，sse.ts:198-268）
- `question_updated` / `question_resolved`（提问卡片截止/终局）
- `agent_start` / `agent_end` / `agent_settled` / `agent_idle`（运行态与解锁）
- `session_closed`、`engine_permissions_invalidated` 墓碑
- `model_changed` / `model_change_rejected`（生效模型胶囊）
- `compaction_start/progress/end`（压缩进行条）
- `queue_update`（排队列表增量，不重放则需快照对账）
- `entry_appended` / `message_start` / `message_end`（条目身份收敛；message_start 在 replay 窗口内已有抑制机制，docs08-r5 任务 5）——**custom_message 归此类**：它不是独立 wire 帧型，落库后经 `entry_appended` 携完整条目载荷到达（web/src/stores/messages.ts:638-689 `case "entry_appended"`，及 web/src/lib/memory-entries.ts:4-5「历史 type:custom_message 条目；实时…… entry_appended 携 id 的 custom_message 载荷」实测注释）；它是终态帧（无流式中间形态），store 白名单消费后驱动记忆标记/占位行渲染，且只有白名单 customType 入列——跳过会丢这些可见行，无 REST 快照外的独立恢复通道（REST 重取能恢复但那正是回放要避免的重取），故列为必放
- `error` / `*_error` 尾缀帧（event-dispatch.ts:318-321 实读：`wire.type === "error" || wire.type.endsWith("_error")` → `setRunState(sessionId, "error")`）——小状态帧，跳过会丢错误状态点且无法从 REST 恢复，必放；字节量极小（无载荷正文，非流量因子）
- `hb` 心跳与桥级 marker（帧流水完整性）

**可跳（新连接回放时丢弃）**：
- `message_update` 流式中间帧（`replay_begin..replay_done` 窗口外的历史中间帧；新连接无该消息的流式上下文，跳过不影响正确性——若该回合仍在流式中，最后一帧 `message_update` 之后的内容由实时帧与 `message_end` 兜底；保守实现可保留窗口内**每会话最后一条** message_update 作为流式态快照）

**N 取值**：以活性状态帧密度计——本样本尾窗 200 条落盘条目对应的活性状态帧（UI 请求/终态/模型/压缩/排队）为个位数到十余条每会话每回合；N=**200** 与 r7 `TAIL_WINDOW=200` 对齐即可完整覆盖多回合活性状态（尾 100 条内已有 2 个回合的 engine-turn-start，200 条约 4-6 回合），同时把最坏回放字节从「1000 帧含流式大帧（估数百 KB 到 MB 级）」压到「200 帧去掉 message_update 后的水平」——按本样本尾窗 200 条实测：必放的内容终态帧（custom_message 152KB + message:assistant 103KB + message:toolResult 60KB ≈ 316KB，均经 entry_appended/message_end 到达）合计约 316KB，加活性状态帧后总量约 350KB 量级——**远非 <100KB**，减流主要收益来自跳过 message_update 流式中间帧（其累计字节是终态的数倍到数十倍）与窗宽从 1000 帧收到 200 帧；若后续实测仍超标，次级优化是把已落库段的 entry_appended 内容帧也交由 REST 尾窗直读承担（新连接首屏本就走 REST，SSE 只回放活性状态帧 + 条目 id 用于身份收敛），该方案需与任务 9 联调验证去重。配合跳帧清单，`replay(afterId)` 建议改为 `replayTail(N)`：取缓冲**最旧起点与尾部 N 帧中较晚者**起回放，越界部分照发 `gap`（由路径 2/3 对账兜底），`Last-Event-ID` 精确续传语义不变（afterId 在 N 窗内时仍从 afterId+1 续发）。

---

## 三、对账分级判定伪码（与任务 9 联调）

原则：**保留 `?full=1` 承重语义**（服务重启对账的最后兜底不动），分级只减少不必要的全量发射。

```
on gap {from, to} 或 游标回退:
    for session in loadedSessions:
        gapSize = 估算缺口（gap.to - gap.from，或回退时游标差）
        if 服务重启信号（游标回退 / gap 且 events 为空）:      # 纪元变了，游标体系不可信
            refetchSession(session, {full:true})              # 现路径 2 原样，承重不动
            + resyncQueues + resyncRunStatesFromServer        # 现有并行三路不变
        else if gapSize <= TAIL_WINDOW (=200):                # 小缺口：帧只是被环形缓冲淘汰
            # 尾窗内增量补齐：服务端 readEntriesBefore/尾窗已能覆盖
            entries = GET messages?before=<本地最旧已知id> 逐窗后翻
                     （或按 leafId 游标增量 ?cursor=，任务 9 定接口细节）
            mergeIntoStore(session, entries)
            queueSnapshot 仅当 gap 覆盖到入队/出队区间时拉
        else:                                                  # 大缺口且同纪元
            refetchSession(session, {full:true})              # 等价现行为
        # 无 gap（replay 无 gap=true）→ 零请求，纯续发
```

服务端对齐面：小缺口补齐直接复用 r7 已落地的 `?before=` 后向翻页（`readEntriesBefore`，routes-session.ts:349-357）；增量对齐 `?cursor=`；全量兜底 `?full=1` 原样保留（routes-session.ts:334-337 分支不动）。

---

## 四、风险节（必须与任务 9 联调的清单）

1. **客户端 gap 判定脱节 = 静默丢帧（最高风险）**：服务端把 `replay(0)` 改为 `replayTail(N)` 后，「无 Last-Event-ID 新连接」不再回放缓冲头部；若客户端没有把「窗口越界」识别为需对账（现客户端只在显式 `gap` 帧和游标回退时 refetch），中间地带（afterId 在缓冲内但早于尾窗起点、未触发 gap 帧）会静默丢帧。必须与任务 9 对齐：`replayTail` 越界时**必须**发 `gap` 帧（复用现语义），客户端 gap → 对账路径保持不变；联合测试用例：填满 >N 帧后新开标签，验证无丢帧。
2. **跳 message_update 与流式回合交互**：若回放时刻恰有回合在流式中，跳中间帧后前端必须靠「最后一条 message_update 快照帧」或 `message_end` 兜底渲染；漏留快照帧会显示半截消息直至回合落定。联调用例：流式中途新开标签。
3. **`?before=` 增量补齐的 cursor_invalid 边界**：本地最旧已知 id 若已不在会话文件（被压缩/截断），`readEntriesBefore` 抛 409 `cursor_invalid`（routes-session.ts:355-358）——分级伪码的 fallback 必须捕获该错误并升级为 `full:true`，否则补齐失败静默（现 refetchSession 失败静默模式会掩盖）。
4. **多标签放大**：路径 1 每标签独立回放；N 窗落地前，N 帧回放 × 标签数仍是乘法关系。量化（部署流量计量 8b18a9a 后）需分标签统计再评估是否需要连接级去重（不建议本期做）。
5. **queue_update 不重放**：小缺口增量补齐只补消息条目，排队列表仍需 `resyncQueues` 快照；分级伪码中「仅当 gap 覆盖入队/出队区间」的判定依赖任务 9 给出的 queue 快照接口语义，需联调确认。
6. **`?full=1` 语义冻结**：任何分级实现不得移除或重命名 `full=1`；它是服务重启（游标回退、SSE 纪元归零）场景的承重路径（routes-session.ts:322 注释明示「SSE gap 重连对账依赖」），只能减少触发频次，不能削弱其取全量语义。

---

## 附：本文档证据核对清单

- 路径 1：sse.ts:313-316 / 386-401 / 426-429，events.ts:87-92 / 122-140，index.ts:104 —— 均为本次实读摘录。
- 路径 2：event-dispatch.ts:125-131 / 148-156 / 210-224 / 172-198 —— 均为本次实读摘录。
- 路径 3：routes-session.ts:318-337 / 339-356，engine-runtime.ts:991-997 —— 均为本次实读摘录。
- 帧统计：`/tmp/docs08-t3-session.jsonl`（源文件 4.45MB，2026-10-22 会话，1,538 条 entry；分析后已删，见清理收据）。
