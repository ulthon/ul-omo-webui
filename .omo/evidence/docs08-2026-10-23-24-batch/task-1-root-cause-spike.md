# 任务 1：根因 spike——「新建会话报会话不存在：引擎被替换后新会话只占位不落盘」

- 日期：2026-10-25（spike 执行）；事发现场 2026-10-24 13:40-14:24 北京时间
- 执行方式：只读取证 + /tmp 隔离复现；未改任何产品代码
- 前任 worker 心跳死亡后承接，继承发现 1-8 已逐条重取证（下文标注）
- 结论速览：**RpcClient 2026.10.10 与嵌套引擎 bundle 2026.9.28-7 版本错配——引擎 open_session/prompt 全部"认领成功"但从不把会话 JSONL 写盘（node/bun 双运行时复现一致）；webui 因此拿不到 durable id 只留内存别名，后续请求 resolveSession 三级查找全miss → 404「会话不存在」。触发链是 10-24 13:40-14:14 用户在 webui 打开/切换三个项目，ensure() 各拉起一个新引擎。**

---

## a. 现场快照（10-25 晨死态）

**进程扫描**（`ps aux`，2026-10-25 02:1x）：
- 事涉引擎 pid 3897343 / 3907432 / 3918847 / 3941101 / 2698781 全部不存在（`ps -p` 空）——确认"引擎全灭"。
- 10-24 事发现场服务 node[2861468]（systemd ul-omo-webui）已停：syslog.1 `Oct 24 06:24:26 systemd: ul-omo-webui.service: Succeeded`（消耗 CPU 4h45m）。
- 今晨存活的相关进程均属其他工作流：task-2 编排器（/data/projects/senpi-webui-wt/docs08-batch-w0-t2）于 02:13 拉起 `node /data/projects/senpi-webui/server/dist/index.js`（pid 1147551，并发 spike 用，非事发残留）及一个新引擎 senpi（pid 1147959）；另有 CLI 侧 bun 引擎（pid 3962367，10-24 起）。

**注册表**：`/data/projects/senpi-webui/server/data/engine-processes.json` 内容 `[]`（2 字节，mtime 10-24 06:24Z）——与"registry []"一致；服务停止时清空。

**meta.db**（`server/data/meta.db`，bun:sqlite 只读）：
- `meta_project` 恰 3 行：`/data/projects/ul-pool-business-v2`（last_opened 10-21T00:46:56Z）、`/data/projects/senpi-webui`（10-21T12:06:39Z）、**`/`（created 2026-10-21T12:14:11Z，last_opened 2026-10-24T06:08:29.883Z）**——继承发现 2 证实；"/" 并非事发新建，10-21 就存在。
- 孤儿会话 id（51ff4282 / 09f8da13 / a1827a5a）在 `meta_session` **零行**（`select count(*)` = 0）——继承发现 2 后半证实。
- `meta_session` 表无 created_at/project 列（表结构：session_id/pinned/archived_at/renamed_title/unread_count/last_read/updated_at/generated_title）。

**会话目录清单**（`/root/.omo/agent/sessions/--data-projects-senpi-webui--/`）：
- 三个孤儿会话只有空 artifacts 目录，无 JSONL：
  - `2026-10-24T05-58-32-954Z_51ff4282-…-artifacts`（空）
  - `2026-10-24T05-59-32-516Z_09f8da13-…-artifacts`（空）
  - `2026-10-24T06-17-11-043Z_a1827a5a-…-artifacts`（空）——**继承未决问题一已解：a1827a5a 落了盘面（目录），但只有目录没有 JSONL**
  - `find … '*a1827a5a*.jsonl'` 全库无命中
- 对照：`2026-10-24T06-23-46-552Z_01a16c94-….jsonl` 33 行完整，header `{"type":"session",…,"cwd":"/data/projects/senpi-webui"}`；同目录还有 `--/` 命名的 session-holders 等。
- `/` 项目会话目录 `sessions/----/` 最新文件是 10-24T00-42-06Z（有 JSONL），事发窗口无新文件。

