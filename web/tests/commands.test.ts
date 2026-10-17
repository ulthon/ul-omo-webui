// 命令解析与拦截门单测（todo 24）。
// 命令支持度实证：docs/verification/05「/compact /clear /new /undo 命令支持度实证」——
// 四命令引擎侧均不支持（getCommands 83 条无命中，prompt 直发被模型当普通消息并伪造已执行）。
import { describe, expect, test } from "vitest";
import { ApiError, setPromptGate, api } from "@/lib/api";
import {
  CHAT_COMMANDS,
  commandGate,
  lookupCommand,
  makeCommandGate,
  parseSlashCommand,
  type ChatCommand,
} from "@/components/chat/commands";

describe("parseSlashCommand", () => {
  test("非 / 前缀返回 null", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
    expect(parseSlashCommand("  ")).toBeNull();
  });

  test("裸斜杠返回 null", () => {
    expect(parseSlashCommand("/")).toBeNull();
    expect(parseSlashCommand("  / ")).toBeNull();
  });

  test("基本解析：命令名 + 空 args", () => {
    expect(parseSlashCommand("/compact")).toEqual({ name: "compact", args: "" });
    expect(parseSlashCommand("  /clear  ")).toEqual({ name: "clear", args: "" });
  });

  test("带参数与多行参数", () => {
    expect(parseSlashCommand("/compact now")).toEqual({ name: "compact", args: "now" });
    expect(parseSlashCommand("/clear 第一行\n第二行")).toEqual({ name: "clear", args: "第一行\n第二行" });
  });

  test("命令名大小写归一，非法名返回 null", () => {
    expect(parseSlashCommand("/COMPACT")).toEqual({ name: "compact", args: "" });
    expect(parseSlashCommand("/skill:code-review fix it")).toEqual({ name: "skill:code-review", args: "fix it" });
    expect(parseSlashCommand("/中文命令")).toBeNull();
  });
});

describe("makeCommandGate", () => {
  const table: ChatCommand[] = [
    { name: "good", label: "/good", supported: true, note: "" },
    { name: "bad", label: "/bad", supported: false, note: "不支持的原因" },
  ];
  const gate = makeCommandGate(table);

  test("支持的命令放行（走 POST prompt 原文）", () => {
    expect(() => gate("/good")).not.toThrow();
    expect(() => gate("/good 带参数")).not.toThrow();
  });

  test("不支持的命令抛 ApiError（command_unsupported，501）", () => {
    try {
      gate("/bad");
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.code).toBe("command_unsupported");
      expect(e.status).toBe(501);
      expect(e.message).toContain("/bad");
      expect(e.message).toContain("不支持的原因");
    }
  });

  test("非映射命令与非命令文本放行", () => {
    expect(() => gate("/unknown-cmd")).not.toThrow();
    expect(() => gate("普通消息")).not.toThrow();
    expect(() => gate("问一下 /bad 是什么")).not.toThrow();
  });
});

describe("commandGate（实证表）", () => {
  test("四命令全部不支持且命中即拦", () => {
    for (const cmd of CHAT_COMMANDS) {
      expect(cmd.supported).toBe(false);
      expect(() => commandGate(`/${cmd.name}`)).toThrow(ApiError);
      expect(() => commandGate(`/${cmd.name} extra`)).toThrow(ApiError);
    }
    expect(lookupCommand("compact")).toBeDefined();
  });

  test("引擎注册命令（83 条清单内，如 /init）与非命令放行", () => {
    expect(() => commandGate("/init")).not.toThrow();
    expect(() => commandGate("/todo")).not.toThrow();
    expect(() => commandGate("帮我总结一下 /clear 的用法")).not.toThrow();
  });
});

describe("api.setPromptGate（prompt 链路集成）", () => {
  test("注册的拦截门在 fetch 之前生效", async () => {
    setPromptGate(commandGate);
    try {
      await api.prompt("sess-1", { text: "/clear" });
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("command_unsupported");
    } finally {
      setPromptGate(null);
    }
  });

  test("放行的命令进入请求层（测试环境无服务端，落在 network 错误）", async () => {
    setPromptGate(() => {});
    try {
      await api.prompt("sess-1", { text: "/init" });
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("network");
    } finally {
      setPromptGate(null);
    }
  });
});
