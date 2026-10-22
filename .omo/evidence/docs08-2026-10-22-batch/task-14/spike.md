# 任务 14 spike：引擎 comment-only 落定语义（隔离实例复验）

日期：2026-10-22（docs08-2026-10-22-batch 任务 14）

## 结论（分支 B：引擎接受 comment-only，webui server 剥字段是根因）

引擎 `ConnectionQuestionBridge.respond`（node_modules/@code-yeongyu/senpi/dist/modes/rpc/connection-question-bridge.js）
要求应答载荷**含 `answers` 键**（可为空对象）才进入 `settledQuestionStatus`：

- `{ answers: {}, comment: "非空" }` → 落定 `comment-submitted`，广播 `question_resolved`（回合按 waitForAnswer 语义继续）
- `{ comment: "非空" }`（无 answers 键）→ 返回 `"question_incomplete"` 拒收（**r6 实录卡死根因**）
- `{ answers: {} }`（无 comment）→ `"question_incomplete"` 拒收

`settledQuestionStatus`（extension-ui-response.js）：非空 comment → `comment-submitted`；否则任一 answer → `answered`；全空 → undefined（拒收）。
**引擎侧拒收对 webui 是静默的**：`sendExtensionUIResponse` 为 fire-and-forget（rpc-client.js:321），回包 success:false 无人消费 → 前端出队后引擎侧仍挂起，回合最终超时 aborted（与 docs/08 第 15 条实录一致）。

## 修法

1. server/routes-session.ts：`isQuestionAnswers` 放行空对象 `{}`；路由守卫：空 answers 仅随非空 comment 透传（纯空对象仍 400）。comment-only 应答现在原样带 `answers:{}` 到引擎。
2. web/question-card.tsx：空提交内联错误态（原 needAnswer toast 保留文案改内联渲染）；提交后**不本地出队**（失败不消失），显「已提交，等待确认…」，5s 未见 question_resolved 显重试/取消兜底（引擎静默拒收场景的自救口）。
3. 取消/忽略路径语义不动（引擎 cancel 恒落定 cancelled，本地出队保持即时）。

## 真实引擎复验（本轮 QA，非 mock）

- 隔离实例 7791（UL_OMO_WEBUI_AGENT_DIR=/tmp/t14-qa/agent，三件套播种），真实引擎 spawn。
- 引擎 bootstrap ask-user-question 产生**真实 pending question**（waitForAnswer=true，阻塞回合）。
- 浏览器（真实 dist bundle，sha256 index-Dh0v3xVM.js=e3ad904caf0a1356）仅填 comment 提交：
  - POST 载荷（posted-payloads.jsonl）：`{"requestId":"6bf6254a-…","answers":{},"comment":"QA comment-only: 仅备注提交，不选选项（r6 回归，真实引擎）"}`
  - 卡片经真实 SSE `question_resolved` 出队（REAL_RESOLVED_DEQUEUES=true）
  - **回合真实继续**：jsonl 落新 assistant 条目（glm-5.3，usage 27657 tok，stopReason=stop，19:56-19:57）

## 附：node 级引擎桥三形态验证

/tmp/t14-spike/spike.mjs 输出（留存于本目录 spike-output.log）：

```
RESPOND_COMMENT_ONLY true
RESOLVED_1 {"outcome":"comment-submitted","answers":{},"comment":"只补充说明"}
STATUS_1 comment-submitted
RESPOND_NO_ANSWERS_KEY "question_incomplete"
RESPOND_EMPTY_ONLY "question_incomplete"
```
