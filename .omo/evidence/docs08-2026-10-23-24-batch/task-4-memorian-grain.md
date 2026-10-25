# 任务4 spike：memorian accepted-turns 写入粒度（2026-10-25）

只读调查，未改任何引擎/webui 代码。取证对象：

- 插件：`node_modules/omo-ai/plugin` v5.1.0，`extensions/omo.js`（压缩为 1 行，以下以「行2 + 字节偏移」定位，函数名 `gX`、常量 `mX="omo-memory:accepted-turns"`）
- 引擎：`node_modules/omo-ai/node_modules/@code-yeongyu/senpi` 2026.9.28-7，`dist/core/agent-session.js`、`dist/modes/rpc/connection-handler.js`

## 结论1 写入点：逐 input_disposition 一条

`omo.js:2`（偏移 ~919.4k）`gX.register` 内：

- `r.on("input")`：跳过 `source==="extension"` 的输入，登记 `inputId -> sessionId`。
- `r.on("input_disposition")`：`disposition` 为 `"queued"` 或 `"started"` 时（`n.delete` 保证同一 inputId 只计一次）：

```js
let o=t.get(i)??{version:1,sessionId:i,priorUserTurns:0,sessionBaselineTurns:0};
!function(e,n){t.set(n.sessionId,n),e.appendEntry(mX,n)}(r,{...o,priorUserTurns:o.priorUserTurns+1})
```

即每个被接受的用户输入写一条 custom 条目（`customType="omo-memory:accepted-turns"`，载荷 `{version,sessionId,priorUserTurns,sessionBaselineTurns}`）。处置事件的发射源在引擎 `agent-session.js:2981 / :3352`（`emitInput(..., options?.source ?? "interactive", ...)`）与 `emitInputDisposition("queued"/"started")`（`agent-session.js:150749/158754 字节区，即 prompt 流程内）。

## 结论2 按回合批量：可行，语义不破

- 回放只取末条：`gX` 的 `session_start` 处理器对 `getEntries()` **倒序**查找该会话最后一条 `customType===mX` 的条目恢复计数（omo.js:2 偏移 ~918.7k：`for(let n=e.length-1;n>=0;n-=1){...return r.data}`）。条目只要最新计数，逐条/合并写对计数语义等价。
- 触发节奏与条目频率无关：`nudgeTurns` 依据 git 提交 trailers（`Omo-Writer: memory-tool` / `Omo-Turn`）与 `everyUserTurns` 阈值计算（omo.js:2 偏移 ~920.3k），不读 accepted-turns 条目个数。
- webui `mergeMemoryItems` 逐条目渲染一行 → 条目数减少即消息行减少，正是期望效果。
- 推论：引擎侧把 appendEntry 收敛到回合结束（或计数变化时合并写）不改变恢复/触发语义；属插件内一处改动（omo-ai 侧），非 webui 改动。

## 结论3 steer 注入豁免：机制已有，但现有字段不够分

- 过滤钩子已存在：`r.on("input")` 已按 `e.source` 豁免（当前仅豁免 `"extension"`，omo.js:2 偏移 ~919.1k）。
- source 全链路透传：`agent-session.js:3352` `_queueUserInput` → `_runInputHandlers(..., options?.source ?? "interactive")`；`agent-session.js:3388` `steer()` 即走该路径。
- 但 RPC 下普通发送与 steer 注入同值：`connection-handler.js:921`（prompt case）与 `:964`（steer case）均传 `source: "rpc"`。仅凭现有 source 字段无法只豁免注入轮；需引擎在 steer 路径补一个可区分标记（如独立 source 值或 input 事件标志），插件侧过滤条件一行级扩展即可。
- 未证实：CLI 本地交互路径 steer/普通输入的 source 实际取值分布未逐条核（本次只核了 RPC 路径与代码默认值）。

## 台账对应

docs/08-产品待办.md「缺陷：排队条『立即发送』…」条目下新增嵌套行「引擎侧粒度结论（2026-10-25）」。
