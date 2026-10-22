# task-20 标签颜色与展示模式 v2 — QA 证据

日期：2026-10-22 ｜ 实例：隔离实例 :7811（UL_OMO_WEBUI_DATA_DIR/CONFIG_DIR/AGENT_DIR 均指 /tmp/t20-*，密码登录）
产物：web/dist/assets/index-D9LZC0pg.js（伺服核验：GET / 引用与磁盘 sha256 一致，bundle sha256 见下）
bundle sha256(index-D9LZC0pg.js)：见 evidence 命令输出（重建后 F3 探针通过）

## Fixture
- 项目 /tmp/t20-proj（已注册），5 会话：A 双标签(蓝色#112233显式+紧急hash)、B 四标签、C 五标签(含 色格控 display:grid 覆盖)、D 单标签(文字控 display:text 覆盖)、E 孤儿(将删除 定义已删 + 紧急)。
- 全局定义：紧急(hash #f97316)、蓝色(显式 #112233)、实验(#14b8a6)、重构(#ef4444)、文字控(display:text)、色格控(display:grid)。

## happy（双档截图）
- d1-text-mode.png：桌面 1920x1080 全局 text 档，文字徽标形态不变（回归），C 行因 色格控 覆盖显色格+计数。
- d2-filter-dots.png：筛选下拉 6 项均文字+色点（显式色与 hash 色并存）。
- d3-manage-dialog.png：管理弹框行前取色 swatch（预填有效色）+「自动」重置（仅显式色可点）+display 三态（Auto/Text/Grid）。
- d4-grid-mode.png + d4b-grid-clip.png：全局 grid 档——2=左右半/4=四象限/5=首色+计数角标/孤儿灰格/D 行整行回退文字。
- d5-settings-tags.png：设置面板「标签」分区二档单选（tags.displayMode，kv 持久化 PUT /api/settings 实证）。
- m1-grid-mode.png：手机 390x844 抽屉行色格五形态齐备。
- m2-toast.png：点孤儿格清理 toast（Stale tags cleaned）；点普通格显名 toast（Tags: 紧急, 蓝色）。
- m3-sheet.png：t19 切换 sheet 徽标升级继承（行高 53px≥44、标题 16px、项目名副行不漂移）。

## failure（API 实证）
- PUT /api/tags color:"red" → 400 {"code":"invalid_tags","message":"条目 color 必须是 #rrggbb 六位十六进制色"}
- display:"dot" → 400 invalid_tags
- v1 tags.json（version:1 旧文件）→ PUT 携 color/display → 落盘 version:2 且字段保留（读后存不丢色）
- GET /api/settings 回读 tags.displayMode=grid（刷新后档位保持）

## 对抗检查
- 多标签>4：C 行首色+计数角标 5（不堆细条）；10 色板 hash 碰撞由计数语义兜底（计划口径 hash%10）。
- 超长标签名：grid 态不显名仅 title 清单；text 态沿旧行 truncate。
- 定义删除（孤儿）：不参与覆盖判定、灰格显形、点格清理实测通过（E 行 2 格→1 格实时收敛）。
- 回归：t19 sheet 几何未动（行高/字号/名副行）；t12 aria（新控件全带 aria-label）；筛选/下拉/管理面永远文字+色点，不受全局档影响。
