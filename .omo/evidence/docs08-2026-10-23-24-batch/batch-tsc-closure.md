# batch tsc closure — docs08-2026-10-23-24-batch

Worktree: `docs08-batch-w4-tscfix`（branch `docs08-batch/w4-tscfix`，base main@dfc7186）
日期：2026-10-25。仅类型修复，零行为变更。

## 13 个错误与修复

| # | 位置 | 错误 | 修复（一行） |
|---|------|------|------|
| 1 | src/api/background-tasks.ts:48 | TS2339 `task_id` on `never` | `found` 经闭包赋值被 CFA 窄化为 never；取出前显式断言 `const hit = found as Record<string, unknown> \| null` 再读 |
| 2 | src/db/meta.ts:288 | TS2304 `TagMountAuditInput` 未定义 | 补定义接口 `TagMountAuditInput { sessionId, scope, name, source }`（与既有实现 758 行写入形状一致） |
| 3 | src/db/meta.ts:289 | TS2304 `TagMountAudit` 未定义 | 补定义接口 `TagMountAudit { id, sessionId, scope, name, source, createdAt }`（与 775 行读出映射形状一致） |
| 4 | test/background-state.test.ts:89 | TS2420 FakeGateway 缺 `commandsList` | FakeGateway 补 stub `async commandsList(): Promise<null> { return null; }`（本测试不触达命令面） |
| 5-8,11 | test/background-state.test.ts:169/182/194/199/211 | TS2345 同上（各调用点） | 由 #4 一并消除 |
| 9-10 | test/background-state.test.ts:206/207 | TS2345 `string \| undefined` | 新版 @types/node 中 `mkdirSync(recursive)` 返回 `string \| undefined`；`mkdirSync(...) as string` 消除 |
| 12-13 | test/background-state.test.ts:212/215 | TS2345 同上（Map/summary 传入） | 由 #9 一并消除 |

未发现真实 bug：全部为纯类型问题（缺接口定义、CFA 窄化、@types/node 签名变化、测试桩缺方法）。

## 验证

- `cd server && npx tsc --noEmit`：
  - before: 13 errors（tail 见 `/tmp/tsc-before.txt`，摘要：background-tasks.ts 1 / meta.ts 2 / background-state.test.ts 10）
  - after: `TSC_EXIT:0`，0 errors
- `cd server && npx vitest run`: 46 files / 593 tests 全过（当前 worktree 计数；测试逻辑零改动）
- `cd web && npx tsc -b --noEmit`: exit 0（无批量遗留错误）
- root `npm run build`: exit 0（server/dist/index.js 构建完成）

## 提交

单原子提交（中文、无署名尾注）：`修复 docs08 批次遗留的 13 个 TypeScript 类型错误`
