# 任务 7 证据：新引擎就绪试写门禁（可开关）

计划：docs08-2026-10-23-24-batch 任务 7（GAP-1，Blocked by 6）。
分支：docs08-batch/w1-t7（基 main@ec3bfd2，含 t5 健康守卫 + t6 durable 修复）。

## 1. 开关语义表

开关来源：构造项 `probeGate`（显式）> 环境变量 `SENPI_ENGINE_PROBE_GATE` > 默认。
解析函数 `parseProbeGateEnv`（process-manager.ts，导出可单测）。

| 值 | 行为 |
|---|---|
| 未设置 / 空串 | 门禁**开**（计划书任务 7 默认：默认开启但必须可一键关闭） |
| `1` / `true` / `on`（大小写不敏感，容忍首尾空白） | 门禁开 |
| `0` / `false` / `off` | 门禁**关**：握手（waitUntilReady）通过后直接标 ready，与 main 现行为一致，不发探针 |
| 其它任意值（如 `banana`） | 按默认（开）处理 + `console.warn` 告警一次（同一非法值只告警一次，防刷屏） |

- **门禁开** = spawn 握手通过后，向引擎发一次性探针会话（`open_session`，探针 id 前缀 `__probe__`），严格校验响应并等探针文件真实落盘（磁盘为准，同 t6 判定族），通过才标 ready / 承接流量。
- **门禁关** = 现行为（t5 守卫后直接 ready），零探针发出（测试断言 `probeOpened` 为空）。

## 2. 摆放位置与 t5/t6 交互

- 位置：`doStart` 内 `waitUntilReady` 成功之后、`transition(ready)`/supervisor/warmup 之前（计划书「守卫顺序约定：健康检查→落盘回传→cwd 校验→试写门禁最后上」）。注册表 upsert 仍在其原位（cwd 校验点），失败路径 `discardClient` 会清掉该行，退避重拉语义与 t5 崩溃路径一致。
- t5 交互：探针失败 → `emit(process_crashed)` + 抛错进 `doStart` catch → `lastError` 置 `[probe_gate_failed] ...` + `discardClient`（杀进程/清注册表行）+ `scheduleRestart`（指数退避、连续失败达上限 unavailable），与 t5 健康守卫杀引擎完全同一套语义。
- t6 交互（409/claims 防污染）：探针全链在 process-manager 层闭环，**不经过 EngineRuntimeRegistry**，因此天然不进 `unpersistedClaims`/别名表；探针会话 id `__probe__<ts>-<rand>` 一次性，finally 双向即焚（引擎侧 `close_session` + 本地探针文件 `rmSync`，成功/失败两向都清）。门禁错误码 `probe_gate_failed` 与 t6 `session_not_persisted` 同族（lastError 机器可读前缀，供上层映射结构化错误）。
- 响应严格校验（malformed-input / misleading_success_output 类）：`success===true` 且 `data.state.sessionId` 为非空字符串，且 `state.sessionFile` 必须恰为本探针路径（引擎拿其它会话文件充数 → 拒绝）。垃圾/HTML/非 JSON 形态 → 一律 fail，不挂死。
- 有界性（hung_commands 类）：open_session 与落盘等待均受 `probeWriteTimeoutMs`（默认 5s，可配）上界；超时臂走 `probe.sleep`（测试可注入，同 t5 pingBounded 模式）。

## 3. 探针 id 生命周期证明

生成：`__probe__<now36>-<rand6>`；目录 `<agentDir>/sessions/--<proj-slug>--/`（与 adapter `encodeCwdToSessionDirName` 同算法，engine 层就地复制不反向依赖 api）。
消亡（成功与失败两向，单测 + QA 双重验证）：
- 引擎侧：`close_session` 后 fake `probeSessionsOpen` 为空（测试 (a)、(b) 断言；QA-A `probeSessionsOpen=0 closeCalls=1`）。
- 本地：探针 JSONL `rmSync`，sessions 目录残留 `[]`（测试 (a)、(b) 与 QA-A/B `residue=[]`）。
- 注册表：只登记引擎 pid 本行，无探针痕迹。

## 4. 测试证据

新增（server/test/process-manager.test.ts，describe「就绪试写门禁」7 用例）：
- (a) 门禁开+探针成功 → ready、单 spawn、即焚无残留、注册表零污染；
- (b) 门禁开+认领不落盘 → 不 ready、backoff、`probe_gate_failed`、process_crashed、重拉后健康引擎 ready、失败向无残留；
- (b 变体×3) 垃圾响应 / open 挂死（300ms 有界）/ 认领其它路径 → 均 `probe_gate_failed` 不 ready；
- (c) 门禁关 → 认领不落盘的引擎照常 ready、探针零发出；
- (d) `parseProbeGateEnv` 全值域 + 非法值告警一次；构造缺省走 env（`SENPI_ENGINE_PROBE_GATE=0` 旁路生效）。

存量回归策略：vitest `setupFiles`（server/test/setup.ts）把 env 置 `0`，存量 45 个测试文件与 main 行为逐位一致（574/574 通过，无删改任何既有断言）。mock 面扩展（FakeRpcClient）默认以健康引擎姿态处理探针，不改变既有 `probeAttempts` 语义。

命令与计数：
- `./node_modules/.bin/vitest run --root server test/process-manager.test.ts` → 1 file / **40 passed**
- `./node_modules/.bin/vitest run --root server` → 45 files / **574 passed**
- `npm run build`（根）→ EXIT=0（web + server dist 构建完成）

## 5. 手工 QA（node 级，bun 直跑 /tmp/t7-qa/run-gate-qa.ts）

```
[A-健康引擎-探针通过] state=ready spawns=1 probeIssued=1 probeSessionsOpen=0 closeCalls=1
[A-健康引擎-探针通过] residue=[] crashedEvents=0
[B-探针挂死引擎-门禁拦截] firstEnsure state=backoff lastError=[probe_gate_failed] 就绪门禁：试写探针未通过（open_session 未落盘/响应畸形/超时，projectPath="/tmp/t7-qa/proj"） settledMs=526 bounded=true
[B-探针挂死引擎-门禁拦截] process_crashed=true restartScheduled=true residue=[]
[B-探针挂死引擎-门禁拦截] afterBackoff spawns=3 state=unavailable clientReady=false
[B-探针挂死引擎-门禁拦截] unavailable=true
```

B 向：挂死引擎 526ms 有界判死（500ms 上界 + 收尾），连续失败 3 次进 unavailable 停止自动重启（不死循环），全程无 client 放出。

## 6. 风险与边界

- 生产引擎若要求 open_session 必带 provider/model 才落盘：探针在管理器未配 defaultProvider/defaultModel 时按裸 open 发出，可能误拦——已留一键逃生口（`SENPI_ENGINE_PROBE_GATE=0`）；管理器配置了成对 default 时探针随带。
- 探针在真实引擎上的落盘时机（open 即写 vs 首回合才写）未对真实引擎实测（本任务验证面为 mock 引擎 + 协议面严格校验）；若实测发现健康引擎 open 不写盘，走开关关闭并回炉探针形态。
