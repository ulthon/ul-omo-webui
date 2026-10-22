# 任务 7 QA 记录：折叠步骤行耗时标签

日期：2026-10-22 | 分支：docs08-r7-wave1-t7 | 基线：main@1e9b106

## QA 实例

- 隔离实例：`UL_OMO_WEBUI_PORT=7807`，`UL_OMO_WEBUI_DATA_DIR=/tmp/t7-qa/data`，`UL_OMO_WEBUI_AGENT_DIR=/tmp/t7-qa/agent`，口令走 env（QA 后进程已回收、/tmp 已清空）。
- fixture 会话：`<agent>/sessions/--tmp-t7-qa-project--/2026-10-22T10-00-00-000Z_t7fixture0001.jsonl`（9 行：session 头 + u1 + a1(thinking+toolCall，entry ts) + r1(toolResult，+3.8s) + a2 + u2 + a3/r2/a4 老形态无时间戳字段）；项目经 POST /api/projects 注册。

## bundle 哈希（陈旧产物防线）

- 根构建 `npm run build` 后启动实例。
- 伺服核验：`GET /` 引用 `assets/index-kGsbHZBz.js`，伺服 sha256 = 磁盘 = `1e658646a3748de36d0fd6d0f0e5d31db56a93422579c694adcaf67a410c0089`（css `index-qwWVcSqQ.css` = `e742cf96…`）。

## 浏览器断言（playwright-core 无头 chromium --no-sandbox，真实 DOM 读取）

| 断言 | desktop 1920 | mobile 390 |
| --- | --- | --- |
| toolCall 卡片耗时标签 = "3.8s"（toolCall→toolResult 时间戳差） | PASS | PASS |
| thinking 折叠行耗时标签 = "3.8s"（条目→下一条目时间戳差） | PASS | PASS |
| 老形态（无时间戳）toolCall 卡片无标签（count=0） | PASS | PASS |
| 老形态回合消息正常渲染（不崩、无占位标签） | PASS | PASS |
| thinking 耗时标签恰 1 个（仅带时间戳条目） | PASS | PASS |
| tool 耗时标签恰 1 个（仅配对到结果那条） | PASS | PASS |
| 标签样式 `text-xs text-muted-foreground tabular-nums` | PASS | PASS |

- 截图：desktop-1920.png（1920x1080）/ mobile-390.png（390x844，iPhone 12/13/14 档）——两档均可见折叠行 "3.8s" 标签且老形态行无标签。
- 同秒对边界（"0.0s" 非空非 NaN）、缺端 null、分钟级 "9m 46s" 形态由纯函数单测覆盖（step-duration.test.ts，10 用例）。

## 格式先例决策

- 分钟级沿 subagent-panel formatDuration 先例 `Nm Ns`（如 "9m 46s"）；<60s 一位小数秒（"3.8s"）；同秒差 "0.0s"。
- 小时档：库内无既有小时格式先例，分钟数自然增长（如 "75m 3s"），不新增小时档——已记录为本任务格式决策。

## 清场

- 7807 实例进程已 tree-kill；/tmp/t7-qa* 全部删除（终态 `/tmp/t7-*` 计 0）。
