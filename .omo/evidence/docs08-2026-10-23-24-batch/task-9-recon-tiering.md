# 任务 9：客户端对账分级（web 端 gap 增量补齐）

- 计划：docs08-2026-10-23-24-batch 任务 9（IMPLEMENTATION，与已落地任务 8 服务端窗口化对接）
- worktree：docs08-batch-w1-t9（分支 docs08-batch/w1-t9，基于 main@6875933，含 t8 服务端窗口化）
- 设计依据：task-3-traffic-residual.md「对账分级判定伪码」定稿 + task-8-sse-replay-window.md「接缝契约（任务 9 客户端增量补齐对接面）」

## 一、实现摘要（web/src/lib/event-dispatch.ts）

1. 新增导出常量 `GAP_INCREMENTAL_WINDOW = 200`（与 r7 TAIL_WINDOW / t8 REPLAY_TAIL_WINDOW 对齐，无偏离）。
2. gap 帧处理由「一律 `refetchLoadedSessions()` 全量」改为分级入口 `reconcileGapFrame(data)`：
   - 解析 `{from, to}`（事件游标序缺口区间）。
   - 小缺口：`from/to` 均为有限数字、`from >= 1`、`to >= from` 且宽度 `to - from + 1 <= 200`。
   - 畸形（非 JSON 信封层已有整体容错、from>to / null 界 / 非数字 / 无下界 / from<1）与大缺口 → 既有全量层（`full=1` 承重语义冻结不动）。
3. 小缺口逐会话分级：
   - 有锚点（`entries` 非空且 `oldestId` 在——即尾窗首载形态）→ `reconcileSessionIncremental`：恰一次 `GET messages?before=<oldestId>`（t3 伪码「?before=<本地最旧已知 id>」），结果经 store 既有 `prependEntries` 按 id 去重头插合并（拼缝零重复零丢失），不触碰 `streaming/streamingMessage/toolRuns/compacting` 等活跃流式态，不动 `cursor/leafId`。
   - 无锚点（全量加载完 `oldestId=null` 或条目为空）→ 仍走该会话全量 `refetchSession`（保守兜底：全量加载的 store 缺口只能在尾部，`?before=` 方向补不到）。
   - `bySession` 空（首连 store 为空）→ 循环体不执行，零对账请求（t8 风险注记落定：首连本就全量建库）。
4. `?before=` 遇 409 `cursor_invalid`（锚点条目已被压缩/截断出会话文件，t8 契约 5）→ 升级 `refetchSession` 全量；其余失败静默（与既有全量层同哲学，下次 gap / 游标回退 / 重连重放兜底）。
5. 增量在途去重集合 `reconciling` 与全量集合 `refetching` 分账：增量在途不阻断全量层（游标回退/升级可立即全量），仅对增量连击去重（stale_state 收敛）；增量在途时新 gap 不重复发射。游标回退路径（纪元回退三路：refetch + resyncQueues + resyncRunStates）零改动。

与 t3 伪码的出入（按任务书「交叠处更严者」说明）：t3 伪码大缺口注释为「大缺口且同纪元 → full」、小缺口「仅当 gap 覆盖入队/出队区间时拉 queueSnapshot」；实现按 t8 契约保持 `resyncQueues()` 在两种 tier 均无条件发射（queue 快照极轻、覆盖判定无接口依据，宁多勿漏——与 t8 落地行为一致，不为分级引入丢排队风险）。

## 二、分级判定表（gap 大小 × 边界 × store 状态 → 动作）

| gap 载荷 | 宽度 | store 会话状态 | 动作 |
|---|---|---|---|
| 任意 | 任意 | `bySession` 空（首连） | 零请求（`resyncQueues` 亦零——无 key） |
| 合法 `{from,to}`，`from≥1, to≥from` | ≤200 | entries 非空 + `oldestId` 在（尾窗形态） | 恰一次 `?before=<oldestId>` 增量，`prependEntries` 合并 |
| 合法，同上 | ≤200 | `oldestId=null`（全量加载完）或 entries 空 | 该会话 `full=1` 全量 |
| 合法 | >200 | 任意已加载 | `refetchLoadedSessions` 全量（承重不变） |
| `from>to` / null 界 / 非数字 / 无下界 / `from<1` | — | 任意已加载 | 降级全量，不崩 |
| 非 JSON 帧 | — | 任意 | dispatchSseEvent 信封层既有容错忽略（先于 gap 分支，零请求不崩） |
| `?before=` 409 cursor_invalid | ≤200 | 尾窗形态 | 升级该会话 `full=1`（t8 契约 5） |
| 游标回退（id < lastCursor） | — | 任意已加载 | 全量三路原样（不经 gap 分级） |

## 三、t8 接缝契约逐条兑现

