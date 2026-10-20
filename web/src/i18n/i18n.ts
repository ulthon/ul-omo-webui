// i18n 基建：语言 store、t() 取词插值、相对时间与整数格式化。
// 双静态 import（禁懒加载防首帧闪烁）；模块顶层不触碰 document/navigator/localStorage。
import { create } from "zustand";
import { zh } from "./zh";
import { en } from "./en";

export const SUPPORTED = ["zh-CN", "en"] as const;
export type Locale = (typeof SUPPORTED)[number];

/** 词条形态：纯字符串 | 插值函数 | 复数形（one/other） */
export type MessageEntry =
  | string
  | ((vars: Record<string, unknown>) => string)
  | { one: string; other: string };

/** 将字面量目录宽化为结构类型：键集锁定、值放宽为 MessageEntry 形态 */
type Widen<T> = T extends (vars: Record<string, unknown>) => string
  ? T
  : T extends { one: string; other: string }
    ? { one: string; other: string }
    : T extends string
      ? string
      : { [K in keyof T]: Widen<T[K]> };
export type MessageCatalogShape = Widen<typeof zh>;

type Leaf = MessageEntry;
type KeyPaths<T> = {
  [K in keyof T & string]: T[K] extends Leaf ? K : `${K}.${KeyPaths<T[K]>}`;
}[keyof T & string];
export type MessageKey = KeyPaths<MessageCatalogShape>;

/** 服务端 kv 键：界面语言档位（设置弹层改档即 PUT，字符串值契约；bootstrap 读取为准） */
export const LANGUAGE_KV = "ui.language";

/** localStorage 镜像键（下划线风格，与 events.ts 的 ul_omo_sse_transport / ul_omo_debug_sse
 * 同款）：仅作登录页等 kv 不可达场景的先行值缓存，权威存储是服务端 kv。 */
export const LOCALE_LS_KEY = "ul_omo_language";

interface LocaleState {
  locale: Locale;
  setLocale(locale: Locale): void;
}

export const useLocaleStore = create<LocaleState>()((set) => ({
  locale: "zh-CN",
  // 动作函数体内允许 typeof 守卫后访问 DOM/存储（模块顶层不得触碰）；失败静默——
  // 内存态已更新，权威 kv 由设置弹层的 PUT 负责，localStorage 仅镜像
  setLocale: (locale) => {
    set({ locale });
    try {
      if (typeof document !== "undefined") document.documentElement.lang = locale;
      if (typeof localStorage !== "undefined") localStorage.setItem(LOCALE_LS_KEY, locale);
    } catch {
      // 无 DOM/存储不可用（隐私模式、node 测试环境）：跳过副作用
    }
  },
}));

/** 解析任意存储值为受支持语言；缺失/非法返回 null（kv 值与 localStorage 值共用） */
export function parseLocale(raw: string | null | undefined): Locale | null {
  return (SUPPORTED as readonly string[]).includes(raw ?? "") ? (raw as Locale) : null;
}

/** 首帧语言检测（全惰性，typeof 守卫，只读不写）：localStorage 显式选择 →
 * navigator.language 前缀匹配（zh*→zh-CN，其余→en）→ 缺省 zh-CN。
 * 探测值不回写 localStorage——探测结果不冒充用户显式选择。 */
export function detectInitialLocale(): Locale {
  try {
    if (typeof localStorage !== "undefined") {
      const stored = parseLocale(localStorage.getItem(LOCALE_LS_KEY));
      if (stored) return stored;
    }
  } catch {
    // 存储不可用：继续 navigator 探测
  }
  try {
    if (typeof navigator !== "undefined") {
      const lang = (navigator.language ?? "").toLowerCase();
      if (lang.startsWith("zh")) return "zh-CN";
      if (lang) return "en";
    }
  } catch {
    // navigator 不可用：按缺省
  }
  return "zh-CN";
}

/** 首帧语言应用（kv 不可达场景，如登录页）：探测即设 store 与 document.lang，
 * 不落 localStorage（权威 kv 登录后由 bootstrap 校正）。调用方在首帧渲染前调用
 * （登录页模块加载即调），无闪烁（字典为双静态 import，同样无闪烁）。 */
export function applyInitialLocale(): void {
  const locale = detectInitialLocale();
  useLocaleStore.setState({ locale });
  try {
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  } catch {
    // 无 DOM 环境：仅 store 生效
  }
}

/** 按点分路径在目录中取词条；任一层缺失返回 undefined */
function pick(catalog: MessageCatalogShape, key: string): MessageEntry | undefined {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object" || !(part in (node as object))) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node as MessageEntry | undefined;
}

function interpolate(template: string, vars: Record<string, unknown> | undefined): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (raw, name: string) =>
    name in vars ? String(vars[name]) : raw,
  );
}

/** 缺键：dev 告警后回退 zh 值再回退键名；prod 静默。当前双语 satisfies 锁定，回退不可达。 */
export function t(key: MessageKey, vars?: Record<string, unknown>): string {
  const locale = useLocaleStore.getState().locale;
  const entry = (locale === "en" ? pick(en, key) : undefined) ?? pick(zh, key);
  if (entry === undefined) {
    if (import.meta.env.DEV) console.warn(`[i18n] 缺键: ${key}`);
    return key;
  }
  if (typeof entry === "string") return interpolate(entry, vars);
  if (typeof entry === "function") return entry(vars ?? {});
  const n = Number(vars?.n);
  const form = new Intl.PluralRules(locale === "en" ? "en" : "zh-CN").select(n);
  return interpolate(form === "one" ? entry.one : entry.other, vars);
}

/** 相对时间：60s/1h/24h/30d 阈值走 catalog 键；超 30 天走 Intl 日期；
 * 禁止依赖 Intl.RelativeTimeFormat 输出（zh 无空格/“前天”塌缩，与现文案不符）。 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const diff = now - at;
  if (diff < 60_000) return t("common.relJustNow");
  if (diff < 3_600_000) return t("common.relMinutes", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("common.relHours", { n: Math.floor(diff / 3_600_000) });
  if (diff < 30 * 86_400_000) return t("common.relDays", { n: Math.floor(diff / 86_400_000) });
  return new Intl.DateTimeFormat(useLocaleStore.getState().locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(at);
}

/** 整数按当前 locale 千分位格式化 */
export function fmtInt(n: number): string {
  return new Intl.NumberFormat(useLocaleStore.getState().locale).format(n);
}
