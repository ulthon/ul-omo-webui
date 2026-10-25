# task-2 并发 spike：CLI 与 webui 同会话并发实证报告（2026-10-25）

> 台账条目：docs/08-产品待办.md「设计：多客户端同会话并发」（2026-10-23 提出）的 spike 兑现。
> 实验性质：隔离实验，未改任何产品代码；实验状态全部位于 /tmp/conc-spike（已按收据清理），会话库经 UL_OMO_WEBUI_AGENT_DIR 注入临时目录，生产 ~/.omo/agent 只读未动（仅复制 4 个配置文件）。

## 一、实验设计

### 实例与隔离证据
- webui 服务：main 检出（4aa3d47）预构建产物 `server/dist/index.js`（2026-10-23 构建）直接运行，全程只读：
  `setsid env UL_OMO_WEBUI_PORT=7791 UL_OMO_WEBUI_DATA_DIR=/tmp/conc-spike/data UL_OMO_WEBUI_CONFIG_DIR=/tmp/conc-spike/config UL_OMO_WEBUI_AGENT_DIR=/tmp/conc-spike/agent UL_OMO_WEBUI_PASSWORD=*** node /data/projects/senpi-webui/server/dist/index.js`
- 主检出污染证明：实验开始前与结束后 `git -C /data/projects/senpi-webui status --porcelain` 均为空（编排器 PHASE7 原文：`main-checkout status: []`；终局复核 0 行）。
- 会话库隔离旋钮（与 r7 QA 先例同源）：webui 缺省 agentDir=~/.omo/agent 与 CLI 同库（server/src/config.ts agentDir() 注释），引擎 spawn 显式注入 OMO_CODING_AGENT_DIR/SENPI_CODING_AGENT_DIR（process-manager.ts buildSpawnOptions）；CLI 侧以同名环境变量指向同一临时目录，两写者即共享同一会话库：`/tmp/conc-spike/agent/sessions/--tmp-conc-spike-proj--/`。
- 凭证：自真实 agentDir 复制 auth.json / models.json / models-store.json / settings.json 四文件至临时 agentDir；真实目录零写入。
- 版本矩阵（真实用户场景即存在偏差；2026-10-25 修正归属）：webui 引擎 bundle = 仓库 node_modules omo-ai 5.1.0 **嵌套** @code-yeongyu/senpi **2026.9.28-7**（证据：schedule-runner 与引擎同一 cliPath，cmdline 原文 `node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js`，resolveEnginePaths 首选候选即嵌套官配对）；顶层 @code-yeongyu/senpi 2026.10.10 是 server 进程直读/SDK 侧副本，**非引擎 bundle**。CLI = 全局 `omo` 5.1.44（senpi 2026.10.21-3）。模型 zai-coding-cn/glm-5.3-4k（会话 model_change 条目原文）。

