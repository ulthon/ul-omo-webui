# task-8 表格悬停复制/下载 — 浏览器 QA 证据(2026-10-22,TSV 修复轮)

> 契约以计划原文为准(L193/L197/L199):复制表格(TSV 到剪贴板)+ 下载 CSV(Blob);
> TSV 列对齐;CSV 行列一致;移动端常显小钮可触发;桌面悬停;aria-label。
> 本轮取代首版行级管道行复制(派发口径错误,已按计划修正)。

## 构建与防 stale

- 隔离实例:worktree docs08-r7-wave1-t8 根构建(`npm run build`,内嵌资产),`node server/dist/index.js`
  端口 7808,DATA_DIR=/tmp/t8-qa-data,AGENT_DIR=/tmp/t8-qa-agent(QA 后已清)。
- bundle(修复轮):web/dist/assets/index-BAbhVpuQ.js,sha256 前 16 = d041f2bd82668b15;
  `curl -s :7808/ | grep assets` 实测伺服 index-BAbhVpuQ.js,与磁盘一致(无内嵌旧产物)。
- fixture 会话:jsonl 直写 agentDir/sessions/--tmp-t8-proj--/(尾缀双横线惯例),
  含逗号+引号+CJK 单元格、仅表头表、单格表、12 列长值宽表。

## 判定结果(21/21 通过,exit 0)

| # | 判定 | 证据 |
| --- | --- | --- |
| 1 | 桌面 1920:fixture 渲染 4 张表 | count=4 |
| 2 | 主表 3 行(1 表头+2 数据) | rows=3 |
| 3 | 每行(含表头)都有操作单元格;表头 th/数据 td | TH/TD |
| 4 | 双钮 aria-label(复制表格/下载 CSV)与 title 齐备 | 见 01 截图 |
| 5 | 桌面未悬停操作钮隐藏 | computed opacity=0 |
| 6 | 桌面悬停行后显钮 | opacity=1,01-desktop-hover.png |
| 7 | 复制表格=全表 TSV(逐格+制表符逐字节比对) | navigator.clipboard.readText() = `名称\t数值\t备注\n甲\t1\t普通\n乙,丙\t2\t含"引号"`(CDP Browser.grantPermissions 授权后真读) |
| 8 | TSV 列对齐(每行制表符分段数一致) | [3,3,3] |
| 9 | 复制 toast | [role=status] = 已复制表格 |
| 10 | 下载落盘文件名 table.csv | CDP Browser.setDownloadBehavior(allow, /tmp/t8-dl) 真实下载事件 |
| 11 | CSV=BOM+RFC4180,不回归 | `\uFEFF名称,数值,备注\n甲,1,普通\n"乙,丙",2,"含""引号"""` |
| 12 | 仅表头表渲染不崩且有下载钮 | rows=1, btn=true |
| 13 | 仅表头表 CSV=单行表头 | `\uFEFF只有列` |
| 14 | 单格表复制表格=该表 TSV | clipboard = `单格\n唯一` |
| 15 | 宽表=block+overflow-x:auto 且操作格在行内 | display/overflowX/cellInRow 全中 |
| 16 | 宽表末行悬停显钮且格不出视口 | inViewport=true |
| 17 | 手机 390 视口 | innerWidth=390(iphone-14 档) |
| 18 | 手机所有行操作钮无悬停常显 | 每行 opacity=1 且占位 w=50,02-mobile-always-visible.png |
| 19 | 手机点按复制表格可触发 | clipboard = 全表 TSV(同 #7) |
| 20 | 手机宽表真溢出(943>364)block 横滚、操作格在行内 | 05-mobile-wide-scrolled.png |
| 21 | 手机宽表滚到最右后双钮在场不出视口 | inViewport=true |

## 截图

- 00-desktop-table.png 桌面非悬停(操作钮全隐)
- 01-desktop-hover.png 桌面悬停乙,丙行(双钮显现)
- 02-mobile-always-visible.png 手机 390 每行常显小钮
- 03-desktop-wide.png 宽表末行悬停
- 04-mobile-adv-tables.png 手机对抗表(仅表头/单格/宽表)
- 05-mobile-wide-scrolled.png 手机宽表滚到最右(操作格行内不覆邻)

## 环境备注

- headless Chromium 默认上报 `(hover: hover)=false`,Tailwind v4 的 group-hover 规则编译在该媒体之下;
  QA 用 `--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4`
  显式声明 hover/fine 指针能力(等价真实桌面),`Input.dispatchMouseEvent` 真实指针悬停验证。
- 界面语言经 localStorage 镜像 `ul_omo_language=zh-CN` 先于应用启动写入(浏览器语言探测会取 en)。
- 单元测试另覆盖:tableToTsv 序列化+列对齐分段数、RFC4180 全分支、DOM 读数(制表符折叠)、
  结构类切换、happy-dom 真点击 wiring(copyText 收全表 TSV/下载 CSV)
  (web/tests/markdown-table-actions.test.tsx,13 例;全套 vitest 781/781,tsc -b 绿,oxlint 仅基线既有警告)。