**dist 构建 vs HEAD**：`server/dist/index.js` 12,772,956 字节，mtime **2026-10-23 15:00Z**（= 23:00:44 北京，服务 15:00:56Z 启动前 12s）——继承发现 5 证实；worktree HEAD 4aa3d47 为 docs-only 提交，dist 内容对应源码约 f154962（10-23 终验微修包）。依赖层未再变：`node_modules/omo-ai`（5.1.0，嵌套 senpi **2026.9.28-7**）与顶层 `@code-yeongyu/senpi`（**2026.10.10**，server/package.json 依赖）mtime 均为 **10-16 23:43**；无 `node_modules/.bun`（npm 提升布局）。

**版本拓扑**（三份 senpi 并存）：
| 位置 | 版本 | 角色 |
|---|---|---|
| `/data/projects/senpi-webui/node_modules/@code-yeongyu/senpi` | 2026.10.10 | server 的 RpcClient（协议驾驶方） |
| `/data/projects/senpi-webui/node_modules/omo-ai/node_modules/@code-yeongyu/senpi` | 2026.9.28-7 | **被 spawn 的引擎 bundle**（resolveEnginePaths 首选 npm 嵌套候选） |
| `/root/.nvm/.../omo-ai/node_modules/@code-yeongyu/senpi` | 2026.10.21-3 | CLI 侧（全局 omo-ai 5.1.44） |

继承发现 7 证实。

## b. 触发链证据链

**服务代际**（syslog.1 `ul-omo-webui listening` 全量）：10-19 10:35 7790 两代 → 10-20 13:04/13:09/13:43 7788 三代 → 10-22 02:44 一代 → **10-23 15:00:58Z（23:00:58 北京）node[2861468] 单代连续运行至 10-24 06:24:26Z 被停**。继承发现 1、4 证实：事发窗口无服务重启，"重启丢别名"假说排除。06:24 的停止原因也已定位：**用户自己经 CLI 会话 01a16c94（06:23:46Z 创建，bun 引擎，JSONL 完整）发出「停掉本机的7788的开发环境」，agent 排查到 pid 2861468 后终止**（该 JSONL 内含用户原话与 `ss -ltnp` 输出实录）。

**事发窗口服务日志近乎静默**：05:30-06:25Z 内 node[2861468] 仅 06:08:19 comment-checker 警告、06:09:09 memory reflection degraded、06:22:49 reflection launch failed——继承发现 3 证实（06:08:19Z = 14:08:19 北京，比 "/" last_opened 06:08:29Z 早 10s，属同一次 webui 交互波）。

**输入历史**（继承发现 6，经会话库复核）：
- 05:50-05:57Z（13:50-13:57 北京）窗口 senpi-webui 项目**无任何新 JSONL**——用户在 webui 发的 4 条 prompt 没有留下会话文件（与"认领不落盘"一致）；
- 05:58:32 / 05:59:32 两个空 artifacts 目录 = 用户两次新建会话尝试（51ff4282 / 09f8da13）；
- 06:17:11 a1827a5a 第三次尝试（同样只留空目录）；
- 06:23:46 01a16c94（CLI + bun 引擎）成功落盘——同机同时刻 CLI 路径正常，缺陷只在 webui 的引擎路径上。

