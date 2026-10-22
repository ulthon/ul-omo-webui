# 任务 19：手机档切换器全屏 sheet 重设计（QA 证据）

日期：2026-10-22 ｜ worktree：docs08-r7-wave4-t19（base main@1561ac9，含 t18 变体名注册表）

## 交付内容

- topbar.tsx：手机档（<lg）会话身份区由 DropdownMenu 改为 `SessionSwitcherSheet`
  （Radix Dialog 全屏页，`data-presentation="fullscreen-sheet"`）；触发器两行堆叠
  字大微调（标题 text-sm→text-base、项目名 text-[11px]→text-xs）；桌面分支零改动；
  汉堡抽屉零改动；recentTop 跨项目 8 条派生复用不复制；sheet 内不做搜索/新建。
- 行=标题(text-base 16px font-medium)+项目名副行(text-xs muted)+标签徽标
  （复用 TagBadges 文字形态，任务 20 色格在其内部升级即自动流入，slot 预留）；
  行 min-h-11(44px)；头部 env(safe-area-inset-top) / 尾部 pb-[max(env(safe-area-inset-bottom),8px)]
  （任务 6 viewport-fit=cover 先例）；选完关 sheet；Esc/关闭钮关闭（Radix 承担
  焦点陷阱与 aria-modal）；标签定义两源键集沿侧栏 reloadTagDefs 同构，仅打开时拉取。
- i18n：`login.topbar.switcherSheetTitle`（会话/Sessions）、`login.topbar.switcherSheetClose`
  （关闭会话切换/Close session switcher），zh+en 同步。

## 门禁

| 项 | 结果 |
| --- | --- |
| web vitest | 94 文件 / 887 通过（基线 883，净增 +4；topbar-session-switcher-sheet.test.tsx 新增 4） |
| tsc -b | 通过 |
| oxlint | 7 警告 = 基线（只减不增满足） |
| scan:cn | 0 处（与基线对照通过） |

既有测试迁移：topbar-mobile-recent.test.tsx（任务 15 流量迁至 sheet 形态，断言保持：
排序/截断/跨项目两步切换/同项目仅选中/空态/桌面档不变）；topbar-mobile-add-project.test.tsx
（任务 4 入口迁至 sheet 尾部，AddProjectDialog 真实打开断言保持）。

## Bundle 哈希（QA 实例先根构建再启动，内嵌资产机制已核）

- 伺服（GET /）：`assets/index-BNrqhGSm.js`
- 磁盘 web/dist/assets/：`index-BNrqhGSm.js`（一致）
- 根构建：npm run build（web 5.50s + 内嵌 330 文件 → server/dist/index.js 12.1mb）

## 真实浏览器走查（隔离实例 127.0.0.1:7819，独立 DATA_DIR/CONFIG_DIR/PORT）

Fixture：proj-a（长标题会话 + 带标签「重点」会话）、proj-b（跨项目目标会话），
project 级标签定义（重点/备用）挂在 /tmp/t19-qa/proj-a 的 .ul-omo-webui.json，零共享态污染。

### 手机档 390x844（iPhone-14 档，每次 goto 后重打 emulate）

| 状态 | 截图 | 探针结论 |
| --- | --- | --- |
| 1 顶栏触发器 | t19-mobile-1-topbar-trigger.png | 标题 16px/500、项目名 12px、两行堆叠、aria-haspopup=dialog |
| 2 sheet 全开 | t19-mobile-2-sheet-open.png | fixed 390x844 铺满（非 60vh 贴条）；头部「会话」+关闭钮（aria=关闭会话切换）；行×3 按 modified 降序；行高 53px≥44；标题 16px/500；项目副行 proj-a/proj-b 归属可辨；标签徽标「重点」在行内；长标题行 truncate 无溢出（scrollWidth≤clientWidth）；尾部「添加项目…」；footer padding-bottom 8px（safe-area 兜底）；焦点入 sheet（焦点陷阱生效） |
| 3 跨项目选中 | t19-mobile-3-selected-cross-project.png | 点 proj-a 行：sheet 卸载、项目行 proj-b→proj-a、会话标题同步、模型 chip 随项目偏好刷新 |
| 4 添加项目 | t19-mobile-4-add-project-dialog.png | sheet 尾「添加项目…」→ sheet 关 → AddProjectDialog 打开（取消路径 Escape 收口） |
| （Esc） | — | sheet 开启时 Escape → 卸载（Radix 语义） |

### 桌面档 1920x1080（回归）

- 手机身份区与 sheet 均不渲染（条件渲染 DOM 不存在）
- 项目下拉（proj-b ⌄）：项目/添加项目… 在场，无「最近会话」内容（t19-desktop-1-project-menu.png）
- 模型下拉：provider 分组列表正常（t19-desktop-3-model-menu.png）
- Ctrl+P：model-picker-popover 打开正常（t19-desktop-2-ctrl-p-picker.png）

## 对抗项核对

- stale_state：标签定义仅 sheet 打开时拉取，alive 守卫防关开竞态；两源合并失败静默
  null（徽标整体不渲染，同侧栏防闪烁语义）
- misleading_success：伺服哈希 curl vs 磁盘一致后才走查（内嵌资产陷阱规避）
- boundary：长标题截断（探针 overflow=false）；8 条截断与降序（vitest 断言）；
  空列表空态「暂无会话」（vitest 断言）；超长项目名副行 title 提示 + truncate
- regression：桌面项目下拉/模型下拉/Ctrl+P 全通过；t12 快捷键注册表未动；
  抽屉内容面未动（本次仅 topbar.tsx + i18n + 测试三处）

## 已知限制

- QA 截图中曾出现的「OmO Native configuration diagnostics」toast 为宿主环境预存
  警告（omo.jsonc 弃用块），与本任务无关，已在走查中点掉。
- tag-defs 拉取失败时徽标静默缺席（与侧栏同语义），不 toast——切换主路径不被打扰。
