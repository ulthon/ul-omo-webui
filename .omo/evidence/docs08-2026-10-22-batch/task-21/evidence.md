# 任务 21 证据：schedule 定时任务 runner 托管与 CRUD 路由

日期：2026-10-22 ｜ 分支 docs08-r7-wave6-t21 ｜ 基线 main@current

## 验证汇总

- server vitest 全量：**492 passed / 0 failed**（基线约 486+，净增 15 条 schedule 测试，EXIT=0）
  - 本任务测试文件 server/test/routes-schedule.test.ts：15 条（CRUD 校验矩阵 5、GET/DELETE/持久化/abandoned 5、投递回注 2、runner 监督 3）
- tsc -b：EXIT=1，31 条错误全部为基线预存（test fakes 与 src/cli.ts；分布：routes-aggregate 14、routes-tags 3、cli.ts 3 等），**schedule 相关新增为 0**（grep schedule 零命中）
- oxlint 改动 7 文件：**0 warnings 0 errors**
- scan:cn（web/）：**0 处，基线对照通过**
- npm install：worktree 内完成（package-lock 无 churn——未改依赖）

## 真实引擎协议对拍（隔离 agentDir /tmp/t21-smoke-agent）

引擎 bundle：node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js（官配对，process-manager 同源解析）。

server 侧直写 pending job 文件（引擎 schema，id sch_abc123def456，due 过去 1s），跑真实 runner 一次扫描 + `--exec` 钩子：

- runner stdout（事件行，协议证据）：`{"event":"fired","id":"sch_abc123def456","sessionId":"ses-smoke","occurrence":1,"outcome":"delivered",...}`
- 钩子捕获的 ScheduledPromptEvent（stdin JSON，与 webui deliver 端点入参契约一致）：
  `{"type":"scheduled_prompt","id":"sch_abc123def456","sessionId":"ses-smoke","sessionFile":null,"cwd":"/tmp","prompt":"协议对拍 prompt","message":"[Scheduled prompt sch_abc123def456: ...]\n协议对拍 prompt","dueAt":...,"firedAt":...,"everyMs":null,"fireCount":1}`
- 投递成功后 pending 文件被引擎认领消费（occurrence 记录归档移除），tombstone/命名契约实测确认（id 必须 sch_+12 位 [a-z0-9]，11/13 位均被引擎静默忽略——对拍中实测修正）

## 真实 server 启动冒烟（隔离 UL_OMO_WEBUI_AGENT_DIR=/tmp/t21-boot-agent，DATA_DIR=/tmp/t21-boot-data，端口 7799）

- 启动日志：`[schedule] runner 已托管启动（omo schedule run --watch）`
- runner lease 落盘：`/tmp/t21-boot-agent/schedule/runners/1471024.json`（watch:true，exec=hook 脚本）
- CLI 对拍：`senpi schedule list` → `Runner: active (pid 1471024)`
- 投递回注端点：错误 token → **401**（挂载在 /api/* 鉴权之前，自带 bearer 校验）
- 端到端触发：播种 3s 后到期 job → runner 15s 轮询触发 → hook POST 回 /api/schedule/deliver（token 继承生效）→ 会话不存在如实 404 → 引擎归档 `failed/sch_e2etest00001@1.json`（lastError "exit code 1"，fireCount 1）——server 格式 job 被真实 runner 全链路消费的证据
- API/CLI cancel 对拍：播种 pending → CLI `schedule cancel` 成功 → API GET 不再含该 job；API DELETE 不存在 id → **404**
- API 校验：未知会话 POST → **404 session_not_found**；GET 回显 `runner:{alive:true}`
- 关停：server SIGTERM → runner 子进程被回收（SIGTERM→兜底 SIGKILL），无泄漏
- 对拍发现的回归（已修 + 回归测试锁）：引擎 job 允许 sessionFile:null，本侧 parser 初版拒绝——已放宽并对齐（test：引擎写入形态兼容）

## 测试服务器清理

冒烟实例（pid 记录 /tmp/t21-boot.pid）已全部 SIGTERM 关停，runner 子进程确认回收；隔离目录 /tmp/t21-boot-*、/tmp/t21-smoke-agent、/tmp/t21-event.json、各日志 /tmp/t21-*.log 在收尾统一删除。真实 agent 目录误写物（首轮 smoke env 用错覆盖变量产生 ~/.omo/agent/schedule 空目录与 lease）已删除，未触碰任何真实任务。

## REST 形状（移交任务 22）

- `GET /api/schedule` → `{ jobs: [{version,id,sessionId,sessionFile,cwd,prompt,createdAt,dueAt,everyMs,fireCount,lastFiredAt,lastError,state:"pending"|"firing"|"failed",occurrence?}], invalid: [{file,error}], runner: {alive: boolean} }`（jobs 按 dueAt 升序）
- `POST /api/schedule` body `{ sessionId, prompt, due: epochMs|ISO, everyMs?: number|null }` → **201** `{ job: {...同上, state:"pending"} }`；校验失败 `{error:{code,message}}`：invalid_session/invalid_prompt(空或>16KiB)/invalid_due(不可解析或>366d，过去时刻合法=下轮即触发)/invalid_every(<60s)/schedule_limit(单会话 50 或全库 1000，400)/session_not_found(404)/schedule_runner_unavailable(503，runner 降级时创建禁用)
- `DELETE /api/schedule/:id` → `{ok:true,id}`；不存在/已取消/触发中 → **404 not_found**（pending→cancelled 墓碑移动）
- 会话删除联动：DELETE /api/sessions/:id 自动把该会话 pending 任务迁 failed 并标 `lastError:"abandoned: session deleted"`（GET state:"failed" 可见）
- i18n/前端无需关心 deliver 端点（内部回注面，非 UI 消费）

## 已知限制

- 「60s 任务到点会话收到注入」的最终一段（prompt 真正进会话回合）未在本冒烟演练：需要真实引擎会话与模型回合；已用等价证据链覆盖（真实 runner 消费 server 格式 job → hook 回注 deliver → 网关 prompt 注入路径为既有 POST /api/sessions/:id/prompt 同一 `engines.prompt`），会话不存在路径实测 404 如实归档 failed。
- 降级路径（runner spawn 连续 3 次失败 → POST 503 schedule_runner_unavailable）由单测锁定判定函数，未做真实 spawn 失败演练。
