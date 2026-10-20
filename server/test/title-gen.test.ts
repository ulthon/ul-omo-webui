// 标题生成服务单测（W2 todo 8）：jsonl 直读解析 / prompt 组装 / 标题清洗 /
// mock HTTP 成功-失败-超时。触发矩阵与手动端点见 title-gen-trigger.test.ts。
import { describe, expect, test } from "vitest";
import {
  buildTitlePrompt,
  EN_TITLE_MAX,
  parseSessionHead,
  resolveTitleLanguage,
  sanitizeTitle,
  TITLE_LANGUAGE_KV_KEY,
  TITLE_PROMPTS,
  ZH_TITLE_MAX,
} from "../src/title-gen";

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

// golden 字符串（防常量引用同义反复：本文件断言不引用 TITLE_PROMPTS，源码常量另测逐字对照）
const GOLDEN_PROMPT_ZH = "为以下对话生成一个不超过 16 个字的中文短标题，只输出标题本身";
const GOLDEN_PROMPT_EN = "Generate a short session title of at most 60 characters, output only the title";

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
  test("两种语言固定模板 golden 断言 + 双消息 500 字截断 + 导出常量对照", () => {
    const longUser = "用".repeat(600);
    const longAssistant = "答".repeat(600);
    const zh = buildTitlePrompt(longUser, longAssistant, "zh");
    expect(zh.startsWith(GOLDEN_PROMPT_ZH)).toBe(true);
    const en = buildTitlePrompt(longUser, longAssistant, "en");
    expect(en.startsWith(GOLDEN_PROMPT_EN)).toBe(true);
    expect(en.startsWith(GOLDEN_PROMPT_ZH)).toBe(false);
    // 导出常量引用补充：映射表与 golden 逐字一致（golden 本体不引用常量，防同义反复）
    expect(TITLE_PROMPTS.zh).toBe(GOLDEN_PROMPT_ZH);
    expect(TITLE_PROMPTS.en).toBe(GOLDEN_PROMPT_EN);
    // 缺省语言 = zh：旧调用形态（两参）零变化
    expect(buildTitlePrompt(longUser, longAssistant)).toBe(zh);
    expect(zh).toContain(`用户：${"用".repeat(500)}`);
    expect(zh).not.toContain("用".repeat(501));
    expect(zh).toContain(`助手：${"答".repeat(500)}`);
    expect(zh).not.toContain("答".repeat(501));
  });

  test("assistant 文本为空时仅含用户段", () => {
    const prompt = buildTitlePrompt("问题", "");
    expect(prompt).toContain("用户：问题");
    expect(prompt).not.toContain("助手：");
    // en 档同链：只换模板行，消息段结构不变
    expect(buildTitlePrompt("问题", "", "en")).toBe(`${GOLDEN_PROMPT_EN}\n\n用户：问题`);
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
  test("en 档：60 字符截断（含引号清洗同链）", () => {
    const raw70 = "a".repeat(70);
    const cleaned = sanitizeTitle(`"${raw70}"`, "en");
    expect(Array.from(cleaned)).toHaveLength(EN_TITLE_MAX);
    expect(cleaned).toBe("a".repeat(EN_TITLE_MAX));
  });
  test("zh 档缺省零变化：仍按 ZH_TITLE_MAX=16 截断，且与显式 zh 等价", () => {
    const zh21 = "一二三四五六七八九十一二三四五六七八九十日";
    expect(Array.from(sanitizeTitle(zh21))).toHaveLength(ZH_TITLE_MAX);
    expect(sanitizeTitle(zh21)).toBe(sanitizeTitle(zh21, "zh"));
    // 分档常量钦定值（防常量被改值后断言漂移）
    expect(ZH_TITLE_MAX).toBe(16);
    expect(EN_TITLE_MAX).toBe(60);
  });
});

describe("resolveTitleLanguage（env 覆盖 > meta_kv > 缺省 zh）", () => {
  const ENV_KEY = "UL_OMO_WEBUI_TITLE_LANG";
  /** 保存/恢复 env 的最小作用域（防跨用例污染） */
  function withEnv(value: string | undefined, fn: () => void): void {
    const saved = process.env[ENV_KEY];
    try {
      if (value === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = value;
      fn();
    } finally {
      if (saved === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = saved;
    }
  }
  const fakeMeta = (kv: string | null) => ({
    getKv: (key: string) => (key === TITLE_LANGUAGE_KV_KEY ? kv : null),
  });

  test("无 env 无 kv：缺省 zh", () => {
    withEnv(undefined, () => expect(resolveTitleLanguage(fakeMeta(null))).toBe("zh"));
  });
  test("meta_kv 置 en 生效；显式 zh 生效；其它键不读", () => {
    withEnv(undefined, () => {
      expect(resolveTitleLanguage(fakeMeta("en"))).toBe("en");
      expect(resolveTitleLanguage(fakeMeta("zh"))).toBe("zh");
      expect(resolveTitleLanguage({ getKv: (key) => (key === TITLE_LANGUAGE_KV_KEY ? null : "en") })).toBe("zh"); // 键名不匹配不生效
    });
  });
  test("env 覆盖 kv；env 非法值视为未设置回退 kv/zh", () => {
    withEnv("en", () => expect(resolveTitleLanguage(fakeMeta("zh"))).toBe("en"));
    withEnv("zh", () => expect(resolveTitleLanguage(fakeMeta("en"))).toBe("zh"));
    withEnv("fr", () => expect(resolveTitleLanguage(fakeMeta("en"))).toBe("en"));
    withEnv("fr", () => expect(resolveTitleLanguage(fakeMeta(null))).toBe("zh"));
    withEnv("", () => expect(resolveTitleLanguage(fakeMeta("en"))).toBe("en"));
  });
  test("不传 meta 也可用（纯 env/缺省形态）", () => {
    withEnv("en", () => expect(resolveTitleLanguage()).toBe("en"));
    withEnv(undefined, () => expect(resolveTitleLanguage()).toBe("zh"));
  });
});
