# 任务 14：acceptedTurns 同簇聚合 ×N（可展开）

worktree：`/data/projects/senpi-webui-wt/docs08-batch-w2-t14`（branch `docs08-batch/w2-t14`，基于 main@ced4743）
日期：2026-10-25

## 一、聚合规则表（mergeMemoryItems，message-items.ts）

| 场景 | 行为 |
|---|---|
| 3+ 连排 acceptedTurns | 折叠为一组 `memoryMarkerCluster`「本轮已计入记忆 ×N」，key=`memory-cluster-<首条entryId>` |
| 连排中断（sessionBinding / memoryRecall 等异类标记、消息等任何可见行） | 分簇，绝不跨语义合并 |
| 不产生可见行的条目（toolResult / display=false 等） | 不打断视觉连排（同 loopGuardGroup 任务 2 语义） |
| 单条 acceptedTurns | 不折叠：还原 `memoryMarker` 原形态原 key（`memory-<id>`），渲染与聚合前完全一致 |
| 事件删除 | 无——markers 全量携带于簇内，折叠仅呈现层；引擎侧零改动（任务 4 结论 record-only） |
| 新事件追加进既有簇 | 簇 key 锚定首条 entryId 不变 → 虚拟化行复用、展开态不丢（stale_state 防线） |
| sessionBinding identity 去重 | 先于聚合（既有口径不变） |
| 无标记会话 | 原样返回引用不变（既有口径不变） |

渲染：`message-list.tsx` 新增 `AcceptedTurnsClusterBlock`（`data-testid="memory-cluster"` `data-count`）：折叠态一行 BookCheck +「本轮已计入记忆 ×N」+ ×N 角标；点击展开逐条复用 `MemoryMarkerBlock`（每条自身仍可展开原文）；再点收回。Row 分支新增 `memoryMarkerCluster`。

## 二、i18n 键（用户可见新增，zh+en 双档）

| key | zh-CN | en |
|---|---|---|
| `chat.memoryMarkers.acceptedTurnsCount` | 本轮已计入记忆 ×{count} | Counted into memory this turn ×{count} |

## 三、测试（tests/memory-cluster.test.tsx，10 例）

命令与结果（worktree 根）：
```
$ node_modules/.bin/vitest run --root web tests/memory-cluster.test.tsx
 Test Files  1 passed (1) / Tests  10 passed (10)
```
覆盖计划四场景 + 防线：
- (a) 3 连排 → 一组 ×3（key=`memory-cluster-t1`，markers 保序全量）；
- (b) acceptedTurns×2 + sessionBinding + acceptedTurns → 两簇不跨语义合并（单条侧还原 memoryMarker）；
- (c) 折叠态 0 条逐行 → 点击展开 3 条 `[data-testid="memory-marker"]` → 再点收回 0 条；
- (d) 单条 acceptedTurns → `memoryMarker` 原形态原 key，无 ×N；
- 可见消息行打断 / toolResult 不打断 / 无标记引用不变 + binding 去重先于聚合；
- stale_state：追加 t4 进既有簇（key 不变）重渲染 → 展开态存活且逐行 4 条；
- zh/en 词条插值断言。

全套件：
```
$ node_modules/.bin/vitest run --root web
 Test Files  107 passed (107) / Tests  1006 passed (1006)   ← 连续 3 轮
```
注：本批首跑曾出现 1 例失败（1005/1006，与本次改动无关的偶发，随后 3 轮全套全绿未复现）；本次新增测试全部为确定性断言，无计时/轮询依赖。

构建：
```
$ npm run build        # 根构建（web vite + 内嵌资产 + server/dist）EXIT=0
$ cd web && npx tsc -b # EXIT=0
```

## 四、手动 QA（node 级渲染，脚本见本目录 task-14-manual-qa.tsx）

fixture：5 acceptedTurns + 1 交织 sessionBinding（t1,t2,t3,b1,t4,t5）：
```
merged rows: [["cluster","memory-cluster-t1",3],["memoryMarker","memory-b1"],["cluster","memory-cluster-t4",2]]
```
折叠行（renderToStaticMarkup，svg 已缩略）：
```html
<div data-testid="memory-cluster" data-count="3" class="my-0.5"><button type="button" aria-expanded="false" ...>
<svg…/><span class="truncate">本轮已计入记忆 ×3</span><span class="shrink-0 rounded-sm bg-muted px-1 py-px">×3</span><svg…/></button></div>
<!-- 同构 data-count="2"「本轮已计入记忆 ×2」×2 一行，位于 memory-b1 之后 -->
```
点击展开后（happy-dom + createRoot + act）：
```html
<div data-testid="memory-cluster" data-count="3" ...><button ... aria-expanded="true" ...>…×3…</button>
<div class="mt-0.5 space-y-0.5 pl-2"><div data-testid="memory-marker" data-kind="acceptedTurns" data-weight="weak">…本轮已计入记忆…</div> ×3 逐条</div></div>
```

## 五、变更清单

- web/src/components/chat/message-items.ts：ChatListItem 新增 `memoryMarkerCluster` 变体；mergeMemoryItems 排序后连排折叠 + 单元素簇还原
- web/src/components/chat/message-list.tsx：`AcceptedTurnsClusterBlock` + Row 分支
- web/src/i18n/{zh,en}/chat.ts：`acceptedTurnsCount` 词条
- web/tests/memory-cluster.test.tsx：新增 10 例
- 无服务端改动、无新依赖（worktree 内 `npm install --no-audit --no-fund` 仅为补装既有依赖）
