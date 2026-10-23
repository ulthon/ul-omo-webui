// 终验微修（t26 兜底截断分支补测）：文本兜底 result:"..." 在下一个 "\n键:" 段
// （next: 续接提示）处截断。帧形态取自实录
// .omo/evidence/docs08-2026-10-22-batch/task-26/wake-frames.jsonl（去掉结构化 details，
// 走文本兜底分支）。
import { describe, expect, test } from "vitest";
import { parseTaskCompletionEntry } from "../task-completion";

describe("文本兜底 result 截断（t26 微修）", () => {
  test("next: 段不混入 responseText，截断在 \\nnext: 处", () => {
    // 实录形态（task-26/wake-frames.jsonl 首帧 content，剥离 details）
    const entry = {
      type: "custom_message",
      customType: "omo-senpi:wake",
      display: false,
      content:
        'task completion name:st_01a16561 id:st_01a16561 category:quick(zai-coding-cn/glm-5.3-flash:low) fallback:zai-coding-cn/glm-5.3-flash->GLM-5.3 Flash status:completed duration:14.92s tokens:20611 tools:0 tps:196\nresult:"BGQA-OK-1022"\nnext:Use task_send({ to: "st_01a16561", message: "..." }) to continue.',
    };
    const parsed = parseTaskCompletionEntry(entry);
    expect(parsed).not.toBeNull();
    expect(parsed!.taskId).toBe("st_01a16561");
    expect(parsed!.status).toBe("completed");
    expect(parsed!.responseText).toBe("BGQA-OK-1022");
    expect(parsed!.responseText).not.toContain("next:");
  });
});
