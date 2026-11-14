/**
 * session-branching task-10 缺陷 A 回归闸：wrapLifecycleClient 是显式方法白名单
 * 包装层，SenpiRpcClient 接口加方法而白名单未跟 → 真实引擎运行时
 * this.rpc(...).xxx is not a function（500），fake 网关单测测不出（fake 直接实现
 * 接口面，不经包装层）。前科：getSteeringMessages（docs08-r4）、
 * navigateTree/getTree/editAssistantMessage/continueFromLeaf（task-10，/navigate
 * /edit-assistant /continue 真实引擎全 500）。
 *
 * 双层防线：
 * 1. 编译期穷尽：WRAPPER_SURFACE 锚定为 Record<keyof SenpiRpcClient, true>——接口
 *    加方法而清单缺键 → 编译错；清单多键/错拼 → 多余属性编译错；
 * 2. 运行期冒烟：对真实包装实例（Proxy 假引擎 client 之上）断言每个接口键都是
 *    function 且树四方法真实委托透传到引擎 client。
 */
import { describe, expect, test } from "vitest";
import type { RpcClient } from "@code-yeongyu/senpi";
import { wrapLifecycleClient } from "../src/api/engine-runtime";
import type { SenpiRpcClient } from "../src/adapter/senpi-adapter";

/** 包装层方法面锚点（编译期穷尽见文件头注释；运行期断言以本清单为单一来源） */
const WRAPPER_SURFACE: Record<keyof SenpiRpcClient, true> = {
  start: true,
  stop: true,
  setClientInfo: true,
  openSession: true,
  closeSession: true,
  listSessions: true,
  getEntries: true,
  fork: true,
  prompt: true,
  abort: true,
  clearQueue: true,
  getSteeringMessages: true,
  getFollowUpMessages: true,
  onEvent: true,
  sendExtensionUIResponse: true,
  getState: true,
  compact: true,
  getAvailableModels: true,
  getAvailableThinkingLevels: true,
  getCommands: true,
  getSessionStats: true,
  getMedia: true,
  navigateTree: true,
  getTree: true,
  editAssistantMessage: true,
  continueFromLeaf: true,
};

/** 假引擎 client：任意方法名访问即记名函数（包装层构造期只触 send.bind，其余调用期
 *  才触达——Proxy 天然满足）。calls 记 [方法名, 参数] 序列供委托断言。 */
function fakeEngineClient(): { client: RpcClient; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const client = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return (...args: unknown[]) => {
        calls.push([prop, args]);
        return { ok: true, method: prop };
      };
    },
  });
  return { client: client as unknown as RpcClient, calls };
}

describe("wrapLifecycleClient 方法面（task-10 缺陷 A 回归闸）", () => {
  test("真实包装实例覆盖 SenpiRpcClient 全部接口键（缺任一即败，报缺键名）", () => {
    const { client } = fakeEngineClient();
    const wrapped = wrapLifecycleClient(client);
    const surface = Object.keys(WRAPPER_SURFACE) as Array<keyof SenpiRpcClient>;
    const missing = surface.filter((k) => typeof (wrapped as unknown as Record<string, unknown>)[k] !== "function");
    expect(missing, `包装层缺方法: ${missing.join(",")}`).toEqual([]);
    // 反向：包装层不得漂出接口面之外的方法键（白名单即全集；send 除外——就绪探测
    // 通道，包装层注释在案）
    const wrapperKeys = new Set(Object.keys(wrapped as unknown as Record<string, unknown>));
    const drifted = surface.filter((k) => !wrapperKeys.has(k));
    expect(drifted, `包装层与清单不一致: ${drifted.join(",")}`).toEqual([]);
  });

  test("树四方法经包装层真实透传到引擎 client（task-10 缺陷 A 主链冒烟）", async () => {
    const { client, calls } = fakeEngineClient();
    const wrapped = wrapLifecycleClient(client);
    await wrapped.navigateTree("e1", { intent: "select", expectedLeafId: "leaf-0" });
    await wrapped.getTree();
    await wrapped.editAssistantMessage("e2", "改写后的回复", { expectedLeafId: "leaf-0" });
    await wrapped.continueFromLeaf({ expectedLeafId: "leaf-1" });
    expect(calls.map(([m]) => m)).toEqual([
      "navigateTree",
      "getTree",
      "editAssistantMessage",
      "continueFromLeaf",
    ]);
    expect(calls[0][1]).toEqual(["e1", { intent: "select", expectedLeafId: "leaf-0" }]);
    expect(calls[2][1]).toEqual(["e2", "改写后的回复", { expectedLeafId: "leaf-0" }]);
    expect(calls[3][1]).toEqual([{ expectedLeafId: "leaf-1" }]);
  });
});