### 步骤（编排器 task-2-orchestrator.sh，setsid 脱离 cell 预算运行）
1. 重建隔离目录 → 起 7791 实例（就绪判定：未认证 GET /api/projects 回 401，有界 120s）。
2. 登录（POST /api/auth/login，cookie）→ 注册临时项目 POST /api/projects {"path":"/tmp/conc-spike/proj"} → 建会话 POST /api/sessions。
3. webui 基线 prompt → CLI 对同一会话两回合：`timeout 240 omo --offline -nt -p "只回复四个字：CLI写入" --session-id <引擎会话id>`（CLI 成功命中既有会话，无「CLI 无法指向既有会话」限制）→ 并发阶段（webui prompt 与 CLI -p 同时发起）→ kill server 后重启 → 各时点采样。
4. 采样项：md5sum + wc -l 会话 JSONL；GET /api/sessions/:id/messages（无 cursor = r7 任务 16 尾窗直读磁盘路径）；同端点 ?cursor=<leafId>（引擎内存增量路径）；GET /api/sessions?project=…（runState）；validate-jsonl.cjs 逐行 JSON 校验。
5. 清理：仅按精确 pid（/proc/*/environ 匹配 UL_OMO_WEBUI_DATA_DIR=/tmp/conc-spike/data 的本实验进程集），全程有界等待，无任何 pkill。

### 关键标识
- webui 会话 id：`01a170d5-a66b-74d6-864a-991e868e9750`；引擎会话文件：`2026-10-25T02-13-32-373Z_e66222c8-8f03-41dd-95d5-baf690b1d3f5.jsonl`。

## 二、锁机制复核（STEP 0）

检索范围：/data/projects/senpi-webui/node_modules/omo-ai（5.1.0，仅 bin+plugin 无 dist）、其嵌套 @code-yeongyu/senpi dist（webui 引擎实际运行体）；全局 CLI 包同构未另查（5.1.44 与 5.1.0 同源代码族）。

**结论：会话 JSONL 写入不存在跨进程文件锁。** 全库 grep `flock|lockfile|proper-lockfile|.lock|O_EXCL|lockSync` 仅四处命中，均与会话文件无关：
- `dist/package-manager-cli.js`：proper-lockfile 锁扩展安装 managedRoot/update
- `dist/runtime-snapshot/registry.js`：LOCK_NAME=".lock"（运行时快照 claims/build 锁）
- `dist/beta/omo-local-update.js`：omo-local-update.lock（自更新）
- `dist/bundle/cli.js`：同快照锁常量（STALE_LOCK_MS/CLAIMS_DIR 等）

会话写路径实读（core/session-manager.js 及配套三模块）：
- 追加写：`appendFileSync(sessionFile, JSON.stringify(entry)+"\n")`（_persist）与异步 `appendFile`（_writeHeaderAsync 续写）
- 全量重写（2026-10-25 修正实现归属）：实际运行的引擎 bundle（嵌套 2026.9.28-7，全文无 replaceFileAtomically）`_rewriteFile()` = `openSync(sessionFile, "w")` **截断后就地逐行 writeFileSync**（其 dist/core/session-manager.js 原文）——先读内存态后整文件重写，与外部进程并发追加构成**丢失更新窗口 + 撕裂窗口**（重写期间外部追加的字节可被后续逐行写覆盖）。`_rewriteFile() → replaceFileAtomically()`（同目录 tmp + fsync + rename 原子替换，session-file-replace.js:85）是**顶层 2026.10.10** 副本的实现，原稿误将其归到引擎 bundle（实测未击中该窗口，见观察 b）
- 撕裂尾自愈：`tailMayBeTorn` → `truncateToLastCompleteLine`（session-write-recovery.js）只处理自身半行，不感知外部写者
- `reserveSessionWrite`（session-write-reservation.js）仅在 multi-session host 的 session-worker 内安装钩子（modes/rpc/session-worker-credit.js:25 installSessionWriteReservation），standalone CLI 进程无钩子（空操作）；`registerSessionWriter/hasOtherLiveSessionWriter` 为进程内 WeakRef 注册表，非跨进程
- 新会话文件 `openSync(path, "wx")` 独占创建（两进程同时首建同一会话会一方 EEXIST，本实验未踩中：webui 先落盘）

较台账 2026-10-23「快速 grep 未深查」的增量：坐实「无锁」，并补两处结构性细节——replaceFileAtomically 的丢失更新窗口、host 内 worker 序列化不覆盖外部进程。

## 三、三观察项逐项结论

### (a) webui 对 CLI 写入的可见性：双读路径分叉——尾窗直读可见、引擎内存路径不可见、重启后归一

md5/wc 时间线（编排器原文摘录）：
```
[PHASE3] baseline: 17 行 | 3bad5ac5620be35e4bda0c90fee3b5f7
[PHASE4] after-cli: 30 行 | 72b7472dbdcd8103960d78140db8e80f    (CLI exit=0)
[PHASE5] after-concurrent: 39 行 | c1c98e9ce7cdef3dfb4a62c46c0b9969
[PHASE6] final: 43 行 | e8e893d360e2a393dc6ae88fc6cde47d
```

CLI 写入后，同一 GET 端点两条代码路径的 curl 往返原文：
- 无 cursor（尾窗直读磁盘，engine-runtime.ts 任务 16 路径）：`after-cli-messages-tailread.json` → `entries=29`，正文中 "CLI写入" 出现 9 次——**CLI 写入可见**
- 带 cursor（引擎内存增量）：`after-cli-messages-cursor.json` 原文体：
  `{"sessionId":"01a170d5-a66b-74d6-864a-991e868e9750","entries":[],"leafId":"f90a335e","cursor":"f90a335e","hasMore":false,"oldestId":null}`
  ——引擎内存态对 CLI 新增 13 行零感知（恒空增量）
- 服务重启后（kill+重启，新引擎从盘重开会话）：`after-restart-messages.json` → `entries=42`（CLI写入 命中 9）——分叉消失
- 四时点快照序列：baseline entries=16（CLI写入=0）→ after-cli 29/9 → after-concurrent 38/9 → after-restart 42/9

结论：不重启时 webui 存在两套真相源——「列表/新开页」（尾窗直读）能看到 CLI 消息；「cursor 增量、?full=1、SSE gap 对账」（走引擎）全部不可见。用户观感即「新开标签有、旧标签永远等不到」。

### (b) JSONL 完整性：双进程交错追加零损坏；rewrite 丢失更新窗口存在但未被击中

校验器输出（node validate-jsonl.cjs，对三时点镜像文件）。诚实披露：实验进行时校验器调用路径传错未跑成（task-2-raw/concurrent-validate.txt 与 final-validate.txt 原文均为 `Error: Cannot find module '/validate-jsonl.js'` 的 MODULE_NOT_FOUND），下表所列校验结果系事后对已入库的镜像文件复跑所得，数值与镜像文件行数一致。
```
session-after-cli.jsonl        {"jsonLines":30,"badLines":0,"verdict":"ALL_LINES_VALID_JSON"}
session-after-concurrent.jsonl {"jsonLines":39,"badLines":0,"verdict":"ALL_LINES_VALID_JSON"}
session-final.jsonl            {"jsonLines":43,"badLines":0,"verdict":"ALL_LINES_VALID_JSON"}
```
- 行数单调 17→30→39→43：无截断、无重置、无半行
- 父链完整性：43 条 entry 的 parentId 全部在文件内可解析（parent_missing=0）；两写者各自延接共享树（CLI turn2 的 assistant 条目 parentId 即 webui 基线 leaf `f90a335e`）——文件保持单棵连通树，未出现结构分叉损坏
- 并发度如实说明：并发阶段两写者写事件相隔约 19 秒（CLI 02:15:44-51，webui 引擎侧后续写 02:16:10-11），属「进程并发、写事件交错」而非同毫秒对撞；期间 webui 服务被编排器 kill（02:16:12），引擎子进程存活为孤儿并继续追加（行 40-43）后收到 abort（toolResult 原文 "Tool execution aborted"/"Operation aborted"）——**引擎对外部进程扩展过的文件继续追加，未触发 _rewriteFile，未清掉 CLI 行**。丢失更新窗口未被实测击中，其存在性由代码实读支撑（见锁机制复核）。

### (c) 运行状态分叉：CLI 活动对 runState 完全不可见；服务端还会丢失自己引擎的回合追踪

- CLI 回合耗时 85 秒（02:14:09→02:15:34）结束后 1 秒采样，GET /api/sessions?project=… 原文（节点字段）：
  `{"id":"01a170d5-a66b…","runState":"idle","active":false,"modified":"2026-10-25T02:14:32.470Z"}`
  ——modified 已被 SDK 直读更新（文件级，列表排序正确），但 runState 恒 idle：webui 对「外部进程正在写同一会话」无任何事件源，全程不可能显示运行中。
- 更极端样本（webui 自身回合的分叉）：webui 基线 prompt 回执 30 秒超时报错——
  `{"error":{"code":"internal","message":"Timeout waiting for response to prompt. Stderr: "}}`
  服务端放弃等待后**引擎孤儿回合继续运行至 02:16:11**（跨越 CLI 两回合与服务重启，期间持续落盘），而 02:16:10 采样 runState 仍为 idle——引擎实跑 2.5 分钟、UI 恒显空闲。第二条 webui prompt（02:15:38 发出）因引擎回合在途直至实验结束从未派发，其 user 消息未落盘。
- 会话文件中 role:user 条目仅有 CLI 的两条（原文时间戳与文本头）：
  `2026-10-25T02:14:24.387Z 只回复四个字：CLI写入`
  `2026-10-25T02:15:44.224Z 用约150字介绍信号量，写完即止`
  ——webui 发出的两条 prompt（基线/互斥锁）user 消息均未落盘（与 ACK 超时路径相关，见附带发现 1）。
- 重启后会话列表 runState:null（新服务未水合运行态，回退空）。

## 四、附带发现（超出三观察项、与本台账条目治理直接相关）

1. **prompt ACK 30s 超时的连锁失效**：回执报错 → 服务端不再追踪回合（runState 停留 idle）→ 引擎侧回合继续实跑 → user 消息不落盘 → 后续 prompt 永久排队无回音。首 token 慢（本实验 glm-5.3-4k 被注入引导去读技能，首次响应 >30s）即可触发，属「误导性空闲」的引擎侧新形态。
2. **新项目首回合被 omo-onboarding:bootstrap 注入劫持**（会话文件第 12 行，display:false 原文：`"Read the onboarding skill at /data/projects/senpi-webui/node_modules/omo-ai/plugin/skills//onboarding/SKILL.md with the read tool and follow it. Greet the user first."`）：模型弃用户 prompt 去执行 onboarding 流程。与并发无关，但威胁一切「首回合自动化验证」类测试的确定性。
3. CLI 侧扩展在会话被替换/重载后报 stale ctx（cli-turn1.log 原文：`memory reflection launch failed ... This extension ctx is stale after session replacement or reload`），CLI 写入本身仍成功——引擎对外部延长会话有韧性，扩展生命周期有裂缝。

## 五、防护建议分级

- **引擎侧（值得做）**：跨进程会话写互斥/占用声明结构性缺失——最低成本方案为会话文件旁挂 flock 类占用声明（pid+启动时间），第二写者 open 时可见「正被占用」；_rewriteFile 前强制重读磁盘合并外部追加，消掉丢失更新窗口。
- **webui 侧（值得做）**：打开/轮询会话时检测文件 mtime+size 与引擎内存态不一致即提示「会话已被外部进程修改」并提供 resync/重启引擎动作；prompt ACK 超时路径补「引擎仍在跑」补偿态，消除误导性空闲与永久排队。
- **无需防护**：纯读路径（尾窗直读）已天然合并外部写入；JSONL 追加在 O_APPEND 语义与实测下未见撕裂，不需要行级校验修复。

## 六、环境事件与并行冲突记录（影响判读，必读）

1. 第一次尝试（02:06-02:07）实验目录被删、实例失联——当时误判「环境事故」。终局清理收据揭示根因：**存在并行执行者会话在跑同一 task-2**（同用 /tmp/conc-spike 路径与 7791 端口，特征：`bash -lc … nohup node server/dist/index.js … /tmp/conc-spike/logs/server.log`、会话 id 01a170e0-…、提示词「只回复两个字：收到」）。02:06 的删除即对方清理步骤所致；本方终局 rm -rf 也同样打掉了对方在跑的实验状态（604K）——互踩双发生了。建议后续同类 spike 路径按执行者去重（如 /tmp/conc-spike-<id>/），端口错开。
2. 本实验全部原始产物已于采集当时实时镜像至工作树 task-2-raw/，最终删除 /tmp/conc-spike 不影响任何证据；三份会话文件镜像 md5 与活捕 md5 完全一致（72b7472d…/c1c98e9c…/e8e893d3…）。
3. 当前 7791 监听者（pid 1175764，02:21:29 起，父 1175763 bash -lc）属并行执行者新起实例，**不属于本实验 lineage**；本实验全部 9 个 pid（编排器/看门狗/两代 server/引擎/runner）经 ps -p 逐一复核全部消亡。
4. 本编排器由 senpi 会话派生，引擎经 env 继承到 harness 注入项，会话文件出现 senpi-task.usage / environment-context 等注入条目——不影响并发机制结论，但提示插件注入面之宽。

## 附录：并行执行者独立复现（2026-10-25 02:31-02:35）

- 六.1 所述被本方终局清理打掉的并行执行者重建沙箱后完成独立复现，核心结论一致：webui 建会话+基线回合落定（20 行，md5 5f6581b35afc1027449d3e5213627670，校验 OK，runState=idle）→ CLI `omo --session-id <引擎会话id> -p '只回复四个字：CLI写入'` 同会话单发 → 尾窗直读 entries=41、「CLI写入」10 命中，`?full=1` entries=34、**0 命中**——观察 a 双路径分叉独立复现；会话文件 42 行校验全合法。
- 复现新发现（隔离泄漏）：CLI 回合成功落盘（20→42 行）后进程仍被 timeout 200s 击杀（exit=124）——卡在**真实用户内存库**的 recall-sidecar 锁（cli-turn1.log 原文：`error: "Lock is held: /root/.omo/memory/agents/proj-800c383c/runtime/locks/recall-sidecar.<sid>.lock"`）。CLI 继承 HOME=/root，memory 侧身份绑定不随 OMO_CODING_AGENT_DIR 隔离，临时项目身份写进真实 ~/.omo/memory 并可与其他会话争锁——与锁复核同域的第二个「无跨进程协调」样本。
- 复现者已按收据清理自身实例、watcher 与 /tmp/conc-spike。

## 七、可复现性与产物清单

- 编排器：`task-2-orchestrator.sh`（本目录；PHASE0-7 全日志 task-2-raw/orchestrator.log）
- 校验器：`validate-jsonl.cjs`（逐行 JSON.parse，报告坏行）
- 原始产物：`task-2-raw/`——4 份 messages 快照（baseline/after-cli-tailread/after-cli-cursor/after-restart）、4 份会话列表（runState）、3 时点会话文件镜像、CLI 日志 ×2、server.log、watchdog.log（3s 采样存活时间线，全程 data/settings/serverlog=ok）、清理收据
- 清理收据：9/9 pid gone；/tmp/conc-spike 已删除（rm -rf 回执 `ls: cannot access … No such file or directory`）；7791 由并行执行者占用（非本实验，见第六节 3）；主检出 git status 干净
