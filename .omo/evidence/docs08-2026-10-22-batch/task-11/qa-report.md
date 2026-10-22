# 任务 11 QA 证据:粘性用户消息与回底按钮验证(2026-10-22)

> 契约以计划原文为准:上滚离开视口时最近一条 user 气泡钉消息区顶(回底消失);
> 回底按钮二值判据=两档滚动超过一屏后按钮必须出现在视口内;粘性条不承载交互;
> 不改滚动跟随/锚定;无新增大监听;不破坏虚拟化窗口化。

## 实现要点(与契约的对应)

- 虚拟化行为绝对定位(TanStack Virtual transform),纯 CSS sticky 不可行;判定复用
  既有 `handleScroll` 通道(不新增监听),几何取 `virtualizer.measurementsCache`
  (窗外行可判,同 NavRail 惯例)。纯函数 `stickyUserOf` / `shouldShowStickyUser`
  落 `message-items.ts`(fast-refresh 约束:组件文件只导组件)。
- 二值判定:未在底部(回底即消失)且最近含文本 user 气泡完整滚出视口(上缘滚出=
  下滚读长回答;下缘滚出=上滚浏览历史,OC 行为)时钉摘要;气泡在视口内(含跨越
  边缘)不钉;无 user 消息不渲染。
- 粘性条视觉复用用户气泡色族(bg-primary/text-primary-foreground 圆丸),aria-hidden
  + pointer-events-none(不承载交互,不重复读屏);syncing/compacting 浮条在粘性
  条在场时下移避让(top-2→top-10)。
- 回底打磨(任务标题"验证打磨"项):平滑滚底途中与落底后虚拟化行测量会增长总高,
  点击时目标失效落点未到底(手机档实测 +239px)——`scrollToBottom(smooth)` 加 2s
  收敛窗口(300ms 校验,阈值外补瞬时对底;用户主动上滚 >50px 即退出不抢滚动)。
  非 smooth 路径(会话打开两段式滚底)不变。

## 隔离实例与防 stale

- worktree docs08-r7-wave1-t11 根构建(`npm run build`,内嵌资产 330 文件),
  `node server/dist/index.js` 端口 8961,DATA_DIR=/tmp/t11-qa/data,
  AGENT_DIR=/tmp/t11-qa/agent(QA 后随 /tmp/t11-* 清理)。
- 伺服 bundle:index-B6uQybaa.js,sha256 前 16 = `5143c463dbb92a68`,
  页面内 fetch 与磁盘字节一致(desktop/mobile 双档 M11 断言)。
- fixture 会话:jsonl 直写 `<agent>/sessions/--tmp-t11-qa-project--/`(尾缀双横线
  惯例),61 条目:28 对 user/assistant 交替 + 超长 user 提问(约 2100 字,视口高
  数倍)+ 连排两条 user + 末条长应答(把最后一问推离底部)+ 末答;末条 user 文本
  「最后一问:粘性条应显示这句摘要。」为粘性断言锚点。

## 判定结果(22/22 通过,desktop 1920x1080 与 mobile 390x844 各 11 项)

| # | 判定 | 证据 |
| --- | --- | --- |
| M1 | 初始滚底:无粘性条无回底钮(回底消失的静默侧) | visibleRows>0 且双元素缺席 |
| M2 | 上滚 1.2 屏,最近 user 气泡从下缘滚出:钉摘要条,文本精确=当前提问 | desktop-1 / mobile-1 截图,text 全等 |
| M3 | 二值判据:滚超一屏后回底钮完整在视口内(inVp=true) | desktop top 874-902 / mobile 688-716 |
| M4 | 深上滚(条件驱动,气泡确认在视口下方):仍钉最后提问 | 连排 user 在下方,候选取末条 |
| M5 | 深上滚后回底钮仍在视口 | inVp=true |
| M6 | 下滚越顶(气泡上缘滚出,距底>80px):粘性条保持 | dist=6382/2444,条在场 |
| M7 | 下滚>一屏回底钮仍在视口 | inVp=true |
| M8 | 超长提问滚出视口:粘性条 truncate 截断降级(overflow≤1) | overflow=0 |
| M9 | 虚拟化回归:4 个滚动位抽样,每处视口内均有可见行(无整屏空白) | samples visibleRows≥1 |
| M10 | 点击回底钮 → 滚底落定(dist<90)且粘性条与回底钮同时消失(回底消失) | desktop dist=24 / mobile dist=0 |
| M11 | 伺服 bundle 哈希与磁盘一致(陈旧产物防线) | sha256 双端相等 |

- 判据口径说明:M4 深上滚采用条件驱动(循环上滚至最近气泡确认完整在视口下方,
  最多 4 轮)。固定落点式会踩虚拟化测量收敛的位移(实测内容整体位移约 500px,
  落点处气泡仍在视口内、条按契约正确隐藏)——产品行为符合二值契约,是场景构造
  问题,已在 R8 诊断实证(st=4376, lastQTop=683, 气泡可见,条正确缺席)。
- 移动档备注:右栏抽屉会话打开时自动展开,截图前按记忆坑位流程关闭(backdrop
  在场时点一次 close);截图内黑色 toast 为引擎环境噪声(凭证缺失的 memory
  reflection 告警),与本任务无关。

## 测试与门禁(最终代码态)

- web vitest:813/813 全绿(基线 799,净增 14;新增 tests/sticky-user-message.test.tsx:
  纯函数 8 + 挂载链路 6,含回底钮二值判据的测试形态与无 user 消息不渲染)。
- `tsc -b`:干净(exit 0)。
- oxlint:变更 3 文件(message-list.tsx / message-items.ts / sticky 测试)共 1 警告
  (useVirtualizer 既有警告,main 同源),0 error,零新增。
- 门禁净计数:799 → 813,净增 14。

## 截图清单(本目录)

- desktop-0-bottom / desktop-1-sticky-scrolled-up / desktop-2-sticky-scrolled-past /
  desktop-3-long-user / desktop-4-mid-scroll / desktop-5-back-bottom(1920x1080)
- mobile-0-bottom / mobile-1-sticky-scrolled-up / mobile-2-sticky-scrolled-past /
  mobile-3-long-user / mobile-4-mid-scroll / mobile-5-back-bottom(390x844,iphone-14 档)
- qa-results.json:22 项断言全量明细
