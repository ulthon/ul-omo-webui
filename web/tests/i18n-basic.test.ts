// i18n 基建单测：t() 三种词条形态、formatRelativeTime 与既有文案逐字一致、
// 缺键回退链（en→zh→键名，as 绕过构造）、node 环境无 DOM 安全导入。
import { describe, expect, test, afterEach, vi } from "vitest";
import {
  SUPPORTED,
  t,
  fmtInt,
  formatRelativeTime,
  useLocaleStore,
  type MessageKey,
  type Locale,
} from "@/i18n/i18n";

afterEach(() => {
  useLocaleStore.setState({ locale: "zh-CN" });
});

describe("SUPPORTED 与类型", () => {
  test("支持语言列表为 zh-CN 与 en", () => {
    expect(SUPPORTED).toEqual(["zh-CN", "en"]);
  });
});

describe("t() 取词", () => {
  test("纯字符串：zh 默认与 en 切换", () => {
    expect(t("common.cancel")).toBe("取消");
    useLocaleStore.getState().setLocale("en");
    expect(t("common.cancel")).toBe("Cancel");
  });

  test("插值：{n} 被替换，缺变量保留原样", () => {
    expect(t("common.relMinutes", { n: 5 })).toBe("5 分钟前");
    expect(t("common.relMinutes")).toBe("{n} 分钟前");
  });

  test("复数形：en one/other 按 Intl.PluralRules 选择", () => {
    useLocaleStore.getState().setLocale("en");
    expect(t("common.itemCount", { n: 1 })).toBe("1 item");
    expect(t("common.itemCount", { n: 3 })).toBe("3 items");
  });

  test("缺键回退链 en→zh→键名：as 绕过构造缺键，dev 告警后返回键名", () => {
    useLocaleStore.getState().setLocale("en");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const missing = "common.nonexistent" as MessageKey;
      expect(t(missing)).toBe("common.nonexistent");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("formatRelativeTime（阈值分支与既有文案逐字一致）", () => {
  // 固定时间注入，不用 Date.now（确定性）
  const now = new Date("2026-10-20T12:00:00Z").getTime();

  test("一分钟内：刚刚", () => {
    expect(formatRelativeTime(new Date(now - 30_000).toISOString(), now)).toBe("刚刚");
  });

  test("分钟/小时/天：数字与单位之间带空格，与现文案逐字同", () => {
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5 分钟前");
    expect(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3 小时前");
    expect(formatRelativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe("2 天前");
  });

  test("非法输入返回占位符 —", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("—");
  });

  test("超过 30 天走 Intl 日期（zh-CN 短月份格式）", () => {
    expect(formatRelativeTime(new Date(now - 40 * 86_400_000).toISOString(), now)).not.toMatch(/^\d+ 天前$/);
  });

  test("en locale 输出英文文案", () => {
    useLocaleStore.getState().setLocale("en");
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5 minutes ago");
  });
});

describe("fmtInt", () => {
  test("整数按 locale 千分位格式化", () => {
    expect(fmtInt(1234567)).toBe("1,234,567");
  });
});

describe("模块导入安全（node 环境无 DOM）", () => {
  test("顶层不触碰 DOM 全局，直接导入不抛错", async () => {
    expect((globalThis as { document?: unknown }).document).toBeUndefined();
    await expect(import("@/i18n/i18n")).resolves.toBeTruthy();
  });

  test("setLocale 仅接受受支持语言（类型层锁定，运行时透传）", () => {
    useLocaleStore.getState().setLocale("en" as Locale);
    expect(useLocaleStore.getState().locale).toBe("en");
  });
});
