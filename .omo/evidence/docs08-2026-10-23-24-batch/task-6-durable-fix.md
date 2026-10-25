# 任务 6：落盘失败回传报错 + cwd 根目录注册校验 + durable 误判修复（t1 根因靶点）

- 日期：2026-10-25
- worktree：`/data/projects/senpi-webui-wt/docs08-batch-w1-t6`（branch docs08-batch/w1-t6，基于 main@bd04691）
- 根因依据：`task-1-root-cause-spike.md`（RpcClient 2026.10.10 × 嵌套引擎 2026.9.28-7：open_session 认领 sessionFile 但从不写盘）

## 变更

1. **durable 判定以磁盘为准**（`server/src/api/engine-runtime.ts` createSession）：list_sessions 行带 durableSessionId 但 `existsSync(sessionPath)` 为假 → `durable=false` + 进别名表 + 登记未落盘认领（`unpersistedClaims`）。修复前该分支无条件 `durable=true`，是 t1「认领成功零落盘」的第一处误判。
2. **resolveSession 消静默**：入口先查 `unpersistedClaims`——命中且文件仍不存在 → 409 `session_not_persisted`（与 exportSessionHtml 既有错误同码，可区分于 404 `session_not_found`）；命中但文件已补写（懒落盘自愈）→ 解除认领按正常会话解析。
3. **prompt 回执落盘复核**：别名会话回合后引擎认领 durable 但文件仍不存在 → 回传 409 `session_not_persisted`（回合确已发出，但结果无法持久化——404 不再是下游第一症状）。该结构化错误穿透吞错的活跃行查询 catch（`if (err instanceof ApiError) throw err`）。
4. **注册表 projectPath 校验**（`server/src/engine/process-manager.ts`）：`isRegistrableProjectPath`（拒绝空串与 `resolve()` 为 `/` 的形态，如 `/`、`//`）；doStart 的 `registry.upsert` 前拦截，拒绝登记并 `console.warn` 一行 `[process-manager] 拒绝登记非法项目路径…`。引擎本身照常运行（登记表仅供 orphan 清扫，脏行只会误导）。对应 10-24 注册表出现 `----`（"/" slug）项目的事故证据。

## 测试（新增）

`server/test/runtime-session-persist.test.ts`（4 例，真实 ProjectRuntime + fake 引擎 RPC）：
- 认领 durable 但文件未落盘 → `durable=false` 进别名，`sessionPath(id)` 报 `{"status":409,"code":"session_not_persisted"}`；
- 认领后文件补写 → resolveSession 自愈（懒落盘不误伤）；
- prompt 回执复核：认领仍无文件 → prompt 回传结构化错误（404 不再是第一症状）；
- 对照：真实落盘 → `durable=true`，解析正常。

`server/test/process-manager.test.ts` 新增 describe（2 例 + test.each 3 形态）：
- `ensureRunning("/")`/`"//"`/`""`：引擎 ready 但注册表零脏行 + 告警行记录（vi.spyOn console.warn）；
- `isRegistrableProjectPath`：`/`、`//`、`""` 拒绝；常规与相对路径放行。

既有 `routes.test.ts` FakeEngineClient.openSession 补上健康 durable 契约（认领即写盘 header）——修复前 harness 只认领不写盘恰是 t1 事故形态，属测试侧缺陷修正，5 例因此恢复绿。

## 手动 QA（node 直跑，404 路径 before/after）

脚本：worktree `.omo/tmp/task6-qa/manual-qa.ts`（esbuild bundle 后 node 执行，mock 引擎认领不写盘）：

```
=== 引擎认领 durable 但会话文件从未写盘（t1 形态）===
[after] createSession = {"id":"01d33333-…","sessionPath":"…/sessions/…_01d33333-….jsonl","durable":false}   ← 修复前 durable 误判 true
[after] sessionPath(认领未落盘 id) 错误 = {"status":409,"code":"session_not_persisted","message":"会话被引擎认领但从未落盘（…jsonl），数据可能未持久化：01d33333-…"}
       （修复前同一调用：404 {code:"session_not_found", message:"会话不存在…"} —— 下游第一症状）
[after] sessionPath(未知 id) 错误 = {"status":404,"code":"session_not_found",…}   ← 普通 404 语义保留
[after] prompt(认领未落盘 id) 结果 = {"status":409,"code":"session_not_persisted","message":"引擎已认领会话 01d33333-… 但会话文件未落盘（…jsonl），回合结果无法持久化"}
```

before 形态由 t1 spike 的隔离复现背书（repro3：prompt "started"、sessions 目录 8s 窗口 + 优雅 stop 后仍为空；resolveSession 三级查找全 miss → 404）。

## 验证

- `server` 全量：`node …/vitest.mjs run` → **44 files / 557 tests passed**（修复前 routes.test.ts 5 例因 durable 语义收紧失败，已按健康契约修正 harness）。
- 类型门禁：`tsc --noEmit -p server` 零错误。
- 根构建：`npm run build` → `构建完成：server/dist/index.js`。

## 对抗类覆盖

- 畸形输入：projectPath `/`、`//`（trailing-slash-root）、`""`、相对路径（放行）均有断言；陈旧别名 id 由 invalidate/ensure 清理路径覆盖（`unpersistedClaims` 随 aliases 一同 clear）。
- 挂起命令：probe 超时沿用 t5 有界 ping/`probe.sleep` 注入面，未新增无界等待。
- 误导性成功输出：手动 QA 逐行粘贴真实输出（见上），未手工转写。
