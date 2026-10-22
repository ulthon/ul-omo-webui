# 任务 10：会话列表排版第三轮（字号维度）— 双档实测对照表

- 实例：隔离 QA 实例（UL_OMO_WEBUI_PORT=7791，DATA_DIR/AGENT_DIR/META_DB 独立于生产 7788），fixture 项目 `/tmp/webui-qa-t10/proj`，6 条会话覆盖：中文标题（置顶）、超长英文标题（truncate）、fork 子会话（fork 徽标 + (fork #1) 后缀）、空标题回退「(no messages)」、短标题、跨年时间；全局标签「基建」挂超长标题行。
- 测量方式：真实 Chrome（headless，/usr/bin/google-chrome 153）+ CDP Runtime.evaluate（getBoundingClientRect / getComputedStyle 实测值直接取回），双视口 1920x1080（desktop）与 390x844（mobile，DPR 2）。UI 语言 zh-CN。
- BEFORE = 基线 main@4c114c0 构建（伺服哈希 index-Dicc36eT.js 与磁盘核对一致）；AFTER = 本分支构建（伺服哈希 index-pmuw1uiC.js 与磁盘核对一致，sha256 见文末）。
- 截图：before-1920.png / before-390.png / after-1920.png / after-390.png / after-390-menu-open.png（触控回归留证）。
- OC 参照（docs/08-产品待办.md:412 oc-scan 带状实测）：手机列表项字高约 15-16px、桌面字高约 13-14px、桌面 pitch 约 30px、手机 pitch 约 36px。

## 逐项实测（px，getBoundingClientRect / getComputedStyle 原值）

### 桌面 1920x1080

| 指标 | BEFORE | AFTER | 合同值 | 结论 |
| --- | --- | --- | --- | --- |
| 行高 rect.height | 36 | **32** | 32（±1 微调限差） | 恰中，无需微调 |
| 标题 font-size / line-height | 14 / 20 | **15 / 20** | 15px | 达标 |
| 标题 span rect.height | 20 | 20 | 行高构成 = 20 + 2×6(padding) | 32 = 20+12 |
| 时间 font-size | 11 | **12** | 12 | 达标 |
| 徽标（fork/项目名/归档/未读）font-size | 10 | **11** | 11 | 达标 |
| 标签徽标（tag-badge.tsx）font-size | 10 | 10 | 任务 20 领地（W5，Blocked by 10） | 刻意不动 |
| 菜单钮（lg:absolute 不占行高） | 32x32 | 32x32 | ≥32 不降 | 不变 |

### 手机 390x844

| 指标 | BEFORE | AFTER | 合同值 | 结论 |
| --- | --- | --- | --- | --- |
| 行高 rect.height | 40 | **36** | 36（±1 微调限差） | 恰中，无需微调 |
| 标题 font-size / line-height | 14 / 20 | **16 / 24** | 16px | 达标 |
| 标题 span rect.height | 20 | 24 | 行高构成 = max(子件 32px, 文字 24px) + 2×2 | 36 = 32+4 |
| 时间 font-size | 11 | **12** | 12 | 达标 |
| 徽标 font-size | 10 | **11** | 11 | 达标 |
| 菜单钮（行内子件） | 32x32 | 32x32 | ≥32 不降 | 不变 |
| 展开钮（行内子件） | 28x28 | 28x28 | 不小于现状 | 不变 |
| 整行触控带（行高×全宽） | 40x381 | 36x381 | ≥36 | 达标 |

±1px 微调：未动用（全部恰好命中合同值）。
过压缩检查：桌面 32 ≥ 文字 20+4；手机 36 ≥ 文字 24+4；行高不低于文字+4px 合规。

## 边界与回归（390 档实测）

- 横向溢出：document.scrollWidth = 390 = innerWidth，无横向溢出。
- 超长标题（171 字符英文长题）：truncate 生效（span scrollWidth 587 > clientWidth 211），行宽 381 不溢出；桌面档同 fixture 截图核对无溢出。
- 空标题：回退「(no messages)」正常渲染（服务端 firstMessage 空回退），行结构完整。
- 点行选中回归：点项目区「短标题会话」行 → 行获选中态（bg-primary/10 + 左缘 2px 竖条，见 after-390-menu-open.png 两区块同会话选中态一致）+ 抽屉自动收起（aside left=-390 移出屏）。
- 菜单钮回归：32x32 钮点开下拉菜单 9 项全出（取消置顶/重命名/生成标题/归档/复制会话 ID/复制标题/导出 HTML/标签/删除，见 after-390-menu-open.png）。
- C18 语义：选中竖条、未读 pill、fork 徽标位置均未动（类级锁定测试 + 截图双重核对）。

## 测试

- `cd web && npx vitest run`：Test Files 76 passed (76)，Tests **721 passed (721)**（基线 720，净增 1：新增「第三轮字号行距合同」锁定测试）。
- `npx tsc -b`：退出码 0。
- `npx oxlint src/components/session-list/session-item.tsx tests/session-item-compact.test.tsx`：0 warnings 0 errors。
- 既有密度断言同步：session-item-compact.test.tsx「桌面共享槽位」用例行高断言 lg:py-2 → lg:py-1.5。

## 范围注记

- 标签徽标（tag-badge.tsx）保持 10px：属任务 20（标签颜色与展示模式 v2，Wave 5，Blocked by: 10）领地，本任务不越文件改它；任务 20 落地时按其重设计自行定字号。
- 交互零改动：仅类名与注释变化，无逻辑 diff。

## 产物哈希

- AFTER 伺服 bundle：index-pmuw1uiC.js（GET / 引用与磁盘 web/dist/assets 核对一致）
- sha256(index-pmuw1uiC.js) = 32f0ce539a91e3ed3ccbe4e2e5af364a9525660ce7ed764cdda4d35d4a8bed33
- BEFORE 伺服 bundle：index-Dicc36eT.js（同法核验一致）

## QA 资产登记与清理回执

- 隔离实例：pid 313906（端口 7791）→ 走查完成后 kill。
- headless Chrome：pid 293470（CDP 9333）→ 走查完成后 kill。
- fixture：/tmp/webui-qa-t10/（agent 目录 6 会话 + data 目录 meta 库 + 驱动脚本）→ 证据落盘后删除。
- 生产实例（7788，systemd ul-omo-webui）全程未触碰。
