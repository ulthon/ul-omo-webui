# 任务 12 证据笔记：会话第四态「后台运行中」

批次：docs08-2026-10-23-24-batch Wave2 任务 12（GAP-3）。
worktree：docs08-batch-w2-t12（基于 main@576b8ac）。

## 一、状态语义表（三态 + 第四态）

| runState | 含义 | 服务端供源 | 中断钮 |
| --- | --- | --- | --- |
| running | webui 驱动流式回合进行中 | peekRunStates 三源推导（deriveSessionRunState，语义不变） | abort 当前回合 |
| waiting | 权限/阻塞型提问挂起 | 同上（不变） | abort 当前回合 |
| idle | 空闲 | 同上 + 后台态判否（不变） | 不可见（既有并集口径） |
| background_running（新增，additive） | 该会话 jsonl 内存在已派发未终局的后台任务 | 会话 jsonl 磁盘派生（routes-session 叠加，仅当三源非 running/waiting） | 可见；无流式回合时点击出「有后台任务」提示，不 abort |

- 三态既有序列化形式不变（deriveSessionRunState 全组合映射未动，run-state.test.ts 8 例原样通过）。
- 第四态不压制 running/waiting（回合级 SSE 真相源优先）；SSE 重同步（resyncRunStatesFromServer）与列表刷新（setSessions/setAllSessions 的 syncBackgroundStates）都会按服务端行收敛。

## 二、服务端解析口径（与 web 一致性声明）

实现：`server/src/api/background-tasks.ts`（独立实现，未跨包 import web 模块）。与 `web/src/components/chat/subagent-data.ts` / `web/src/lib/task-completion.ts` 的口径对齐点：

- 启动态回执 = message.role==="toolResult" 且 details.run_in_background===true 且 details.status∈{running,pending} 且 details.task_id 非空（缺 task_id 无法与完成通知配对，宁漏勿错不计入——web dispatched 判定同款字段级窄化）；
- 终局 = 同 task_id 的 omo-senpi:wake 完成通知（结构化 senpi-task.completion 深度≤4 走查 task_id，文本 `id:` 兜底，两形态均 web 同构；不校验通知 status 词表，任意到达即终局化）或同 toolCallId 后到的非启动态回执（重复/后到终态覆盖先到，duplicated-terminal 对抗面）；
- 畸形行（非 JSON / 撕裂尾行 / 非 Message / 非 custom_message 条目）静默跳过，绝不炸列表。
- 恢复语义：mtime+size 磁盘缓存仅作摊销，服务重启缓存为空重读 jsonl 即恢复——第四态不依赖内存态（测试 c 与 QA2 实证）。
- 摊销理由：GET /api/sessions 每次刷新全表逐行解析 jsonl 代价须缓存；文件变化（追加终态回执）即失效重读（测试 b 与 QA3 实证）。

## 三、清扫器阈值与理由

- 既有：running 10min / waiting 30min（不动）。后台态新增专属阈值 **BACKGROUND_STALE_MS = 60min**（web/src/stores/sessions.ts）。
- 理由：后台任务合法长跑（deep 子任务实录可达数十分钟至小时级），比照 running/waiting 的孤儿兜底档次再放宽一档；正常长任务不被误扫。完成通知丢失时的收敛双保险：jsonl 已有终态回执 → 下一次列表刷新/SSE 重同步服务端行回落即收敛（提前）；通知与终态双丢（极端）→ 60min 清扫兜底回落 idle。
- 清扫判定保持「严格大于阈值才扫」（`now - at <= staleMs` continue），与既有两态同边界。

## 四、测试

命令与结果（本 worktree 实跑）：

```
server: npx vitest run                                     → Test Files 46 passed (46)  Tests 584 passed (584)
web:    npx vitest run                                     → Tests 1001 passed (1001)
根构建: npm run build                                       → ✓ built in 2.60s / server/dist/index.js 12.2mb（完成）
```

新增用例（server/test/background-state.test.ts，10 例）：纯函数口径（启动态词表/终态回执/结构化+文本通知/重复终态覆盖/垃圾行容错/多任务部分终局）+ GET /api/sessions（(a) 后台无终局→background_running；(b) 追加通知→回落 idle；(c) 清缓存+新实例重启模拟→恢复；(d) running/waiting 行不被覆盖）。

新增用例（web/tests/background-state.test.tsx，12 例）：store 同步（行第四态入 runStates；running/waiting 在位不覆盖；行回落清除）、清扫器（59min 不扫/60min 边界不扫/61min 回落，注入时钟零 sleep）、stopIntent 真值表（后台+非流式→hint；后台+流式→abort；三态全 abort）、状态点（store 态与服务端行态双路渲染紫点+「后台运行中」）、水位环（紫环+紫脉冲点；无后台态不带 violet）、Composer 交互（后台态点击→toast「有后台任务…」+ abort 接口 0 次；running 态点击→abort 接口 1 次）。

## 五、手工 QA（node 级双半，临时脚本跑完已删）

服务端半（真实 Hono 路由面 GET /api/sessions）：

```
QA1 初次列表（后台回执无终局） → 200 qa-s=background_running
QA2 重启模拟（新实例+清缓存） → 200 qa-s=background_running
QA3 追加终态回执后回落       → 200 qa-s=idle
```

web 半（happy-dom + createRoot 真组件渲染，点击真实 abort-btn）：

```
QA4 会话行状态点（SSR 片段）→ <span class="size-1.5 shrink-0 rounded-full bg-violet-500 animate-busy-pulse" title="后台运行中"
QA5 后台态点中断钮 → toast: 有后台任务运行中：停止钮只作用于当前回合，不影响后台任务；任务完成后状态自动回落 | abort 接口调用数: 0
```

## 六、已知边界与风险

- spawn 回执缺 task_id 的会话不计第四态（宁漏勿错，与 web dispatched 同口径）；
- 引擎未就绪（runState null）时后台态仍可下发（jsonl 直读不依赖引擎进程），符合「数据源钉死 jsonl」要求；
- 外部进程（CLI）并发写同一 jsonl 的撕裂行按垃圾行容错（任务 2 spike 已证零损坏为主流形态）；
- i18n 新键三处（sessionList.item.statusBackground / login.contextRing.background / composer.backgroundTaskHint）zh+en 双语已加。
