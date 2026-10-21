// docs08-r6 任务 11 单测：服务端 runState 三态推导纯函数 deriveSessionRunState。
// 三源（streaming/permission/question）→ running|waiting|idle 的全组合映射表：
//   waiting 优先——权限门/阻塞型提问挂起回合不结束（P0-2 实证：agent_end 到达即权限
//   已落定），强置 running 是语义回退（与前端 SSE 分发同口径：四型权限帧与
//   waitForAnswer question 帧都置 waiting）；仅 streaming 占用 → running；三源全空 → idle。
// 三源供数接线（EngineGateway.peekRunStates 三源读取）与 GET /api/sessions 行下发
// 见 routes.test.ts（runState 字段用例与 EngineRuntimeRegistry peekRunStates 用例）。
import { describe, expect, test } from "vitest";
import { deriveSessionRunState } from "../src/api/engine-runtime";

describe("deriveSessionRunState 三源全组合映射表", () => {
  const cases: Array<{
    streaming: boolean;
    permission: boolean;
    question: boolean;
    expected: "running" | "waiting" | "idle";
  }> = [
    { streaming: false, permission: false, question: false, expected: "idle" },
    { streaming: false, permission: false, question: true, expected: "waiting" },
    { streaming: false, permission: true, question: false, expected: "waiting" },
    { streaming: false, permission: true, question: true, expected: "waiting" },
    { streaming: true, permission: false, question: false, expected: "running" },
    { streaming: true, permission: false, question: true, expected: "waiting" },
    { streaming: true, permission: true, question: false, expected: "waiting" },
    { streaming: true, permission: true, question: true, expected: "waiting" },
  ];
  for (const { streaming, permission, question, expected } of cases) {
    test(`streaming=${streaming} permission=${permission} question=${question} → ${expected}`, () => {
      expect(deriveSessionRunState({ streaming, permission, question })).toBe(expected);
    });
  }
});
