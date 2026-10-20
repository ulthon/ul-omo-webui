// 英文目录：satisfies 锁定与 zh 完全相同的键集（值可不同，键不可增删）。
import type { MessageCatalogShape } from "./i18n";

export const en = {
  common: {
    cancel: "Cancel",
    close: "Close",
    save: "Save",
    delete: "Delete",
    loadFailed: "Failed to load",
    loading: "Loading",
    relJustNow: "just now",
    relMinutes: "{n} minutes ago",
    relHours: "{n} hours ago",
    relDays: "{n} days ago",
    itemCount: { one: "{n} item", other: "{n} items" },
  },
} satisfies MessageCatalogShape;