**spawn 面源码核对**（worktree server/src）：
- `process-manager.ts` `buildSpawnOptions()`：`cliPath = resolveEnginePaths().cliPath`（嵌套 2026.9.28-7），args `--extension <omo-ai>/plugin --multi-session`，env 显式 `OMO_CODING_AGENT_DIR/SENPI_CODING_AGENT_DIR/OMO_NATIVE=1`。RpcClient 自身固定 `spawn("node",[cliPath,…],{env:{SENPI_RUNTIME:"node"}})`（2026.10.10 bundle chunk-WQ77WBQW 原文）——**继承未决问题二已解：SENPI_RUNTIME=node 的 pin 不在 webui 仓库代码里，是 RpcClient 2026.10.10 的 client 侧硬编码**；process-manager 注释（"RpcClient spawn 时 pin SENPI_RUNTIME=node 阻断 launcher re-exec"）与之相符。
- spawn 触发路径四条：`ensure()`（createSession/prompt/messages/queueList/usage/… 全部经 runTraced 前置）、`ensureRunning`（ensure 与 restartProject 的底座）、`restartProject`（stop→ensureRunning，仅 POST /api/projects/restart 显式调用）、启动期 `reapOrphans`（index.ts:133）。
- **13:40/13:49/14:14 三次换引擎的归因**：事发窗口无 restartProject 调用痕迹（syslog 无对应日志）、无服务重启；时间点上引擎 spawn 与用户在 webui 打开/切换项目逐个对应（3897343=senpi-webui 05:40Z、3907432="/" 05:49Z、3918847→3941101=ul-pool 06:14Z，后者两 pid 说明中途崩过一次自动退避重启）。管理器空闲回收默认 30 分钟：10-23 夜使用后的引擎到 10-24 下午早已回收，用户 13:40 起重新点开各项目 → `ensure()` 各自冷启动新引擎。**结论：三次 spawn 都是本代服务管理器的正常 ensure() 行为，"被替换"不是外部进程杀掉，而是冷启动出了坏引擎**（置信度高：spawn 面只有这四条路径，其余三条均有反证）。
- **"/" 项目从何而来**：routes-project.ts `POST /api/projects` 对 path 做存在+目录+realpath 校验，`"/"` 是合法目录 → 10-21T12:14:11Z 前端某次以 path="/" 注册成功（具体前端触发点未定位，**未证实**；10-24 06:08:29Z 的 last_opened 是用户在切换器里点开该项目，同一波交互触发 05:49Z 的 "/" 引擎 spawn——注意 "/" 引擎（05:49）早于 last_opened（06:08），中间用户在多个项目间来回切换，两次操作不矛盾）。
- **bun 引擎 2698781 的定位**：RpcClient 2026.10.10 只会 spawn node，且其 pid 出生序落在上一代服务（10-22 02:44Z 起）生命周期内——与 docs/08 台账当日实录「2026-10-23 13:06 由上一任服务拉起、bun+--extension、承载全部存量会话」一致，应为**上一代服务/其托管 runner（schedule 或旧 spawn 面）拉起的 bun 引擎**，本代服务启动清扫（reapOrphans，10-23 15:00Z）未把它识别为孤儿（不在注册表且 cliPath 特征不匹配）而幸存；它不写新注册表，webui 本代也从未驾驶它。它解释了会话库里为何仍有新 JSONL 与存量会话可用；「健康 bun 引擎被替换」的实质是**本代服务从不接管它，而它自己带着存量会话在 10-24 服务停止时一同消亡**。
- 健康期对照：10-23 16:19Z 持久化的 283fc1ab 文件（内含 header id 01a1698f）与 10-24 00:44Z 的 53f394cd（header id 01a16b5d）虽在本代服务期内落盘，但文件名 UUIDv4 与 header id 不一致、且内容主题是"讨论 question-card/webui"——**无法证实是 webui 驱动所写**（更可能是 CLI 侧会话，v4 文件名另有来源）；因此"本代服务 webui 路径曾正常"没有可靠证据，缺陷可能自 10-23 23:00 换代起就在（此前代次 dist 更旧，RpcClient/引擎组合不同）。

## c. 隔离复现（/tmp/docs08-t1-spike）

环境：`/tmp/docs08-t1-spike/repro-project`（临时项目）、agentDir 隔离到 `/tmp/docs08-t1-spike/agentdir-*`（复制 /root/.omo/omo.jsonc 与 /root/.omo/agent/auth.json 凭证，只读源写 /tmp）。三轮脚本：repro.mjs（裸 send）/ repro2.mjs（state 字段探查）/ repro3.mjs（完全按 webui adapter 的 SDK 面：`client.openSession({provider:"zai-coding-cn",model:"glm-5.3-4k"})` + `client.prompt(text)`）。bun 对照通过 cliPath=桥接脚本（RpcClient 原协议驱 node 包装，包装内 exec bun 拉起同一 cli.js）实现。

**结果一（node，生产同路径，SDK 面，repro3）**：
```
openSession => {"sessionId":"rpc-1","state":{…model:{id:"glm-5.3",provider:"zai-coding-cn",…}}}   ← 模型就绪
prompt disposition => "started"                                                                  ← 回合被接受（认领）
sessions 目录: []        ← 8s 落盘窗口 + 优雅 stop 后仍为空：无 JSONL、无 artifacts
```
open_session 响应里 `state.sessionId`（durable id，如 01a170e2-…）与 `state.sessionFile`（引擎承诺的 JSONL 全路径）**都有返回，但该文件从未出现**——引擎"口头认领"磁盘路径却不写。这与事发现场（51ff4282/09f8da13/a1827a5a 只留空 artifacts、resolveSession 404）形态一致；createSession 拿不到 durable 行 → `durable:false` → 仅内存别名 → 404，链路完全对上。

