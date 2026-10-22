# 任务 1：测试基线复跑 + 性能测量埋点与四层归因报告

- 日期：2026-10-22；执行面：worktree `/data/projects/senpi-webui-wt/docs08-r7-wave0`（branch `docs08-r7/wave0`，base main@3dc9395）
- 计划依据：`.omo/plans/docs08-2026-10-22-batch.md` todo 1（Closes GAP-6 测量部分；修复在任务 16）
- 四层模型（docs/08:391-397）：① getEntries 全量（rpcMs）② runExclusive 串行排队（queueWaitMs）③ switchTo 每次开仓（switchToMs）④ 跨项目冷 spawn（ensureMs）

## 1. 基线复跑

| 套件 | 轮次 | 结果 | 证据 |
| --- | --- | --- | --- |
| server（`cd server && npx vitest run`） | 基线 run1 | 446 passed / 1 failed（447）EXIT=1 | baseline-server-run1.log |
| server | 基线 run2（稳定性复验） | 447 passed (447) EXIT=0，12.56s | baseline-server-run2.log |
| server | 改后 run1（埋点+新测试） | 10 failed（见 §2 回归记录，当轮修复） | postchange-server-run1.log |
| server | 改后 run2（最终树复验） | 456 passed (456) EXIT=0（447 基线 + 9 新增 perf 门控/span 格式） | postchange-server-run2.log |
| web（`cd web && npx vitest run`） | 基线 run1 | 714 passed (714) EXIT=0 | baseline-web-run1.log |
| web | 改后 run1（最终树） | 720 passed (720) EXIT=0（714 基线 + 6 新增 web 门控/mark-measure） | postchange-web-run1.log |

**既有 flaky（不修，如实报）**：`test/routes.test.ts > EngineRuntimeRegistry 单驱动与 durable id > (a-2) 流式中引擎崩溃 → 合成 agent_settled（engine_crash）+ 清位 + 可继续 prompt`。基线 run1 失败（`AssertionError: expected null to deeply equal []`，229ms），run2 同树复跑即绿——时序敏感用例的既有不稳定，与本任务改动无关（失败先于任何改动发生）。

**改后 run1 的 10 例失败为当轮自引入回归，已修复**：runTraced 关闭路径初版漏了原方法体必有的 `ensure()`，导致 adapter 未启动（`EngineAdapterError: adapter 未 start()`）。修复为 `ensure().then(() => runExclusive(...))`（逐字保持原语义）后，相关 5 文件 72 例复跑全绿，最终树全量 456/456。

## 2. 埋点实现（UL_OMO_WEBUI_DEBUG_PERF，默认关=零输出零行为差异）

先例：`config.ts` DEBUG_SSE 同款真值集合（1/true/yes/on）与 dlog 管道。

| 文件 | 内容 |
| --- | --- |
| `server/src/api/perf.ts`（新） | 门控常量 DEBUG_PERF、PerfSpan、formatPerfLine 纯函数、logPerfSpan/logPerfHttp |
| `server/src/api/engine-runtime.ts` | runTraced 私有方法：④ensure 计时 + ②runExclusive 排队计时 + 失败 err 码；messages/usage/questionsList/queueList/prompt 五 op 接入，body 内自记 ③switchTo/①rpc 段与 entries |
| `server/src/api/routes-session.ts` | GET /api/sessions/:id/messages HTTP 计时：`[perf] http op=messages status=<n> ms=<total> entries=<n>`（错误路径记 status） |
| `web/src/lib/perf.ts`（新） | localStorage `ulomo_perf=1` 门控；perfMark/perfMeasure |
| `web/src/components/chat/chat-view.tsx` | 加载 effect：mark 起点→条目落 store 后 measure + 控制台一行（`[perf] web op=messages session=<id8> ms=<n> entries=<n>[ incr=1]`） |

行格式（计划任务 1 契约）：`[perf] op=<name> proj=<hash8> session=<id8> ensureMs= queueWaitMs= switchToMs= rpcMs= entries=<n>`；失败附 `err=<code>`（冷启动 503 归因）。

新增单测：server `test/perf.test.ts` 9 例（门控缺省关/真值集合、span 行逐字段、err 段、hash 稳定性、开/关输出）；web `src/lib/perf.test.ts` 6 例（localStorage 门控、mark/measure 开关两侧、异常吞并）。

## 3. 实测配方（隔离实例，只读不写）

沿 r6 F3 实例配方：`node scripts/build-package.mjs` 构建后 `node server/dist/index.js`，env：`UL_OMO_WEBUI_PORT=8960`、`UL_OMO_WEBUI_DATA_DIR=UL_OMO_WEBUI_META_DB=/tmp/w0-perf-qa/data`、`UL_OMO_WEBUI_AGENT_DIR=/tmp/w0-perf-qa/agent`（自真实 `~/.omo/agent` 拷贝 auth/models/models-store/settings + 仅两项目 sessions 目录共 27M）、`UL_OMO_WEBUI_PASSWORD`、`UL_OMO_WEBUI_DEBUG_PERF=1`。项目注册 `/data/projects/senpi-webui`（proj=cd6e6588，sha256 前 8 位已独立复算核实）与 `/data/projects/ul-pool-business-v2`（proj=dac28f75）。

