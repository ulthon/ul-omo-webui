// 斜杠输入提示纯逻辑单测（docs08-r3 任务 19）：触发判定、三段过滤（含四不支持命令
// 排除）、扁平序、首 token 替换。UI 行为（开合/Esc 回退/键盘导航）走浏览器 QA。
import { describe, expect, test } from "vitest";
import type { CommandsResponse } from "@/lib/api";
import {
  EMPTY_SLASH_GROUPS,
  filterSlashGroups,
  flattenSlashItems,
  slashReplaceToken,
  slashTriggerToken,
} from "@/components/composer/composer-logic";

const res = (partial: Partial<CommandsResponse["commands"]>): CommandsResponse => ({
  project: "/p",
  available: true,
  commands: {
    extension: [],
    skill: [],
    prompt: [],
    ...partial,
  },
});

describe("slashTriggerToken", () => {
  test("/ 开头且首 token 未闭合（无空白）时返回 token；裸斜杠返回空串", () => {
    expect(slashTriggerToken("/")).toBe("");
    expect(slashTriggerToken("/ini")).toBe("ini");
    expect(slashTriggerToken("/skill:ast-grep")).toBe("skill:ast-grep");
  });

  test("首 token 闭合（空白）或非斜杠开头或空文本返回 null（下拉关闭）", () => {
    expect(slashTriggerToken("/init now")).toBeNull();
    expect(slashTriggerToken("/ ")).toBeNull();
    expect(slashTriggerToken("hi /ini")).toBeNull();
    expect(slashTriggerToken("")).toBeNull();
    expect(slashTriggerToken("普通消息/ini")).toBeNull();
  });
});

describe("filterSlashGroups", () => {
  const data = res({
    extension: [
      { name: "init", source: "extension", description: "Initialize" },
      { name: "clear", source: "extension" },
      { name: "new", source: "extension" },
      { name: "undo", source: "extension" },
      { name: "history", source: "extension" },
    ],
    skill: [
      { name: "skill:ast-grep", source: "skill" },
      { name: "skill:git-master", source: "skill", description: "Git 操作" },
    ],
    prompt: [{ name: "doctor", source: "prompt" }],
  });

  test("裸 / 全量返回，不支持命令（clear/new/undo）一律不进列表；compact 由 webui 静态段提供（docs08-r5 任务 8）", () => {
    const groups = filterSlashGroups(data, "");
    // 顺序保持服务端给的序（前端不重排；服务端已按 name 排序）
    expect(groups.extension.map((r) => r.name)).toEqual(["init", "history"]);
    expect(groups.skill).toHaveLength(2);
    expect(groups.prompt).toHaveLength(1);
    const names = flattenSlashItems(groups).map((r) => r.name);
    for (const banned of ["clear", "new", "undo"]) {
      expect(names).not.toContain(banned);
    }
    // compact 不在引擎枚举（spike 实证 75 条无命中），由 webui 静态段补挂且标注来源
    const webui = groups.webui;
    expect(webui.map((r) => r.section)).toEqual(["webui"]);
    expect(webui.map((r) => r.name)).toEqual(["compact"]);
    expect(webui[0]?.description).toContain("引擎协议直调");
    // 若引擎侧未来注册同名命令，webui 静态段去重不重复展示
    const withEngineCompact = res({
      extension: [{ name: "compact", source: "extension" }],
      skill: [],
      prompt: [],
    });
    expect(filterSlashGroups(withEngineCompact, "").webui).toEqual([]);
    expect(filterSlashGroups(withEngineCompact, "").extension.map((r) => r.name)).toEqual(["compact"]);
  });

  test("token 前缀过滤三段；技能行对去 skill: 前缀短名同样命中", () => {
    expect(filterSlashGroups(data, "in").extension.map((r) => r.name)).toEqual(["init"]);
    expect(filterSlashGroups(data, "ast").skill.map((r) => r.name)).toEqual(["skill:ast-grep"]);
    expect(filterSlashGroups(data, "skill:g").skill.map((r) => r.name)).toEqual(["skill:git-master"]);
    expect(filterSlashGroups(data, "doc").prompt.map((r) => r.name)).toEqual(["doctor"]);
  });

  test("无命中返回空段组（空段不渲染的判定在渲染层）", () => {
    expect(filterSlashGroups(data, "zzz")).toEqual(EMPTY_SLASH_GROUPS);
  });

  test("降级数据（available=false 空三段）：引擎三段为空，webui 静态段不受降级影响（不依赖引擎）", () => {
    const empty = res({});
    const groups = filterSlashGroups(empty, "");
    expect(groups.extension).toEqual([]);
    expect(groups.skill).toEqual([]);
    expect(groups.prompt).toEqual([]);
    expect(groups.webui.map((r) => r.name)).toEqual(["compact"]);
  });
});

describe("flattenSlashItems", () => {
  test("扁平序 = 段序 extension → skill → prompt → webui（与渲染一致，键盘导航共享下标）", () => {
    const groups = filterSlashGroups(
      res({
        extension: [{ name: "init", source: "extension" }],
        skill: [{ name: "skill:git-master", source: "skill" }],
        prompt: [{ name: "doctor", source: "prompt" }],
      }),
      "",
    );
    expect(flattenSlashItems(groups).map((r) => `${r.section}:${r.name}`)).toEqual([
      "extension:init",
      "skill:skill:git-master",
      "prompt:doctor",
      "webui:compact",
    ]);
  });
});

describe("slashReplaceToken", () => {
  test("首 token 替换为 /<name> 含尾部空格；其余输入保留", () => {
    expect(slashReplaceToken("/ini", "init")).toBe("/init ");
    expect(slashReplaceToken("/", "help")).toBe("/help ");
    expect(slashReplaceToken("/ski", "skill:git-master")).toBe("/skill:git-master ");
  });

  test("首 token 闭合后的输入不参与替换（触发条件已关面板，防御性保留其余文本）", () => {
    expect(slashReplaceToken("/ini 已有参数", "init")).toBe("/init  已有参数");
  });
});
