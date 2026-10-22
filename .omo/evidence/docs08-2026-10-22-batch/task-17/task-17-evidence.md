# 任务 17 证据:消息 footer 溯源行(agent+用时)

日期:2026-10-22 | 分支:docs08-r7-wave2-t17(worktree,基线 main@1dab7f8 一带)

## 实现

- 新增 `web/src/components/chat/message-origin.ts`:溯源取数纯函数(leaf 模块,单测直驱)。
  - agent 名:引擎 `deriveAgentName` 同通道(session-worker.js 实证)——条目及更早的最近
    custom 条目 `data.agentName`(优先)/`data.agent`(回落)字符串;无名返回 null。
  - 用时:本条目完成时间戳 − 最近一条更早 user 消息条目时间戳(回合锚点;最终回复即
    整回合用时,中途步进气泡为回合已进行时长);格式复用 step-duration 既有先例
    (同秒差 "0.0s"、一位小数秒、分钟级 "9m 46s"、负差按 0 收敛),未另立格式口径。
- `message-bubble.tsx`:BubbleShell 头部行模型短名旁追加代理名/用时 span(沿该行既有
  muted/opacity-70/truncate/tabular-nums 词汇,空数据省略不占位);EntryBubble 以
  原始值选择器取数(引用稳定,不破逐条订阅优化),钩子全部置于早退之前(oxlint 口径);
  流式在途无定格条目不参与,落格随 EntryBubble 上屏(无 async 高度变化,不破虚拟化测距)。
- i18n zh/en:`chat.messageBubble.originAgent`(代理 {name} / agent {name})、
  `chat.messageBubble.originDuration`(用时 {dur} / {dur})。

## 数据源可得性核对(任务 17「可得性首步核对」结论)

- 真实库 assistant message 条目键集(type/id/parentId/timestamp/message)无 agent 字段;
  引擎唯一 agent 注记通道 = custom 条目 data.agentName/agent(compaction.agent-checkpoint
  落库形态,真实库内当前全为 null)→ 本机真实数据下 agent 段省略,用时段照显。
- omo task 子会话不落盘(engine-adapter.ts 实证注释),主会话流内子代理仅以 task
  toolCall + toolResult 呈现(ToolCard 关联展示,非气泡);气泡 footer 的「子代理名」
  场景由上述 custom 注记通道承接——引擎一旦落具名标注(含子代理)即如实显示。
- compact 路径:compact-run.ts 为纯数据逻辑无渲染面;压缩条目走 compactionMarker
  通道,永不入气泡列 → footer 无 compact 面,零影响(测试锁定)。

## QA 实例与 bundle 哈希(陈旧产物防线)

- 隔离实例:`UL_OMO_WEBUI_PORT=7803`,`UL_OMO_WEBUI_DATA_DIR=/tmp/t17-qa/data`,
  `UL_OMO_WEBUI_AGENT_DIR=/tmp/t17-qa/agent`,密码走 env;根构建 `npm run build` 后启动。
- fixture 会话:`<agent>/sessions/--tmp-t17-qa-project--/2026-10-22T15-00-00-000Z_fixture0001.jsonl`
  (9 行:session 头 v3 + model_change + user + custom data.agentName="Sisyphus - ultraworker"
  + 中途步进 assistant(toolUse) + task toolResult(含 details 终态) + 最终回复 + user + assistant;
  时间戳按 u1 起算 3m10s / 9m46s / 54.0s 设计),项目 POST /api/projects 注册。
- 伺服核验:GET / 引用 `assets/index-DlIDRoew.js`,磁盘同文件 sha256 =
  `cd0313586e6a2bbd2dea64d410f383d4a9a1f19e0546c8f9c577c0927eb54341`(伺服与磁盘一致);
  bundle 拼接哈希 sha256(index.html+assets/*.js) =
  `89b4361e01ce88ccc8b639270e06e48173b7ee1e4fadf2054bbe5b4116ca3510`。

## 浏览器断言(裸 CDP 无头 chromium --no-sandbox,真实 DOM 读取;双档)

| 断言 | desktop 1920x1080 | mobile 390x844(iphone-14) |
| --- | --- | --- |
| fixture 会话打开且末条回复上屏 | 通过 | 通过 |
| agent 段 = 「代理 Sisyphus - ultraworker」(3 条 assistant 气泡) | 通过 | 通过(24vw truncate 截断显示) |
| 用时三段 = 用时 3m 10s / 用时 9m 46s / 用时 54.0s | 通过 | 通过 |
| user 气泡无溯源 span | 通过 | 通过 |
| 页面无 undefined 泄漏 | 通过 | 通过 |

- 断言明细:qa-assertions.json;截图:desktop-1920.png / mobile-390.png。
- 手机档截断说明:390px 下代理名按 max-w-[24vw] truncate 以省略号收尾,头部行单行
  不换行(设计行为);无遮挡无溢出。

## 测试与门禁

- 新增测试 8 例(message-origin.test.ts 纯函数 5 + message-bubble-origin.test.tsx 渲染 3:
  fixture 全量渲染/缺数据省略无 undefined/user 与压缩条目不受影响)。
- 本树全量 web vitest:**849 passed(90 files)**,基线 841,净增 +8。
- `npx tsc -b` rc=0;oxlint 变更 6 文件 0 warning 0 error;`npm run scan:cn` 0 处(基线 0)。

## 边界对抗核查

- 零用时差:同秒差显 "0.0s" 非空(任务 7 先例同口径,测试锁定)。
- 超长用时:formatStepDuration 分钟级自然增长(75m 3s 形态,无小时档,先例沿用)。
- 无 agent 标注:custom 注记缺失 → agent 段不渲染,无 "代理 undefined"(渲染测试+浏览器断言)。
- 流式在途:无定格条目不参与溯源(无完成时间戳 → 省略);落格后随 EntryBubble 上屏。
- 回归:头部行既有元素(助手/模型短名/时间/中断徽标/操作钮)零改动,仅追加 span;
  MessageActions/复制钮不受影响(全量测试回归通过)。