1. 「未收到的事件恰为连续前缀区间 `[from,to]`，gap 帧明示」→ `reconcileGapFrame` 直接消费 `{from,to}`，宽度判定即补齐范围判定。✅
2. 「`?before=<B>` 回翻补齐，entry.id < B 的集合即未收集合」→ 客户端锚点取 `store.oldestId`（本端已知最旧 entry id，t3 定稿措辞）；重叠窗经 `prependEntries` id 收敛零重复零丢失。✅（B 与本端最旧已知 id 收敛为同一锚——本端若已加载更早历史，重叠区去重；t8 契约 2 的「逐窗回翻」在本实现为单窗：gap 宽度 ≤200 = REST 单窗容量，任务书即此定义。）
3. 「游标续接无缝，无需重连」→ 分级只在 gap 帧上动作，实时流游标记账路径零改动。✅
4. 「message_update 中间帧不在恢复面内」→ 增量补齐只合并 REST 落库 entries，不触碰流式态（测试 d 断言 streaming/toolRuns 原样）。✅
5. 「`?before=` 409 cursor_invalid 必须升级 full=1」→ `reconcileSessionIncremental` catch 分支按 `ApiError.code === "cursor_invalid"` 升级 `refetchSession`。✅（专项测试）
6. 「服务重启仍走全量对账」→ 游标回退分支未触碰。✅（专项测试）

联合验收：本文件测试 (a)（小缺口恰一次 `?before=`、无 full 请求、合并正确）与 (b)（大缺口 `full=1` 回归保持、t8 手动 QA 同款 gap `{from:1,to:961}` 场景）即 t8×t9 联合验收用例。

## 四、测试（web/src/lib/__tests__/event-dispatch-gap-tiering.test.ts 新增 14 例；events.test.ts / event-dispatch-full.test.ts 既有 3 例 gap 回归全数保持通过，零削弱）

- (a) 小缺口：宽度恰 200 边界 → 恰一次 `{before:"e180"}`、重叠帧去重、旧→新单调、无 full 请求；多会话混合（有锚点增量 / 无锚点全量）各得其所；增量连击在途去重；cursor_invalid 升级 full；其余 500 失败静默不崩。
- (b) 大缺口：宽度 961（t8 QA 同款）→ `full=1` 全量整替；畸形载荷参数化 5 例（from>to / null 界 / 无下界 / 非数字 / from<1）降级全量不崩；非 JSON 帧信封层容错（零请求不崩，既有行为固化）。
- (c) 首连空 store：小 / 大 / 畸形 gap 均零 messages 请求。
- (d) 合并语义：大面积重叠零重复、id 单调；`streaming/streamingMessage/streamingEntryId/toolRuns/loaded/cursor` 全部原样；游标回退仍全量。

## 五、验证输出（实贴）

web 全量（worktree 内，node_modules 软链主仓根后运行，提交前已删）：

```
$ node ../node_modules/vitest/vitest.mjs run   (web/)
 Test Files  105 passed (105)
      Tests  989 passed (989)
```

根构建门禁：

```
$ npm run build
==> 内嵌资产模块：330 个文件 -> server/src/static-assets.generated.ts
==> 构建完成：server/dist/index.js
EXIT:0
```

定向（改动相关三文件）：`Tests 1 failed | 39 passed (40)` → 修正非 JSON 帧断言（信封层既有守卫先于 gap 分支，属既有行为而非缺口）后全绿。

## 六、手动 QA（node 级接缝，模拟 t8 fixture：1200 帧、store 预载近期后缀 e-1181..e-1200，mock fetch，跑完即删临时测试）

```
QA1 large-gap: {"gap":{"from":1,"to":961},"width":961,
  "requests":["/api/sessions/s-proj/messages?full=true"],   ← full 层（tier 标签 "none" 为脚本对 full=true 序列化的判串偏差，请求本体即 full 全量）
  "storeIdRange":["f-1","f-40"],"entryCount":40,"hasMore":false,"oldestId":null}
QA2 small-gap: {"gap":{"from":1031,"to":1180},"width":150,
  "requests":["/api/sessions/s-proj/messages?before=e-1181"],  ← 增量层，恰一次
  "storeIdRange":["e-1161","e-1200"],"entryCount":40,"dupIds":false,"monotonic":true}
```

## 七、清理收据

- worktree 根 `node_modules` 软链（指向主仓根，仅为运行测试/构建）提交前已删除。
- `web/tests/tmp-task9-seam-qa.test.ts`（手动 QA 临时测试）跑完即删，不在提交内。
- 无 /tmp 临时文件、无后台进程残留。

## 八、风险

- `?before=` 单窗假设依赖「小缺口宽度 ≤ REST 单窗容量（200）」的任务书定义；事件宽度 ≠ 条目数（缺口内非 entry 帧不占 REST 窗），单窗必覆盖。
- 无锚点会话（全量加载完）小缺口仍走全量：保守选择，尾部缺口 `?before=` 方向补不到；频次低（全量加载后 gap 需同 tab 断连重连）。
- 增量与全量并发（升级场景）终态收敛已分析（full `setEntries` 与增量 `prependEntries` 的 id 去重交互均幂等），无专项并发测试——由单窗同步请求的确定性时序兜底。
