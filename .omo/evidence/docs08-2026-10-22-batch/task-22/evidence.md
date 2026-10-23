# 任务 22 证据：schedule 前端 UI

日期：2026-10-23 ｜ 分支 docs08-r7-wave6-t22 ｜ 基线 main@b511962（含 t21 schedule 后端）

## 验证汇总

- web vitest 全量：**98 文件 943 passed / 0 failed**（本批次基线 920：t21 后基线实际为 919 过 + 1 预存红，见下；净增 23 条 = schedule-data 纯函数 12 + schedule-ui 组件 11）
- 预存红修复：tests/i18n-errors.test.ts 在本基线即红（t21 后端新增 8 个错误码未入映射：invalid_due/invalid_event/invalid_every/invalid_prompt/invalid_session/schedule_limit/schedule_runner_unavailable/unauthorized）——本任务随错误映射职责一并修复：ERROR_CODE_KEYS +8、zh/en/errors.ts +8、SCANNED_CODES +8（62→70），并排除根构建生成物 `*.generated.ts`（内嵌 web 产物含压缩前端 ApiError 字面量会污染活扫，实证于并发根构建时）
- server vitest 全量：**39 文件 501 passed / 0 failed**（本任务零 server 改动，跑通作旁证）
- tsc -b：**0 错误**（web 全量）
- oxlint src：**7 warnings = 基线 7（只减不增达标，新增 schedule 目录 0 警告）**
- scan:cn：**0 处，基线对照通过**（i18n 词典目录不在扫描范围，无需重建基线）
- package-lock.json：npm install 意外变动已 `git checkout --` 还原，不入提交

## QA 实例（隔离 + 真实 t21 后端）

- 根构建重生成内嵌资产后启动：`UL_OMO_WEBUI_AGENT_DIR=/tmp/t22-agent DATA_DIR=/tmp/t22-data PORT=7797`（日志 /tmp/t22-server.log）
- 启动日志含 `[schedule] runner 已托管启动（omo schedule run --watch）`
- **bundle 哈希核验**：伺服资产 `assets/index-fnAT2p-4.js`（GET / 抓取）== web/dist 磁盘同名文件，sha256 前 16 位 `e025a48b590e648d`（终版代码根构建产物，含下述溢出修复）
- 会话种子：/tmp/t22-agent/sessions/--tmp-t22-proj--/ses-t22-0001.jsonl（引擎 schema 头行，双横线目录尾缀），项目 /tmp/t22-proj 经 POST /api/projects 注册
- 界面语言：预置 kv `ui.language=zh-CN`（无头浏览器 navigator 为 en，预置后与双档验收一致）

## 双档走查（真浏览器，omowright connectPipe + chromium-1243 --no-sandbox）

### 桌面 1920x1080（01-09）

| 步骤 | 断言 | 截图 |
| --- | --- | --- |
| 登录进应用 | 设置按钮可达 | 01-desktop-app |
| 设置面板「定时任务」分区 | 空态「暂无定时任务」+ 提示 + `runner 运行中`（emerald 点） | 02-settings-empty |
| 弹框空 prompt 提交 | 客户端拦截「请填写提示词」，零 POST | 03-empty-prompt-blocked |
| 新建 A：超长 prompt（160+ 字）+ 1h 预设 | 201；行内摘要截断 81 字含省略号（promptExcerpt 上限 80） | 04-dialog-created-1h-longprompt |
| 新建 B：自定义 ISO `2026-10-24T09:00:00+08:00` + 循环 300s | 201；列表显「每 5m」 | 05-dialog-recurring-5m |
| 新建 C：过去时刻 ISO | 行显「已到期·待触发」（绝不倒挂负倒计时） | 06-past-due-overdue |
| 设置分区全局列表 | 3 行 = GET 一致（A/B pending + C failed）；会话名列显种子会话标题 | 07-settings-list-3jobs |
| 设置分区分段取消 | 点击取消 → DELETE 发出 → 行即移除（3→2）+ 静默 GET 对账 | 08-settings-after-cancel |
| invalid 记录回显 | pending/ 投放坏 JSON → 「1 条记录无法解析」如实回显 | 09-invalid-row |

### 手机 390x844（10-13）

- 10-mobile-app：登录后应用首屏
- 11-mobile-schedule-dialog：行菜单「定时任务…」→ 弹框 390 档可达可用（表单 schedule-form）
- 12-mobile-created：手机档创建成功（「手机档创建验证」入列表）
- 13-mobile-settings-schedule：设置分区 390 档可达

### 回归（14-16）

- 14-regress-shortcuts：t12 快捷键对话框照常
- 15-regress-settings-sections：设置面板其他分区（项目/侧栏/标签/对话/语言）齐全
- 16-regress-mobile-sheet：t19 手机切换器 sheet 照常

### runner 状态如实（17）

- 17-runner-down.png：SIGKILL runner 子进程后设置分区转「runner 未运行」（destructive 点 + hover 说明）；随后监督退避重启自动恢复（curl `runner.alive` false→true 实证，服务端日志「runner 退出（signal=SIGKILL），退避重启」）

## 端到端投递（真实引擎 runner 消费本侧创建的 job）

- 任务 C（过去时刻）被真实 runner 认领：`fireCount:1`、`occurrence:1`、归档 `failed/sch_4s4urkfqqbx1@1.json`（`lastError:"exit code 1"`——fixture 会话无可用模型，引擎回合失败，投递链路本身已走通）
- 会话 jsonl 尾部出现引擎 resume 条目（thinking_level_change/pi-rules.scan/senpi-memory.session-binding，00:37:13）——runner→--exec 钩子→/api/schedule/deliver→会话网关全链路实证

## 503 降级路径的验证口径（如实记录）

- `degraded()` 判定 = 连续 3 次 **spawn 构造失败**（engine/schedule-runner.ts:90-92）。实测「引擎 bundle 改名」只造成子进程运行时 exit 1（spawn 本身成功），不进该计数——降级态无法在不动 spawn 可执行文件的前提下自然触发，故本任务按简报预案降为 **unit 级证明**：web/tests/schedule-ui.test.tsx「503 降级」用例（POST 503 schedule_runner_unavailable → 降级提示 + 提交禁用）+ 服务端 routes-schedule.ts:106-108 守卫
- 可观测的 runner 存活面（alive=false → 状态列转未运行）已真机捕捉（17 号截图 + 恢复实证）

## 走查发现的布局缺陷（已修 + 终版重拍）

- 首轮走查实锤：设置分区内含长 prompt 行时，Radix DialogContent（grid + sm:max-w-md）的 auto 轨道被行内 truncate span 的 intrinsic 贡献（flex-1 basis-0 在 intrinsic sizing 按内容计，实测 1173px）撑破——行取消钮/状态徽标溢出弹框到视口右缘（坏照留档 probe 流程，未入证据）。
- 修复：分区根、弹框列表、表单三处加 `min-w-0` 切断贡献链（在页实测塌回 416px）。修复后全部截图为终版产物重拍（01-16），行宽 416px 内布局规整（见 07 号）。

## 已知限制

- 设置分区列表不做分页（50+ 任务时依赖弹框滚动，Radix DialogContent 自滚动）；种子/验收场景最高 3 任务，超长列表未见异常
- runner 未运行的 hover 说明为静态文案，不区分「短暂退避中」与「持续不可用」
