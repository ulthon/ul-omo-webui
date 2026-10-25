# 任务 13：发消息即上浮（乐观更新 + 多时点触发刷新）

worktree: `docs08-batch-w2-t13`（branch `docs08-batch/w2-t13`，基于 main@576b8ac）

## 触发点表（4 时点 → 动作）

| 时点 | 位置 | 动作 |
|---|---|---|
| ① 发送回执 onSent（直发/排队两路都走） | `web/src/components/chat/chat-view.tsx`（Composer onSent 回调） | `floatSessionUp(selectedId ?? sessionId)` 本地乐观上浮；`selectedId` 从 store 现读——直发首条消息 adopt 换 key 后旧闭包 id 落空时兜底 |
| ② 直发乐观入列 appendLocalUserEntry | `web/src/components/composer/composer.tsx`（appendLocalUserEntry 调用后） | 同一 `floatSessionUp(sessionId)`（此刻行仍以当前 id 入键，adopt 在其后才换 key） |
| ③ agent_start 帧 | `web/src/lib/event-dispatch.ts`（wire.type === "agent_start" 分支） | `void sessions.refreshSessions()`（fire-and-forget，失败静默；覆盖排队投递启动与异端发送） |
| ④ followUp 排队投递（queue_update 出队宣布） | `web/src/lib/event-dispatch.ts`（queue_update 分支） | applyUpdate 前取投递前快照对比：旧排队项文本不再出现在引擎全量 `ordered` → `refreshSessions()`（纯入队不触发） |

既有第 5 时点保持不变：回合落定（agent_end/agent_settled/agent_idle）→ refreshSessions（task 19h，原逻辑）。

## 乐观上浮实现（store）

`web/src/stores/sessions.ts` 新增 `floatSessionUp(id)`：
- 定位行 → `modified = now`（ISO）→ 该项目列表按服务端口径重排（`byPinnedThenModified` 镜像：置顶优先 + modified 降序，`Array.sort` 稳定）。
- 置顶行永不下沉（置顶组内仍按 modified 排）；非置顶行浮到非置顶区之首。
- 行不存在（adopt 换 key 竞态窗口 / 未加载项目）→ no-op，刷新时点兜底。
- 不发任何网络请求；服务端排序（`server/src/api/routes-session.ts:196`）零改动。

## 置顶收敛说明

服务端 `byPinnedThenModified` 与客户端镜像比较器逐字对齐（`Number(b.pinned)-Number(a.pinned) || b.modified.localeCompare(a.modified)`）。乐观位置 = 服务端在引擎落盘新 modified 后必然返回的位置（发送必然刷新 modified），因此 refreshSessions 返回真相时序不变、无视觉跳变；未动的其余行保持既有（服务端）相对序（稳定排序）。快速双发 / 发送时刷新在途：第二次 float 幂等（同位置、modified 再前移），最终以 refresh 返回的服务端序收敛，无闪跳循环。

## 测试

`web/tests/buoyant-send.test.tsx`（6 例）：
- (b) floatSessionUp 单元：非置顶浮至 [A(pinned), C, B]、置顶永在顶、未知 id no-op、双发幂等、零网络调用
- (a) composer 直发（真实 createRoot 点击 send-btn，api.prompt 桩 "sent"）：首可见非置顶行 = 发送会话，置顶 A 居首，listSessions 未被调用，本地用户消息同时入列
- (a) 排队回执（"queued"）：经 onSent 上浮，无消息占位
- (c) agent_start 帧 → refreshSessions 调用 1 次
- (d) followUp 出队宣布 → refreshSessions 1 次（纯入队 0 次），排队条同步出列
- (e) 收敛：乐观 [A,C,B] → refresh 返回服务端 [A,C,B]（C modified 最新）→ 序不变、无重复行

运行（见下“验证输出”）。

## 验证输出

新测试单跑（web/tests/buoyant-send.test.tsx，6 例全绿）：

```
$ cd web && npx vitest run tests/buoyant-send.test.tsx
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

全量 web 套件：

```
$ cd web && npx vitest run
 Test Files  106 passed (106)
      Tests  996 passed (996)
```

根构建：

```
$ npm run build   # tsc -b + vite build + server 打包内嵌
✓ built in 5.54s
==> 内嵌资产模块：330 个文件 -> server/src/static-assets.generated.ts
==> 构建完成：server/dist/index.js
```

oxlint：改动文件（sessions.ts / chat-view.tsx / composer.tsx / event-dispatch.ts / buoyant-send.test.tsx）零告警（仓库存量告警不变）。

## 手动 QA（node 级渲染）

脚本 `web/tests/manual-qa-buoyant-send.mjs`（临时，未提交）：happy-dom + createRoot 挂 Composer，数据 A(pinned)/B(old)/C(old)，在 C 直发 → 捕获列表序 `[A, C, B]` 且零 refresh 调用；随后 dispatch agent_start → refreshSessions 被调用。输出粘贴：

```
$ npx vitest run tests/tmp-manual-qa-buoyant.test.tsx --silent=false   # 临时脚本，跑完即删
[manual-qa] send in C → list order: ["A","qa-manual-c","B"] | refreshSessions calls: 0
[manual-qa] after agent_start → refreshSessions calls: 1
[manual-qa] refreshCallLog size: 1
 Test Files  1 passed (1)
      Tests  1 passed (1)
```
