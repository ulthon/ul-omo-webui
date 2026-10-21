/**
 * stdio RPC 宿主客户端能力声明——单一来源（docs08-r6 任务 5）。
 *
 * 引擎在 rpc-mode 启动时读一次 SENPI_RPC_CLIENT_CAPABILITIES（逗号分隔，
 * rpc-mode.js envValue("RPC_CLIENT_CAPABILITIES")）；stdio 连接的 set_client_info
 * 能力面是静默空操作（connection-handler 按 currentConnection 路由，stdio 启动
 * 路径无连接句柄），env 是唯一能力通道。
 *
 * 消费方（勿各自硬编码）：
 *   - engine/process-manager.ts buildSpawnOptions——生产组合（engine-runtime
 *     clientFactory）实际走的 spawn 路径；
 *   - adapter/senpi-adapter.ts createClient——自建 RpcClient 路径。
 *
 * 本模块为零依赖叶模块（不 import 任何工程内模块），任何方向引用都不构成环。
 */

/** 能力清单：question（q1 提问卡片）使 ask-user 走结构化 method:"question" 帧
 * （waitForAnswer/questions/deadline 一体下发），不声明则引擎 degradeQuestion
 * 降级为 select/input 对话框链（multiSelect 与逐问自由文本在降级中丢失）；
 * extension_events 为扩展事件通道。前端 QuestionCard 与本能力必须同版本上线。 */
export const RPC_CLIENT_CAPABILITY_LIST: readonly string[] = ["extension_events", "question"]

/** 两处 spawn env 共用的能力声明（frozen 防散改；值 = 清单 join(",")） */
export const RPC_CLIENT_CAPABILITIES_ENV: Readonly<Record<string, string>> = Object.freeze({
  SENPI_RPC_CLIENT_CAPABILITIES: RPC_CLIENT_CAPABILITY_LIST.join(","),
})
