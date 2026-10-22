# 任务 2 QA 记录：loop-guard 三型具名渲染与连排聚合

日期：2026-10-22 | 分支：docs08-r7/wave1-t2 | 基线：main@fe32379

## QA 实例

- 隔离实例：`UL_OMO_WEBUI_PORT=7802`，`UL_OMO_WEBUI_DATA_DIR=/tmp/loopguard-qa-t2/data`，`UL_OMO_WEBUI_AGENT_DIR=/tmp/loopguard-qa-t2/agent`，密码走 env（进程已注册后台会话，QA 后 tree-kill 回收）。
- fixture 会话：`<agent>/sessions/--tmp-loopguard-qa-t2-project--/2026-10-22T14-00-00-000Z_fixture0001.jsonl`（13 行：session 头 + user + loop-guard:notice×4 连排 + escalation×1 + recovery×1 + assistant 隔断 + 单条 notice + display:false×2 + user 尾帧），项目经 POST /api/projects 注册。
- 引擎 slug 实证：`--${cwd 去首斜杠、[/\\:]→-}--`（senpi-adapter encodeCwdToSessionDirName 与引擎 getDefaultSessionDirPath 同构，目录名尾缀双横线不可省）。

## bundle 哈希（陈旧产物防线）

- 根构建 `npm run build` 重生成内嵌资产后启动实例。
- 伺服核验：`GET /` 引用 `assets/index-CiP1u8Zf.js`，伺服 sha256 = `4845f6e287544a5253a8cf1e6163f6b82661f00fe625fd0a6360cfd6cd9e5579`，与磁盘 `web/dist/assets/index-CiP1u8Zf.js` 一致（css `index-CK9XlPF7.css` = `ce18fa1a…`）。
- 全量清单：`/tmp/loopguard-qa-t2/built-dist-sha256.txt`（316 文件，QA 后随临时目录清理）。

## 浏览器断言（omowright 无头 chromium --no-sandbox，真实 DOM 读取）

| 断言 | 结果 |
| --- | --- |
| 块数=4：notice×4 聚合 / escalation×1 / recovery×1 / 单条 notice×1 | 通过 |
| 聚合行 zh 标签「循环防护提醒」+「×4」角标 | 通过 |
| 聚合展开逐条全文（loop-guard-item=4，max-h-48 滚动容器） | 通过 |
| 单条 notice 无 ×N 角标（全文无 ×1） | 通过 |
| escalation 块 border-destructive/40（error 色） | 通过 |
| recovery 块 border-emerald-500/40（success 色） | 通过 |
| display:false 条目零渲染（environment_context 无泄露） | 通过 |
| 未知 customType 兜底占位行不受影响（单测覆盖） | 通过 |
| 移动档真实视口 innerWidth×innerHeight = 390×844（iphone-14 档） | 通过 |
| 桌面 1920×1080 同断言全绿 | 通过 |

## 截图

- desktop-1920-collapsed.png / desktop-1920-expanded.png（1920×1080）
- mobile-390-collapsed.png / mobile-390-expanded.png（390×844，iphone-14 设备档）

## 引擎渲染器契约（DoneClaim 引用）

来源 `node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/bundle/chunks/session-worker.js` 内联的
`packages/coding-agent/dist/core/extensions/builtin/loop-guard/renderer.js`：

- `noticeMessageRenderer(map)`：message→spec|undefined，spec={title, tone?, why, expandedLine?}；
  spec===undefined 即整条不渲染。
- `buildNoticeBox(spec, options, theme)` 三行结构：title（粗体，spec.tone??"accent" 着色）→
  why（dim 常显）→ expandedLine（仅 `options.expanded` 时追加，dim）。
- `renderLoopGuardNotice`：details(kind/toolName/count/similarity/period) →
  title=「⚠ Loop guard · identical calls ×N (tool)」三变体；why=说明句；expandedLine=细节行。
- `renderLoopGuardEscalation`：title=「! Loop guard · turn interrupted (tool)」，**tone:"error"**，
  expandedLine=「A user-role recovery message was queued…」。
- 注册表仅 notice/escalation 两渲染器（`registerMessageRenderer`）；recovery 经 sendMessage
  display:false 注入（web 侧按既有口径 display:false 一律不渲染）。
- webui 对齐映射：title=「循环防护提醒」+×N 角标（N>1），why=content 首个信息行
  （`<system-reminder>` 包裹标签行不作摘要），expanded=逐条全文——与 buildNoticeBox 三行同构。

## 聚合语义（纯函数，message-items.ts buildMessageItems 单遍内联）

- 分类门：customType 精确三型 → loopGuardGroup；未知 loop-guard:* 后缀禁猜回落 customMessage 占位行。
- 连排=渲染流相邻：toolResult 等不入列的不可见条目不产生可见行、不阻断聚合；任何产生可见行的条目打断；kind 边界重置。
- display:false 一律不入列不入组（引擎明示不展示，聚合组不得绕过）。
- 真实库形态备注：实录 23 条 notice 与工具流交错（非直接相邻），各自具名渲染不聚合；契约 fixture 的直接相邻连排形态聚合为一条 ×N。

## 测试与门禁

- web vitest：738/738 全绿（基线 721，净增 17；新增 tests/loop-guard-aggregate.test.tsx 17 测试：纯函数 10 + 渲染分支 7；empty-bubble-resolve.test.tsx 既有占位行 fixture 迁移改写非删除）。
- oxlint：变更 7 文件 0 error、1 warning（message-list.tsx useVirtualizer 既有警告，非本次引入）。
- `tsc -b`：干净（exit 0）。