**结果二（bun，同一嵌套 bundle，SDK 面）**：与 node **完全一致**——prompt "started"、零落盘。**运行时不是判别变量，被 spawn 的 bundle 版本才是。**

**结果三（裸 send 探针）**：`send({type:"prompt",sessionId,text})` 触发引擎内部异常 `Cannot read properties of undefined (reading 'startsWith')`（node）/ `undefined is not an object (evaluating 'text2.startsWith')`（bun）——引擎 2026.9.28-7 在 chunk-56COAYOU `isExtensionCommandPayload(built.text)` 处对 undefined 调 startsWith，暴露该版本 prompt 载荷解析与 RpcClient 2026.10.10 的发送形态存在兼容缝隙（SDK 面虽不崩，但同样不持久化）。

**阻断点记录**：无——复现全程可行；未复现的部分仅"事发现场的具体引擎 stderr"（服务未把引擎 stderr 转发 journald，syslog 无引擎行）。

## d. 根因假设排序

1. **【高置信 ≈0.85】版本错配：RpcClient 2026.10.10 × 嵌套引擎 2026.9.28-7 的 RPC 多会话路径不持久化会话**
   - 正证：双运行时隔离复现 prompt 认领但零落盘（c 节结果一/二）；open_session 返回 sessionFile 却从不创建；裸 send 触发 startsWith 兼容崩溃；CLI（全局 2026.10.21-3）同机同时刻落盘正常（01a16c94）。
   - 反证/缺口：未在引擎代码里定位到"决定不写盘"的确切分支（2026.9.28-7 混淆产物，止步于 startsWith 崩点）；SDK 面 prompt 为何静默不写未完全解释（可能：持久化由 client 侧 flush 协议触发，2026.9.28-7 引擎缺该钩子——**未证实**）。
   - 修复方向（供后续任务）：webui 升级 omo-ai/嵌套 senpi 使引擎 ≥ RpcClient 版本，或 resolveEnginePaths 改选顶层 2026.10.10 bundle；另建议 server 启动时对 spawn 组合做一次"建会话→验 JSONL 落盘"自检。
2. **【高置信 ≈0.8】触发链 = 冷启动 ensure()，非外部替换**
   - 正证：单代服务、spawn 面四路径排除其余三条（无重启日志、无 restartProject 调用痕迹）、三个项目打开时刻与三个引擎一一对应、ul-pool 双 pid 符合退避自愈特征、空闲回收 30min 使 13:40 必然是冷启动。
   - 反证：引擎具体崩溃原因（为何 ul-pool 引擎中途死过一次）无日志可考——**未证实**。
3. **【中高置信 ≈0.65】2698781 bun 引擎 = 上一代服务拉起、本代未被接管也未被清扫**
   - 正证：台账当日实录（bun+--extension、10-23 13:06、承载存量会话）；RpcClient 硬编码 spawn node；出生序在上一代生命周期内。
   - 反证：进程已死无 /proc 留痕，"由上一任服务拉起"无法二次验证——**未证实（承自台账当日实录）**；上一代依赖同为本批 node_modules（10-16 装），其 spawn 出 bun 引擎的具体路径（旧 dist 代码差异或托管 runner）未考古。
4. **【低置信 ≈0.3】"/" 项目来源 = 前端某处以 path="/" 注册**
   - 正证：POST /api/projects 校验放行 "/"；创建于 10-21（非事发）；前端触发点未定位——**未证实**。

---

### 附：清理回执
- 已删除：`/tmp/docs08-t1-spike/agentdir`、`agentdir-node`、`agentdir-bun`、`agentdir-full-node`、`agentdir-full-bun`、`agentdir-sdk-node`、`agentdir-sdk-bun`（含 omo.jsonc 与 auth.json 凭证副本及复现引擎的全部落盘产物）——防凭证残留。
- 保留：`/tmp/docs08-t1-spike/` 下的脚本（repro.mjs / repro2.mjs / repro3.mjs / bun-bridge.cjs / probe1-3.sh / read-meta.mjs）与空 repro-project，供复跑；脚本本身不含任何凭证。
- 复现期间的引擎子进程均已随 client.stop()/timeout 退出；`ps` 复核无 repro 残留进程。
