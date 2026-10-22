// 快捷键帮助对话框（docs08-r7 任务 12）：分组列出现有快捷键，条目与触发判定
// 唯一来源在 lib/shortcuts.ts 注册表（handler 与本组件共用，键串零复制）。
// 对话框语义复用 ui/dialog.tsx（radix：role=dialog/焦点圈/Escape 关闭/aria-labelledby），
// 不自造焦点管理。触发 hook 在 lib/use-shortcuts-help.ts（shell 挂载）；
// 开关状态落 ui store（顶栏帮助钮与全局键触发共用，modelPickerOpen 先例）。
import { SHORTCUT_GROUPS } from "@/lib/shortcuts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/i18n/i18n";

/** 帮助对话框：注册表驱动渲染（注册表空则仅剩标题，不崩）；条目数随注册表走。 */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
          <DialogDescription>{t("shortcuts.description")}</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 max-h-[60vh] overflow-y-auto px-1">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.id} className="mt-2 first:mt-0" data-testid={`shortcut-group-${group.id}`}>
              <h3 className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground">
                {t(group.titleKey)}
              </h3>
              <ul>
                {group.entries.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-3 rounded-md py-1"
                    data-testid={`shortcut-entry-${entry.id}`}
                  >
                    <span className="text-sm">{t(entry.descKey)}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {entry.keys.map((combo) => (
                        <kbd
                          key={combo}
                          className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] leading-4 text-muted-foreground"
                        >
                          {combo}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
