# 任务 5：引擎健康守卫——换引擎前 RPC ping，健康不重拉

- 日期：2026-10-25；worktree `docs08-batch-w1-t5`（branch `docs08-batch/w1-t5`，基于 main@98242cc）
- 变更：`server/src/engine/process-manager.ts`（+ 其测试与共享 mock），未触碰 engine 包

## 实现

- `ensureRunning()` 的 `ready` 分支不再无条件返回：先对现有引擎做**短有界** RPC ping
  （复用既有 `protocolPing`（get_protocol_info），新增 `pingBounded` 超时臂走
  `probe.sleep`，默认 `healthPingTimeoutMs=3000`，可配置）。
- ping 健康（且 pid 仍存活）→ 直接复用快照返回：不 spawn、不触碰注册表。
- ping 失败/超时，或 pid 已死/记录垃圾（`probe.alive` false，含陈旧注册行形态）→
  记 `lastError`、`discardClient`（杀仍存活的挂死进程 + 清注册表行）、发
  `process_crashed` 事件、`scheduleRestart`（失败计数/退避语义与真实崩溃一致），
  随后落入既有 `doStart` 立即重拉并 upsert 新注册行。
- 语义说明：`ensureRunning` 是唯一 spawn 决策口（createSession/prompt 经
  engine-runtime `ensure()`、restartProject 均汇于此），守卫放在此处即覆盖全部
  「换引擎前」路径；每次进入 ready 引擎的调用多一次本地子进程单往返
  （get_protocol_info，亚毫秒级），换取挂死引擎快速自愈（10-24 级联的同族防线）。
  无需改 engine-runtime.ts `ensure()`——守卫全落在管理器内。

## 三分支新增单测（server/test/process-manager.test.ts 新 describe，mock 面在既有 clientFactory/probe 注入缝）

分支 1（健康 → 复用）：
```
✓ 健康守卫（任务 5：换引擎前 ping，健康不重拉） > 分支 1：现有引擎 ping 健康 → 复用，不重 spawn，注册表行不变 6ms
```
断言：spawn 次数仍 1、pid 不变、注册表只含原 pid、无 process_crashed 事件。

分支 2（ping 失败 → 重拉）：
```
✓ ... 分支 2：ping 失败（RPC 拒绝）→ 重拉，注册表更新为新 pid 8ms
✓ ... 分支 2b：pid 已死（恶意/陈旧记录）→ 不复用，直接重拉 5ms
```
断言：spawn 次数 2、新 pid 落注册表且旧 pid 行被清、process_crashed 事件带旧 pid；
2b 覆盖 malformed-input（pid 摘除后即使 send 健康也不复用）。

分支 3（ping 超时 → 按失败重拉，`healthPingTimeoutMs=50` 有界）：
```
✓ ... 分支 3：ping 超时（send 挂死不落定）→ 按失败处理重拉 56ms
```
断言：挂死 send 在 50ms 内被判死、重拉新引擎、旧 pid 进程被清理。

## 套件与门禁（实际输出）

```
$ cd server && npx vitest run test/process-manager.test.ts
 Test Files  1 passed (1)
      Tests  28 passed (28)        # 24 既有 + 4 新增

$ cd server && npm test            # 全量 server 套件
 Test Files  43 passed (43)
      Tests  549 passed (549)

$ npm run build                    # 根构建门禁
✓ built in 30.14s ... ⚡ Done in 972ms  构建完成：server/dist/index.js
```

## 手动 QA（真实面：manager + mock 引擎端到端，node 直跑）

`tmp-t5/manual-qa.mjs`（worktree 临时目录，esbuild 打包 manager 别名桩替换 senpi，
clientFactory 注入 fake 引擎），输出：

```
=== 分支 1 健康 → 复用 ===
  spawn 次数=1（期望 1，不重拉）
  pid 保持=true（9001）
  状态=ready（期望 ready）
  旧 client 未被 stop=true

=== 分支 2 ping 失败 → 重拉 ===
  spawn 次数=2（期望 2）
  新 pid=9003（旧 9002，更换=true）
  状态=ready（期望 ready）
  旧进程已不在进程表=true

=== 分支 3 ping 超时 → 重拉 ===
  spawn 次数=2（期望 2）
  新 pid=9005（旧 9004，更换=true）
  状态=ready（期望 ready）
  守卫耗时=303ms（有界，远小于无限挂死）
  旧进程已不在进程表=true（client.stop 生效，SIGKILL 仅为残留兑底）

MANUAL-QA DONE
```

## 风险与边界

- 每次 API 操作多一次 get_protocol_info 往返（本地 stdio 子进程，开销可忽略）；
  若未来证明敏感，可在守卫加节流（如 N 秒内 ping 过即免），本任务未做（最小改动）。
- 注册表行孤立存在（无内存记录、pid 活着）但 manager 无 client 时无法 ping
  （stdio 连接不可重附着），该形态仍走正常 spawn；孤儿清扫（reapOrphans）负责兜底。
- 未推送；单 commit；临时产物在 `tmp-t5/`（不入库）。