只读纪律：全程零 prompt/零写接口；GET messages 前先 `GET /api/sessions?project=`。引擎打开既有会话会向 jsonl 追加 bookkeeping 条目——写入全部落在隔离副本（实测同会话 entries 330→348 增长即此语义），真实 `~/.omo/agent` 会话库零触碰。

会话样本（按 modified 降序取各项目前二）：A=01a16363（P1，225 消息）、B=01a16392（P1，103）、C=01a16180（P2，254）、D=01a15e47（P2，66）。驱动脚本 `switch-driver.py`：8 次真实切换 = 同项目来回（2↔3、6↔7）+ 跨项目（4→5、5→6、7→8）+ 双项目冷启动（1、4），每次 GET messages（无 cursor = 全量首载路径），503 时按前端同款 2.5s 重试（本轮未触发 503）。客户端 curl time_total 与服务端 http 行交叉核对，偏差 <70ms。

**标签勘误（misleading_success_output 防护）**：驱动脚本标签「冷spawn+全量1086」为编写时硬编码笔误（预想选 1086 消息会话）；实际按 modified 降序选中 A=01a16363（225 消息）。以下归因一律以 span 行实测值（entries=330 等）为准，不采信脚本标签。

## 4. 四层归因表（8 次切换实测）

服务端 span 原样行（/tmp/w0-perf-qa/server.log 逐字粘贴）：

```
[perf] op=messages proj=cd6e6588 session=01a16363 ensureMs=2406.7 queueWaitMs=0.1 switchToMs=23052 rpcMs=206.9 entries=330
[perf] http op=messages status=200 ms=25677.5 entries=330
[perf] op=messages proj=cd6e6588 session=01a16392 ensureMs=0.2 queueWaitMs=0 switchToMs=8163.6 rpcMs=63.6 entries=133
[perf] http op=messages status=200 ms=8293.6 entries=133
[perf] op=messages proj=cd6e6588 session=01a16363 ensureMs=0.1 queueWaitMs=0 switchToMs=77.4 rpcMs=249.6 entries=333
[perf] http op=messages status=200 ms=328 entries=333
[perf] op=messages proj=dac28f75 session=01a16180 ensureMs=2266.8 queueWaitMs=0 switchToMs=6410.5 rpcMs=102.9 entries=302
[perf] http op=messages status=200 ms=8783.7 entries=302
[perf] op=messages proj=cd6e6588 session=01a16363 ensureMs=0.1 queueWaitMs=0 switchToMs=0.2 rpcMs=225.8 entries=333
[perf] http op=messages status=200 ms=227 entries=333
[perf] op=messages proj=dac28f75 session=01a15e47 ensureMs=0.1 queueWaitMs=0 switchToMs=4683.7 rpcMs=42.1 entries=101
[perf] http op=messages status=200 ms=4750.4 entries=101
[perf] op=messages proj=dac28f75 session=01a16180 ensureMs=0.1 queueWaitMs=0 switchToMs=10.9 rpcMs=112.3 entries=302
[perf] http op=messages status=200 ms=123.7 entries=302
[perf] op=messages proj=cd6e6588 session=01a16392 ensureMs=0.1 queueWaitMs=0 switchToMs=52.7 rpcMs=96.1 entries=133
[perf] http op=messages status=200 ms=149.5 entries=133
```

| # | 场景 | 客户端ms | http ms | ④ensureMs | ②queueWaitMs | ③switchToMs | ①rpcMs | entries | 层占比 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A(P1) 项目引擎冷spawn后首开 | 25745 | 25677.5 | 2406.7 | 0.1 | **23052.0** | 206.9 | 330 | ③=89.8% ④=9.4% |
| 2 | B(P1) 同项目异会话（引擎暖） | 8323 | 8293.6 | 0.2 | 0 | **8163.6** | 63.6 | 133 | ③=98.4% |
| 3 | A(P1) 同项目回切（+并发usage） | 395 | 328 | 0.1 | 0 | 77.4 | 249.6 | 333 | ①=76.1% ③=23.6% |
| 4 | C(P2) 跨项目冷spawn首开 | 8811 | 8783.7 | 2266.8 | 0 | **6410.5** | 102.9 | 302 | ③=73.0% ④=25.8% |
| 5 | A(P1) 跨项目回切（已开会话） | 285 | 227 | 0.1 | 0 | 0.2 | **225.8** | 333 | ①=99.5% |
| 6 | D(P2) 暖引擎异会话首开 | 4759 | 4750.4 | 0.1 | 0 | **4683.7** | 42.1 | 101 | ③=98.6% |
| 7 | C(P2) 同项目回切（已开会话） | 146 | 123.7 | 0.1 | 0 | 10.9 | **112.3** | 302 | ①=90.8% |
| 8 | B(P1) 跨项目再回（已开会话） | 170 | 149.5 | 0.1 | 0 | 52.7 | 96.1 | 133 | ①=64.3% ③=35.3% |

