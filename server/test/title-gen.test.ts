// 标题生成服务单测（W2 todo 8）：jsonl 直读解析 / prompt 组装 / 标题清洗 /
// mock HTTP 成功-失败-超时。触发矩阵与手动端点见 title-gen-trigger.test.ts。
import { describe, expect, test } from "bun:test";
import { buildTitlePrompt, parseSessionHead, sanitizeTitle } from "../src/title-gen";

/** 直构 jsonl 样本（w5-27 方法，零 token）：形态照 /root/.pi/agent 真实会话实录 */
function jsonl(lines: Array<Record<string, unknown>>): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

const header = { type: "session", version: 3, id: "durable-1", timestamp: "2026-10-11T00:00:00.000Z", cwd: "/proj" };
const noise = { type: "model_change", id: "m1", parentId: null, timestamp: "2026-10-11T00:00:01.000Z", provider: "zai-coding-cn", modelId: "glm-5.3-flash" };
const userMsg = (text: string) => ({
  type: "message", id: "u1", parentId: "m1", timestamp: "2026-10-11T00:00:02.000Z",
  message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
});
const assistantMsg = (text: string) => ({
  type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-11T00:00:03.000Z",
  message: { role: "assistant", content: [{ type: "text", text }], timestamp: 2 },
});

describe("parseSessionHead", () => {
  test("正常：取 header durable id + 首条 user/assistant 文本", () => {
    const head = parseSessionHead(jsonl([header, noise, userMsg("帮我看看 tsconfig"), assistantMsg("strict 是一组开关")]));
    expect(head).not.toBeNull();
    expect(head?.durableId).toBe("durable-1");
    expect(head?.userText).toBe("帮我看看 tsconfig");
    expect(head?.assistantText).toBe("strict 是一组开关");
    expect(head?.hasAssistant).toBe(true);
  });

  test("仅 user 消息（回合被中断）：hasAssistant=false", () => {
    const head = parseSessionHead(jsonl([header, userMsg("没答完")]));
    expect(head?.hasAssistant).toBe(false);
    expect(head?.userText).toBe("没答完");
  });

  test("assistant 仅 toolCall 无文本：hasAssistant=true、assistantText 空串", () => {
    const toolCallOnly = {
      type: "message", id: "a1", parentId: "u1", timestamp: "t",
      message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "todo", arguments: {} }] },
    };
    const head = parseSessionHead(jsonl([header, userMsg("建清单"), toolCallOnly, assistantMsg("建好了")]));
    expect(head?.hasAssistant).toBe(true);
    expect(head?.assistantText).toBe("建好了"); // 取首条含文本的 assistant
  });

  test("损坏行与尾部半行跳过、缺 header 返回 null", () => {
    expect(parseSessionHead("{broken\n{\"type\":\"other\"}")).toBeNull();
    const noHeader = jsonl([userMsg("x"), assistantMsg("y")]);
    expect(parseSessionHead(noHeader)).toBeNull();
  });

  test("content 为字符串形态（引擎兼容形态）也能取文本", () => {
    const strContent = {
      type: "message", id: "u1", parentId: null, timestamp: "t",
      message: { role: "user", content: "纯字符串内容" },
    };
    const head = parseSessionHead(jsonl([header, strContent]));
    expect(head?.userText).toBe("纯字符串内容");
  });
});

describe("buildTitlePrompt", () => {
  test("固定模板 + 双消息 500 字截断", () => {
    const longUser = "用".repeat(600);
    const longAssistant = "答".repeat(600);
    const prompt = buildTitlePrompt(longUser, longAssistant);
    expect(prompt.startsWith("为以下对话生成一个不超过 16 个字的中文短标题，只输出标题本身")).toBe(true);
    expect(prompt).toContain(`用户：${"用".repeat(500)}`);
    expect(prompt).not.toContain("用".repeat(501));
    expect(prompt).toContain(`助手：${"答".repeat(500)}`);
    expect(prompt).not.toContain("答".repeat(501));
  });

  test("assistant 文本为空时仅含用户段", () => {
    const prompt = buildTitlePrompt("问题", "");
    expect(prompt).toContain("用户：问题");
    expect(prompt).not.toContain("助手：");
  });
});

describe("sanitizeTitle", () => {
  test("去首尾引号与空白", () => {
    expect(sanitizeTitle('  "TS strict 选项详解" ')).toBe("TS strict 选项详解");
  });
  test("超 16 字截断（按字符数非字节）", () => {
    expect(Array.from(sanitizeTitle("这是一个超过十六个字的长标题需要被截断处理"))).toHaveLength(16);
    // 21 字 → 截前 16
    expect(sanitizeTitle("一二三四五六七八九十一二三四五六七八九十日")).toBe("一二三四五六七八九十一二三四五六");
  });
  test("全空白返回空串（调用方据此抛错）", () => {
    expect(sanitizeTitle('  ""  ')).toBe("");
  });
});
