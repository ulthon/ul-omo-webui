# 任务 5 QA 回执:水位三面附已用/上限 token(docs08-2026-10-22-batch)

- 分支 docs08-r7-wave1-t5,基点 main@3457894
- 实例:worktree 隔离实例 http://127.0.0.1:8957(UL_OMO_WEBUI_DATA_DIR/AGENT_DIR/META_DB=/tmp/t5-qa/*;UL_OMO_WEBUI_PORT=8957);fresh root build(npm run build)后 node server/dist/index.js
- 伺服 bundle:index-Bs7Re0LF.js;sha256 磁盘与线上字节一致:`2cfecaf19f2f91b071f3839934b2624fc018f588f930306d26a9bf97f915f22f`(qa-run.log PASS bundle-fresh)
- usage 数据:/api/usage 经 CDP Fetch 域拦截 fulfill(57K/1M → 5.7%,formatTokens 语义 57.0k/1.00M);会话为 fixture jsonl(引擎冷启动 createSession 不落 jsonl 会被列表跳过,手工落 `{"type":"session","version":3,...}` 头后列表可发现)
- 视口:桌面 1920x1080(CDP 设备模拟),移动 iPhone-14 档(innerWidth 实测 390)
- 断言:11/11 PASS(results.json;qa-run.log)
  1. 明细浮层「上下文」行 =「6% · 57.0k/1.00M」(context-ring-ctx,实测文本与截图 mobile-2-ring-detail.png)
  2. 环心仍纯百分比「6%」且 text-[9px] 形态保留(单测断言 + mobile-1-ring.png)
  3. 环 tooltip 带 used/limit:实测 title「Context 6% · 57.0k/1.00M」(en locale;zh 同键位「上下文 {pct}% · {tokens}」)
  4. 桌面状态栏追加:实测「↑40.0k ↓7.0k cache 10.0k · context 6% · 57.0k/1.00M」(desktop-1-status.png 底栏实拍)
  5. failure 面:contextUsage.contextWindow=0 → toUsageStats context=null → 环隐藏 + 状态栏无 token 段(desktop-2-failure-no-ctx.png;另有单测断言)
- 单测:web vitest 755/755(基线 751 净增 4);tsc -b exit 0;oxlint 变更文件 0 告警;formatTokens 边界 0/999/1.0k/1.2k/1000.0k/1.00M/1.23M 全覆盖
- 环境备注:页面底部深色 toast 为共享 /root/.omo omo.jsonc 弃用告警(引擎环境噪声,与本任务无关);浏览器 en locale 显示英文文案,中文键位同构(i18n zh+en 均已同步)
- 清理:隔离实例进程与 /tmp/t5-qa、浏览器临时 profile 均已拆除(见提交后回执)
