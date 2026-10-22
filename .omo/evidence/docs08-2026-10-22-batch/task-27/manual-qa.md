# 任务 27 手动 QA：模型「待生效」徽标误报修复（水合+键对齐）

docs08-2026-10-22 批次任务 27。基线 main@1561ac9，worktree docs08-r7-wave4-t27。
最终 bundle：web/dist/assets/index-1Xn4vKuy.js（sha256 前 16 位 757de60c1cb117e7，927330 字节）。

## 环境

- 双隔离实例（真实引擎，glm-5.3 系模型，种子 auth/models 复制自 /root/.omo/agent）：
  - 实例 A（修复前，main@1561ac9 构建）：127.0.0.1:7793，HOME=/tmp/t27-qa-a
  - 实例 B（修复后，本 worktree 构建）：127.0.0.1:7792，HOME=/tmp/t27-qa-b
- 浏览器：chrome-headless-shell 1243（--no-sandbox），CDP Emulation 移动档 390x844 dsf2 / 桌面 1920x1080。
- UI 语言：实例 A 截图为英文（无 locale 种子的浏览器默认），文案即 composer.chips.pendingEffect（zh：「已选，待可发送时生效」）。

## 重拍说明（验证审查返工，仅证据层）

首轮三张 390 档截图（BEFORE 误报 / 刷新无徽标 / 真待生效）的徽标锚点（textarea 右上 CapsuleModelTag，-top-2.5 right-2）被任务右栏面板遮挡，amber 像素零命中，不满足计划「截图前后对比」要求。代码未变，重拍：拍摄前以 DOM 遍历关闭会话抽屉与任务面板（Close session drawer / Collapse todo panel），并以 elementFromPoint 在徽标中心点客观验证命中徽标 span 本体（非遮挡元素）后才截图；每张附 canvas 像素自检（amber 判定：r>180 ∧ 110<g<200 ∧ b<110 ∧ r−b>90）：

| 截图 | 尺寸 | amber 像素 | 锚点可见性 |
| --- | --- | --- | --- |
| a-prefix-false-badge-390.png | 780x1688 | 2105（非零命中） | elementFromPoint=徽标 span 本体 |
| b-postfix-refresh-no-badge-390.png | 780x1688 | 0（预期：无徽标） | tag 本体入画（elementFromPoint 命中 tag） |
| b-postfix-genuine-pending-390.png | 780x1688 | 2105（非零命中） | elementFromPoint=徽标 span 本体 |

无徽标图的构图无遮挡由同构图的真待生效图 amber 非零命中反证（同一锚点同一位置）。B 场景重拍时会话内容为引擎 onboarding 回合（API 建会话自动启动）；其 jsonl 含 model_change 条目（glm-5.3，grep 实证），刷新后徽标不挂的判定链即水合路径：setEntries 水合 applied → 挂载对齐 selected → 判定 false；与实例 A 同 DOM 条件（运行回合+选中文本）下修复前 badge=true 形成前后对照。

## 场景与结论

| # | 场景 | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 误报复现（修复前 A）：全新会话首回合经 API 直发（不带 model，即他端/排队发起语义），回合运行中浏览器全新打开会话 | 修复前挂黄标（误报） | badge=true「Selected, applies on next direct send」，实无任何待生效（选中=会话生效=glm-4.6v） | a-prefix-false-badge-390.png（重拍，amber 2105） |
| 2 | 水合修复（修复后 B）：jsonl 含 model_change 条目，运行中刷新页面 | 无黄标（水合落库+基线对齐） | badge=false，tag=glm-5.3 且入画；同场景在 A 挂标 | b-postfix-refresh-no-badge-390.png（重拍） |
| 3 | 真待生效（修复后 B）：流式期经胶囊弹层改选 glm-5.3-4k（变体 id） | 黄标出现（真语义保留） | badge=true，tag=glm-5.3-4k+黄标 | b-postfix-genuine-pending-390.png（重拍，amber 2105） |
| 4 | 回执收敛（修复后 B）：中止后直发（携带新选 4k），新回合流式期 | 黄标随 applied 追平消失 | badge=false，tag=glm-5.3-4k | b-postfix-cleared-after-receipt-390.png |
| 5 | 桌面回归（修复后 B，1920x1080） | ModelChip 正常、无胶囊徽标挂载点 | model-chip=true、capsule-model-tag=false、badge=false | b-postfix-desktop-1920.png |
| 6 | 同值切换边界（修复后 B 桌面）：重选当前已选模型 | 无徽标（不产生伪待生效） | 选择后 badge=false（chips selectModel 同值早退） | manual（DOM 断言） |

补充说明（场景 1 首次尝试的记录）：在 A 实例「UI 直发后立即刷新」未复现误报——SSE 重放窗口（EventBus capacity 1000）尚存直发产生的 model_changed 帧，重放路径把 applied 写回（修复前即有的既有收敛通道）。改用「无 model 直发的新会话」（docs/08 第 17 条实录同型：他端/连续排队发起的回合无回执无回显）后确定性复现。

## 任务 27d 键空间核实（引擎 bundle 实证）

node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/bundle/chunks/session-worker.js：

```
sessionManager.appendModelChange(model.provider, model.id, ...)
this._emit({type:"model_changed", model, thinkingLevel:..., source:...})
```

model_changed 帧的 model 与 jsonl model_change 条目同一 model 对象 → 帧报变体名（glm-5.3-4k 形态），与选中 "provider/变体id"、prompt 回执 appliedModel（服务端 `${row.provider}/${row.id}`）同键空间。计划 (d) 的「若帧报上游名，比对经 upstreamId 归一」条件分支不触发，比对为直接字符串相等；实测 QA 场景 3 的变体改选（4k）行为一致。记忆笔记中「引擎 model_changed 上报 upstream 名」的怀疑不成立（那是 assistant 消息 message.model 的显示层问题，任务 18 已修）。

## 门禁

- web vitest：894 passed（基线 883，净增 11：新增 model-badge.test.tsx 10 例 + model-pending-badge.test.tsx 挂载对齐 1 例；既有 2 例保守语义断言按任务 27b 新语义更新，无删除无跳过）——重拍返工后重跑确认不降
- tsc -b 干净；oxlint 变更文件 0 warning 0 error；npm run scan:cn = 0
- lockfile 无入提交变动（npm install 的版本号抖动已还原）
