# 任务 8：SSE 新连接回放窗口收敛（服务端）

- 计划：docs08-2026-10-23-24-batch 任务 8（IMPLEMENTATION）
- worktree：docs08-batch-w1-t8（分支 docs08-batch/w1-t8，基于 main@2d038d7）
- 设计依据：任务 3 定稿（本目录 task-3-traffic-residual.md）——回放最近 N=200 帧；必放帧型含 custom_message（经 entry_appended 携完整载荷）与 error/*_error；message_update 流式中间帧可跳、留末帧快照。

## 一、实现摘要（server/src/api/sse.ts）

1. 新增导出常量 `REPLAY_TAIL_WINDOW = 200`（与 r7 TAIL_WINDOW 对齐，无偏离）。
2. 新增 `replayTailWindow(events, limit)`：从尾向前扫描，保留最近 limit 帧；`message_update` 只保留每会话（projectPath+wire sessionId 键）最后一条作流式态快照；**只因窗口上限截断才报 truncated**——中间帧主动跳过不算截断、不触发 gap（无恢复需求，终态由 entry_appended/message_end 表达）。
3. 路由内：`raw === undefined`（无 Last-Event-ID 的新连接，原生 EventSource 首连形态）时对 `replay.events` 先做尾窗截取再进 `filterStaleUiRequests`（墓碑过滤逻辑零改动，只是输入序列变为窗口内后缀——其后缀方向性判定不受影响：窗口外更早的请求帧连同其判定帧一起被丢弃，一致性保持）。截断时发 `gap` 帧，区间 `[afterId + 1, windowStart - 1]`，与环缓淘汰越界同语义、同复用客户端对账路径；与 replay.gap 同时成立时窗口起点更靠后，区间自然覆盖环缓缺口。
4. **带 Last-Event-ID 的连接（含非法值按 0、负数、超前 id）行为完全不变**：不走窗口化，replay(0) 全量语义原样。
5. 环形缓冲容量不动（1000，生产装配不变），窗口化只发生在回放读取侧。`?full=1` / REST 尾窗 / `?before=` 路径零改动。

窗口计数口径：message_update 末帧快照占用窗口席位（帧数 ≤ N 硬保证）；当尾域必放帧充足时恰为 N 帧（199 必放 + 1 快照，见手动 QA 实测）。

## 二、测试（server/test/sse-replay-window.test.ts 新增 6 例 + sse.test.ts 调整 1 例）

- (a) 无 Last-Event-ID 新连接 + 250 必放帧/交织流式帧：恰回放 N=200 帧、无 message_update 中间帧（≤1 快照）、entry_appended/error 在场、replay_begin/done 包夹、id 严格递增、首帧 id = gap.to + 1（无缝衔接）。
- (b) 带 Last-Event-ID 回归：`Last-Event-ID: 0` 全量重放 350 帧（含 message_update 中间帧、无 gap）；中位续传全量。窗口化对带头连接不生效。
- (c) 联合接缝测试（与任务 9，见下节接缝契约）。
- (d) 边界：恰好 N 帧必放历史 → 全放、无 gap；N+1 帧 → 截断为 N 帧 + gap `[1,1]`、首帧 id=2。
- (对抗 stale_state) 环缓容量 50 发布 120 帧（最旧 70 被淘汰）：退化为既有语义——gap `[1,70]` + 从 id 71 起全量 50 帧续发，窗口化不额外改变（50 < N 无二次截断）。
- (对抗 malformed-input) `Last-Event-ID: -5` 按 0 走带头全量路径（350 帧全放、无 gap）；`999999` 超前 → gap `{from:1000000, to:最新游标}`、无续发、基点 id = 当前游标。
- sse.test.ts「?session= 过滤」1 例按新契约调整：无头连接 + 会话过滤叠加窗口化后序列为 [begin][3][done]（s2 帧被会话过滤、s1 两条 message_update 只留末帧快照）——原断言隐含"无头连接全量重放"，与本任务设计定稿直接冲突，属预期行为变更而非削弱（新窗口测试覆盖了更强的约束）。

## 三、接缝契约（任务 9 客户端增量补齐对接面）

服务端保证（测试 (c) 断言，全部为确定性不变量）：

1. **未收到的事件恰为连续前缀区间** `[1, windowStart - 1]`：gap 帧 data `{from, to}` 明示，且首条回放帧桥 id = `to + 1`（无缝、无洞）。客户端收到 gap 即知需补齐，补齐范围就是 `[from, to]`。
2. **entry 身份序与桥游标序一致**（同一发布序）：窗口内最早的 entry_appended 帧（其 entry.id = 边界 entry id B）即 REST 补齐的确定边界——客户端对 `GET messages`（尾窗直读）后用 `?before=<B>`（r7 `readEntriesBefore` 后向翻页）逐窗回翻至 `[from, to]` 覆盖，即得全部缺失已落库条目；entry.id < B 的集合恰为未收到集合（测试断言连续无缺）。
3. **游标续接无缝**：末条回放帧 id 到缓冲末尾无洞，客户端以 done 帧后的实时流游标续听即可，无需重连。
4. **message_update 中间帧不在恢复面内**：它们从未落库、也无需恢复（终态经 entry_appended/message_end 到达；活跃流式态由每会话末帧快照兜底）。若快照之后回合仍在流式，实时 message_update 帧继续推进。
5. `?before=` 补齐遇到 409 `cursor_invalid`（本地边界已不在会话文件，被压缩/截断）时，任务 9 必须升级为 `full=1`（设计文档风险 3）；`?full=1` 语义冻结不动。
6. 服务重启（游标回退/gap 且 events 空）仍走全量对账，本任务未触碰该路径。

次级优化（设计文档提到的"已落库段 entry_appended 交 REST 尾窗承担"）**未做**——按任务书为可选项，且会改变接缝契约面（窗口内 entry 帧是否保留），留给任务 9 联调时按需评估。

## 四、验证输出（实贴）

server 全套（worktree 内，node_modules 软链主仓后运行）：

```
$ node ../../node_modules/vitest/vitest.mjs run   (server/)
 EXIT: 0
 Test Files  44 passed (44)
      Tests  558 passed (558)
```

根构建门禁：

```
$ npm run build
==> 内嵌资产模块：330 个文件 -> server/src/static-assets.generated.ts
==> 构建完成：server/dist/index.js
EXIT: 0
```

## 五、手动 QA（node 级 SSE 端到端，mocked transport = app.request 内存流）

构造：EventBus capacity=1000，发布 1200 帧（i%6 轮转：message_update / entry_appended(message) / error / agent_end / entry_appended(custom_message) / model_changed，共 400 entry），无 Last-Event-ID 连接 `GET /api/events`，读全流。实测：

```json
{
  "totalBlocks": 203,
  "typeCounts": { "gap":1, "replay_begin":1, "error":40, "agent_end":40,
                  "entry_appended":79, "model_changed":40, "message_update":1, "replay_done":1 },
  "eventFrameCount": 200,
  "firstEventId": 962, "lastEventId": 1200,
  "strictlyIncreasing": true,
  "gapData": "{\"from\":1,\"to\":961}",
  "beginData": "{\"after\":0,\"buffered\":200}",
  "doneData": "{\"count\":200}"
}
```

对照：改动前同场景回放 1000 帧（环缓全量，含 200 条 message_update 累计大帧）；改动后 200 帧（199 必放 + 1 快照），字节量主体只剩必放终态帧。custom_message 经 entry_appended 完整载荷在场（79 条 entry_appended 内含 custom_message 型）。

## 六、清理收据

- worktree 内临时 `node_modules` 软链（指向主仓，仅为运行测试/构建）提交前已删除。
- 无 /tmp 临时文件、无后台进程残留。

## 七、风险

- 客户端（任务 9 未落地前）在"无头新连接 + gap 帧"场景仍会按现逻辑对已加载会话全量 refetch（gap → refetchLoadedSessions）——首连时 store 为空、实际零请求，多标签已加载场景有一次全量，与任务 9 落地后的分级对账衔接（接缝契约第 1/5/6 条）。
- message_update 快照占窗口席位：极端场景（尾域全是同一会话流式帧）窗口内 entry 覆盖略少 1 帧，由 REST 补齐兜底，无正确性影响。