其余三 op 真实链路抽样（同实例，切 A 后）：

```
[perf] op=usage proj=cd6e6588 session=01a16363 ensureMs=0.2 queueWaitMs=0 switchToMs=57.7 rpcMs=28.8
[perf] op=questionsList proj=cd6e6588 session=01a16363 ensureMs=0.1 queueWaitMs=0 switchToMs=0 rpcMs=5 entries=0
[perf] op=queueList proj=cd6e6588 session=01a16363 ensureMs=0 queueWaitMs=0 switchToMs=0 rpcMs=6.8 entries=0
```

② 竞争形态补测（同项目两会话 messages 并发并发请求，后到者排队）：

```
[perf] op=messages proj=cd6e6588 session=01a16363 ensureMs=0 queueWaitMs=0 switchToMs=0 rpcMs=235.8 entries=348
[perf] op=messages proj=cd6e6588 session=01a16392 ensureMs=0 queueWaitMs=223.2 switchToMs=66.7 rpcMs=85.3 entries=133
```

prompt op 未实测（只读纪律不发 prompt）；其埋点走同一 runTraced 路径，行格式由单测覆盖。

## 5. 归因结论（指导任务 16 取舍）

1. **主瓶颈是 ③ switchTo，且呈双峰**：目标会话在该引擎进程内「首次 open」耗时 4.7s-23.1s（#1/2/4/6，占该次切换 73-98%）；「重开已开会话」仅 0.2-77ms（#3/5/7/8）。首开成本与引擎进程新旧无关（暖引擎 #6 照样 4.7s），是引擎侧 open_session 本身的冷加载（会话索引/上下文重建）。
2. **④ 冷 spawn（ensure 2.3s）真实但次要**；且进程冷启动的大头并不在 ensure 等待里，而被第一次 open_session 吸收（#1 的 23.1s）。「跨项目」本身不慢——跨项目回切已开会话仅 285ms（#5）；慢的是「首次进项目」（spawn）与「首次开该会话」（open_session）的叠乘。
3. **① 全量 rpc 42-250ms 亚秒级、随条目数近线性**（330 条≈207-250ms、302 条≈103-113、133 条≈64-96、101 条≈42），非主瓶颈；但一旦 ③ 被「重开已开会话」坍缩（#5/7），① 即成剩余主体（64-99.5%）——Fix1 服务端直读 jsonl 尾窗恰好整链绕开 ①③④（不 spawn、不进 runExclusive、不 switchTo）。**② 排队**顺序点击恒≈0，并发竞争实测 223ms——单用户顺序场景非瓶颈，回合进行中（SSE 对账/usage 轮询并发）才显现。
4. 前端 503 重试窗本轮未触发：本机 spawn 2.3s 内完成，ensure() 阻塞至就绪而非报 503；慢磁盘/首次拉起更久的场景仍可能触发，埋点 err= 段已可观测。

对任务 16 的取舍含义：优先级 Fix1 尾窗直读（消灭 ①③④ 全链）> switchTo 会话打开状态利用（重开坍缩已存在，open_session 幂等早退 `activeId` 已实证生效，#5=0.2ms）> 跨项目预热（收益=2.3s ensure+首开 6.4s，仅首进项目付费）。

## 6. 关闭侧验证（failure）

同实例配方去掉 `UL_OMO_WEBUI_DEBUG_PERF` 重启（server-envoff.log），执行一次真实切换（`GET /api/sessions/01a16363…/messages` → 200，8.06s，正常返回）：`grep -c '\[perf\]'` = **0**，日志仅 1 行启动横幅。关闭时服务端不建 span 对象、不计时不落日志；两套件全绿（456+720）佐证零行为差异。

## 7. QA 资产与清理回执

| 资产 | 处置 |
| --- | --- |
| QA server（env-on，PID 210976） | SIGTERM 终止，回执 ps 确认退出 |
| QA server（env-off，PID 221957/222198） | SIGTERM 终止，ps 复查 (none) |
| 引擎子进程（QA spawn） | /proc 全量 environ 扫描 `w0-perf-qa` 零残留 |
| 端口 8960 | ss 确认 PORT-FREE |
| /tmp/w0-perf-qa/（agent 副本/data/日志/驱动脚本/cookies） | 保留（证据原始日志），不含常驻进程 |

## 8. 对抗类核对台账

- **misleading_success_output**：报告全部数字取自 server.log 原样行（§4 逐字粘贴）；客户端与 http 行交叉核对偏差 <70ms；驱动标签笔误已勘误（§3），以 span 实测为准。
- **stale_state**：server 套件共 4 轮（基线×2 稳定性 + 改后×2），web 2 轮；最终树以改后 run2（456）与 web 改后 run1（720）为准。
- **flaky_tests**：routes.test.ts a-2（基线 run1 失败/run2 绿），既有不稳定，未修，单列 §1。
- **零行为差异**：关闭路径单测（门控缺省关 + 零输出）+ env-off 实测零行 + 双套件全绿。
