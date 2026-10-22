# 任务 16 证据:会话切换性能——首载尾窗直读与向上翻页

实例:隔离 QA(worktree 构建 bundle hash sha256(index.html+assets/*.js)=711ccbe824dedb1d5a7ff4f7090ae6d22bc5d614bc2fe417edac73b9f3ea2752,端口 7801,agentDir=/tmp/t16-qa/agent)。
Fixture:2200 条消息会话(866KB jsonl,含 toolCall/toolResult 跨界对)。

## 首载计时(curl,服务端)
- 尾窗直读(无 cursor):**93.9ms,216 条**(窗口 200+重叠 16),hasMore=true,oldestId=e01984,leafId=e02199
- ?before= 上一窗:**17.3ms,216 条**,末条恰为重叠锚 e01984,oldestId 推进 e01769
- 无效 before:**409 cursor_invalid**
- 对照组 ?full=1(引擎全量,同实例引擎冷启动):**10060ms 后引擎 open_failed**(隔离实例无真实引擎可 spawn)——即 W0 归因的 4.7-23.1s 首载成本主体;尾窗直读完全绕开引擎,ensureMs=0 不触发 503 窗
- 浏览器实测(desktop 1920x1080):GET messages 网络耗时 **19ms**,点击到消息渲染全程 6.5s(含前端 JS 加载/水合,与旧全量路径的 10s+ 引擎等待不同源)
- 手机档 390x844:GET messages **17ms**,尾窗 2194-2199 正常渲染(mobile-tail.png)

## 拼缝(浏览器实测)
- 触顶翻页:一次 ?before= 请求 22ms,滚动高度 25158→50558(约 +216 条),scrollTop 保持 0 无跳动(desktop-tail-first.png → desktop-after-seam.png,编号 1770..1777 连续无重复)
- 二次翻页:游标推进 before=e01985 → before=e01770,滚动高度 50558→75958
- 零重复零丢失由 store 单测锁定:messages-paging.test.ts(尾窗+上一窗去重并集恰为文件连续区间 e00169..e00599)

## SSE gap 回退
- gap/游标回退对账走 ?full=1 全量:web/src/lib/__tests__/event-dispatch-full.test.ts(客户端以 {full:true} 请求且 setEntries 整替 hasMore 复位)
- 服务端 ?full=1 路由到引擎:session-file.test.ts 路由用例(engineCalls 计数断言)
- 注:隔离实例无真实引擎,?full=1 的引擎全量语义由既有 routes/runtime 测试与本任务路由测试覆盖,未在浏览器实跑 gap(gap 强制注入不可行,组件级测试为计划允许路径)

## 边界(服务端单测)
- 短会话(<216):全量返回 hasMore=false,不报翻页游标
- 恰好 216 条:hasMore=false
- 空会话(仅 header):空窗 oldestId/leafId=null
- 末尾残缺行(写入中):丢弃不崩
- 超 64KB 跨块大条目:解析不丢

## 截图
- desktop-tail-first.png:尾窗首载(最新 提问 2199 在底)
- desktop-after-seam.png:触顶翻页后(1770s 区间无缝接上)
- mobile-tail.png:手机档尾窗(390x844)
