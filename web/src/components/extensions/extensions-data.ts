// 「扩展与凭证」分区纯函数（docs08-2026-10-22 批次任务 24）：分组、auth 徽标语义、
// 安装源校验。导出供单测（web/tests/extensions-ui.test.tsx）。
import type { AuthStatusResponse, ExtensionItem } from "@/lib/api";
import type { MessageKey } from "@/i18n/i18n";

export type ExtensionKind = ExtensionItem["kind"];

/** 分组：kind 固定序 extension → skill → prompt → package，组内保持服务端 name 序 */
export function groupByKind(items: ExtensionItem[]): Array<{ kind: ExtensionKind; items: ExtensionItem[] }> {
  const order: ExtensionKind[] = ["extension", "skill", "prompt", "package"];
  const map = new Map<ExtensionKind, ExtensionItem[]>();
  for (const it of items) {
    const list = map.get(it.kind) ?? [];
    list.push(it);
    map.set(it.kind, list);
  }
  return order
    .filter((k) => (map.get(k)?.length ?? 0) > 0)
    .map((kind) => ({ kind, items: map.get(kind) as ExtensionItem[] }));
}

export type AuthBadge = { key: MessageKey; className: string };

/** auth 三态徽标：ready 绿 / not_configured 中性 / error 红（checkedAt=null 未查过） */
export function authBadge(status: AuthStatusResponse | null): AuthBadge {
  if (status === null) return { key: "extensions.authChecking", className: "border-border bg-muted text-muted-foreground" };
  switch (status.status) {
    case "ready":
      return { key: "extensions.authReady", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
    case "not_configured":
      return { key: "extensions.authNotConfigured", className: "border-border bg-muted text-muted-foreground" };
    default:
      return { key: "extensions.authError", className: "border-destructive/40 bg-destructive/10 text-destructive" };
  }
}

/** 安装源校验：非空、无空白、须带协议前缀或本地路径（引擎接受 npm:/链接/路径；空白必炸） */
export function isValidSource(source: string): boolean {
  const s = source.trim();
  return s.length > 0 && !/\s/.test(s) && !s.includes("..");
}

/** 启停 state 键（settings.json extensionsState 的键形态） */
export function stateKey(kind: ExtensionKind, name: string): string {
  return `${kind}/${name}`;
}
