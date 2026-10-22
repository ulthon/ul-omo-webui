# 任务 15 排队单显示源与立即发送 QA 报告（docs08-2026-10-22-batch）

- 实例：worktree docs08-r7-wave1-t15 隔离实例 http://127.0.0.1:8955（UL_OMO_WEBUI_DATA_DIR=/tmp/t15-qa-data，UL_OMO_WEBUI_AGENT_DIR=/tmp/t15-qa-agent（播种生产 models-store/auth/models 配置），UL_OMO_WEBUI_PASSWORD 注入；server/dist 内嵌资产伺服）
- 陈旧产物防线（F3 教训）：QA 前根构建 `npm run build` 重建内嵌资产并重启实例；curl 探针核对线上 bundle 与磁盘一致
- bundle：磁盘 web/dist/assets/index-Dmpwpg4c.js = 线上伺服 assets/index-Dmpwpg4c.js（一致）；sha256 = 95a34fcb84c4ed64f13fd6f24973c48023e1bcaa7543d5a42b574d9b30d632f1
- 视口：桌面 1920x1080 / 手机 390x844（omowright.emulate，goto 后重打，mobile+hasTouch）
- 真实引擎回合：计数回合（请从1数到3000）经 composer 实发，回合中真实排队/操作

## 桌面档证据（真实回合中排队两条）

| 断言 | 证据 | 结果 |
| --- | --- | --- |
| 排队后消息流零占位 | desktop-1-queue-two-actions.png：流内仅首条计数消息，排队甲/乙只出现在排队条 | 通过 |
| 每条双操作（testid queue-item-send-now / queue-item-remove） | desktop-1 每行 ▶ 与 × 双钮；results JSON actionButtons {sendNow:2, remove:2} | 通过 |
| 立即发送=转 steer 注入 | session-log-queue-events.txt 行3：`{"event":"queue_enqueue","mode":"steer","count":1}`（17:50:56.377，乙 send-now 触发）；desktop-2 显示乙行变 Steer 徽标 | 通过 |
| 余项仍排队 | session.log 行4 followUp count:1（甲重入队）；desktop-2 甲行保持 Follow-up | 通过 |
| 单条撤销 | desktop 撤销排队丙：afterRemove 后丙不在队列；jsonl user 条目无丙 | 通过 |
| 落定后收敛恰一份 | jsonl-user-entries-excerpt.txt：user 条目恰 3 条（计数/乙/甲各一条，无占位无重复）；丙 0 条 | 通过 |
| 竞态不丢 | queue-actions.test.ts：窗口期新条目合并 / 落定窗口快照为空重排队不丢 / 409 竞态重试（单测 9 例） | 通过 |

## 手机档 390x844

- mobile-1-queue-actions.png：回合中排队 1 条（Follow-up 徽标 + ▶/× 双钮 + queued toast），消息流零占位
- mobile-2-after-remove.png：回合中再排一条后撤销，队列操作手机可达可操作
- session.log 18:04:45.713 `queue_enqueue mode:steer`（手机档 send-now 注入证据）

## 回归

- vitest：83 文件 786 用例全绿（基线 775 → 786，净增 11；含新增 queue-actions.test.ts 9 例 + first-message-display/composer-waiting-hint 迁移改写）
- tsc -b 干净；oxlint 变更文件 0 错误
- 正常发送（直发）回归：桌面首条计数消息直发正常入流；粘贴 chip 路径未触碰（task 3 测试全绿）

## 环境注记（非产品缺陷）

- 手机档 send-now 后引擎 steer 项在下一次循环边界前仍会出现在 GET queue 列表中（引擎真相），此时对该行做撤销=撤回尚未被读取的注入项（符合单条撤销语义）；QA 脚本因此移除的是已注入行而非新排队行，jsonl 与日志完全一致可溯
- 排队请求不携带 thinkingLevel/images（spike 铁律，保持）
