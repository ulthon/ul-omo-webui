// 语言检测与持久化接线单测（任务2）：detectInitialLocale 三分支 + 缺省、parseLocale、
// setLocale 副作用同步（document.lang + localStorage 镜像）、登录页首帧先行值（模块
// 加载即生效且不落 localStorage）。
// vitest node 环境无 document/localStorage 实现，统一 vi.stubGlobal 最小桩；每个用例
// 前后重置桩与 store——桩串扰（脏状态）是本组测试的主要风险。
// 全部注入假 navigator/localStorage，无任何定时等待，确定性。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  LOCALE_LS_KEY,
  detectInitialLocale,
  parseLocale,
  useLocaleStore,
} from "@/i18n/i18n";

/** 最小 localStorage 桩：Map 存取（返回 map 以便断言写入与否） */
function stubLocalStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => void map.clear(),
  });
  return map;
}

/** 最小 navigator 桩：language 缺省时给无字段对象（探测走"缺省"分支） */
function stubNavigator(language?: string) {
  vi.stubGlobal("navigator", language === undefined ? {} : { language });
}

/** 最小 document 桩：仅 documentElement.lang 一条读写面 */
function stubDocument() {
  const doc = { documentElement: { lang: "zh-CN" } };
  vi.stubGlobal("document", doc);
  return doc;
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "zh-CN" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useLocaleStore.setState({ locale: "zh-CN" });
});

describe("detectInitialLocale 首帧检测顺序", () => {
  test("localStorage 显式选择优先于 navigator", () => {
    stubLocalStorage({ [LOCALE_LS_KEY]: "en" });
    stubNavigator("zh-CN");
    expect(detectInitialLocale()).toBe("en");
  });

  test("localStorage 非法值视为无显式选择，落到 navigator 分支", () => {
    stubLocalStorage({ [LOCALE_LS_KEY]: "fr" });
    stubNavigator("zh-TW");
    expect(detectInitialLocale()).toBe("zh-CN");
  });

  test("navigator zh* 前缀归并 zh-CN（zh-TW 亦然）", () => {
    stubLocalStorage();
    stubNavigator("zh-TW");
    expect(detectInitialLocale()).toBe("zh-CN");
  });

  test("navigator 其余语言 → en", () => {
    stubLocalStorage();
    stubNavigator("fr-FR");
    expect(detectInitialLocale()).toBe("en");
  });

  test("两者皆无值 → 缺省 zh-CN", () => {
    stubLocalStorage();
    stubNavigator();
    expect(detectInitialLocale()).toBe("zh-CN");
  });
});

describe("parseLocale", () => {
  test("受支持值原样返回，缺失/非法返回 null", () => {
    expect(parseLocale("en")).toBe("en");
    expect(parseLocale("zh-CN")).toBe("zh-CN");
    expect(parseLocale("fr")).toBeNull();
    expect(parseLocale("")).toBeNull();
    expect(parseLocale(null)).toBeNull();
    expect(parseLocale(undefined)).toBeNull();
  });
});

describe("setLocale 副作用同步", () => {
  test("切换语言：store、document.documentElement.lang、localStorage 镜像三处一致", () => {
    const doc = stubDocument();
    const map = stubLocalStorage({ [LOCALE_LS_KEY]: "zh-CN" });
    useLocaleStore.getState().setLocale("en");
    expect(useLocaleStore.getState().locale).toBe("en");
    expect(doc.documentElement.lang).toBe("en");
    expect(map.get(LOCALE_LS_KEY)).toBe("en");
    // 往返切回同样三处一致
    useLocaleStore.getState().setLocale("zh-CN");
    expect(useLocaleStore.getState().locale).toBe("zh-CN");
    expect(doc.documentElement.lang).toBe("zh-CN");
    expect(map.get(LOCALE_LS_KEY)).toBe("zh-CN");
  });

  test("无 DOM 环境（node 测试缺省）：仅 store 更新，不抛错", () => {
    expect((globalThis as { document?: unknown }).document).toBeUndefined();
    expect(() => useLocaleStore.getState().setLocale("en")).not.toThrow();
    expect(useLocaleStore.getState().locale).toBe("en");
  });
});

describe("登录页首帧先行值", () => {
  test("login 模块加载即应用探测值：store 与 document.lang 首帧为 en，且不落 localStorage", async () => {
    const doc = stubDocument();
    const map = stubLocalStorage(); // 无显式选择
    stubNavigator("en-US");
    // 动态 import：login 模块顶层的 applyInitialLocale() 在求值时执行（首帧渲染前）。
    // 静态 import 会被 vitest 提升到 stubGlobal 之前，无法覆盖本场景。
    await import("@/pages/login");
    expect(useLocaleStore.getState().locale).toBe("en");
    expect(doc.documentElement.lang).toBe("en");
    expect(map.get(LOCALE_LS_KEY)).toBeUndefined(); // 探测值不冒充显式选择
  });
});
