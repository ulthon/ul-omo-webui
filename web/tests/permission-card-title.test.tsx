// 降级文案（docs08-r6 任务 6 ③）：提问降级产生的 select 型 UI 请求不继承「权限请求」
// 标题——permission-card chrome 按 payload kind 区分（标题带引擎权限门前缀 = 权限请求；
// 其余 select 用中性「需要选择」）。i18n 键 zh/en 双档齐套并直查取词。
import { afterEach, describe, expect, test } from "vitest";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PermissionCard } = await import("@/components/chat/permission-card");
const { t, useLocaleStore } = await import("@/i18n/i18n");

function renderCard(request: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(PermissionCard, {
      sessionId: "qa-title-1",
      request: request as never,
      position: 1,
      total: 1,
    }),
  );
}

/** 引擎权限门固定形态（run1 实证） */
const permissionSelect = {
  id: "perm-1",
  method: "select",
  title: "Permission required: bash\n\nCommand: $ ls -la\n\nPatterns:\n  - ls",
  options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
};

/** 提问降级 select（引擎 degradeQuestion：ui.select(问题原文, [...选项, "Other…"])） */
const degradedQuestionSelect = {
  id: "q-degrade-1",
  method: "select",
  title: "Which environment should we deploy to?",
  options: ["staging", "production", "Other (type an answer)"],
};

/** 登录选择等其它非权限 select（login-prompts 同款形态） */
const loginSelect = {
  id: "login-1",
  method: "select",
  title: "Select authentication method",
  options: ["API key", "OAuth"],
};

afterEach(() => {
  useLocaleStore.setState({ locale: "zh-CN" });
});

describe("select 型 chrome 标题按 payload kind 区分", () => {
  test("权限门 select（Permission required: 前缀）→「权限请求」且保留 auto-allow 入口", () => {
    const html = renderCard(permissionSelect);
    expect(html).toContain("权限请求");
    expect(html).not.toContain("需要选择");
    expect(html).toContain("总是允许");
  });

  test("提问降级 select → 中性「需要选择」，不继承「权限请求」标题（验收主断言）", () => {
    const html = renderCard(degradedQuestionSelect);
    expect(html).toContain("需要选择");
    expect(html).not.toContain("权限请求");
    // 非权限载荷不出现 auto-allow 勾选（parsePermissionTool 为 null 的既有门不放宽）
    expect(html).not.toContain("总是允许");
    // 问题原文与降级选项（含 Other）原样渲染，应答契约不受影响
    expect(html).toContain("Which environment should we deploy to?");
    expect(html).toContain("Other (type an answer)");
  });

  test("登录选择等其它非权限 select → 同样「需要选择」", () => {
    const html = renderCard(loginSelect);
    expect(html).toContain("需要选择");
    expect(html).not.toContain("权限请求");
  });

  test("confirm/input/editor 三型标题映射不变（METHOD_KEY 原表）", () => {
    expect(renderCard({ id: "c1", method: "confirm", title: "View source path?", message: "msg" })).toContain("确认操作");
    expect(renderCard({ id: "i1", method: "input", title: "Feedback" })).toContain("需要输入");
    expect(renderCard({ id: "e1", method: "editor", title: "Edit some text", prefill: "x" })).toContain("需要编辑");
  });
});

describe("i18n 键齐套（kindChoice）", () => {
  test("zh 档取词「需要选择」", () => {
    expect(t("chat.permissionCard.kindChoice")).toBe("需要选择");
  });

  test("en 档取词「Selection required」（键进全部语言档，键名漂移防护）", () => {
    useLocaleStore.setState({ locale: "en" });
    expect(t("chat.permissionCard.kindChoice")).toBe("Selection required");
    const html = renderCard(degradedQuestionSelect);
    expect(html).toContain("Selection required");
    expect(html).not.toContain("Permission request");
  });

  test("en 档权限 select 仍「Permission request」（区分双向成立）", () => {
    useLocaleStore.setState({ locale: "en" });
    expect(renderCard(permissionSelect)).toContain("Permission request");
  });
});
