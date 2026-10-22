# 任务 26 spike：后台完成通知帧形态实录（docs08-2026-10-22 批次）

## 结论

引擎后台 task 完成通知**含 task_id 与结构化用量**，subagent-data 已消费该通道将卡转真终态。

## 帧形态（两层，结构化优先）

通道：父会话 `entry_appended` wire 帧携 `entry = {type:"custom_message", id, customType:"omo-senpi:wake", content, display, details}`（JSONL 顶层同形，历史 GET messages 同构）。

1. **结构化形态**（2026-10-22 隔离实例真实后台子代理全链路实录，st_01a16561）：
   `details = [{customType:"senpi-task.completion", details:[{task_id, name, status:"completed", category, model, requested_model, resolved_model, duration_ms:14923, run_stats:{...全键结构化同 end 帧}, final_response:"BGQA-OK-1022", continuation_hint, tokens}]}]`
2. **文本兜底形态**（历史会话库 2026-10-17 实录）：content 文本
   `task completion name:st_x id:st_x agent:... status:completed duration:3m 52s tokens:447558 tools:43 tps:90\nresult:"..."[\nnext:...]`，details 缺失。
   注意 content 含 `next:` 续接段，文本提取须截断（resultTextOf 已处理）。

全库 234 条 omo-senpi:wake 扫描：task completion 193 条（completed 176 / error 17），其余为 ulw 续跑引导等非 task 载荷（不消费，判定门 content 前缀）。

## 消费链

messages store entry_appended 放行门（lib/task-completion.parseTaskCompletionEntry 判定）→ entries 入列 → collectSubagentCalls 按 taskId 配对（spawn 回执 details.task_id ↔ 通知 task_id）→ 回执启动态卡转真终态（status 覆写 + runStats/final_response 并入）。

## 真实引擎全链路 QA（隔离实例 :7791，bundle 9bc7b3657b2de573）

- 提示词驱动真实引擎后台派发子代理（glm-5.3-flash，task run_in_background=true）：
  - 实时 SSE 状态翻转实录（qa-3/qa-4 截图）：`Running` → `Dispatched · running in background`（spawn 回执到达）→ `Completed`（wake 通知到达，用时 14.9s · 20.6k tok · 196 tok/s · $0.0027，最终回复 BGQA-OK-1022）
- failure 场景（通知未到达期间）：启动态恒显「已派发·后台运行中」转圈脉动，不误显完成（qa-1/qa-3）
- 手机档 390x844 完成态如实（qa-5）
- 已知限制（计划允许的降级）：无通知到达且会话回合结束后，卡维持启动态语义；重启刷新后 REST 仍读 spawn 回执——如实显示「已派发·后台运行中」，不虚构完成态。

## 证据文件

- qa-0 桌面空态 / qa-1 首轮派发态（旧 bundle，观感同） / qa-2 刷新后终态
- qa-6 最终 bundle（9bc7b3657b2de573）双历史卡：Completed + 全结构化指标（含 turns/output/费用）+ 干净 final_response 预览
- wake-frames.jsonl：两轮真实引擎 wake 通知帧原文
- qa-3 最终 bundle 实时派发态 / qa-4 最终 bundle 实时完成态 / qa-5 手机档完成态
- 会话 JSONL：/tmp/t26-qa/agent/sessions/--tmp-t26-qa-proj--/2026-10-22T20-49-20-448Z_*.jsonl（含 2 条 wake 帧）
