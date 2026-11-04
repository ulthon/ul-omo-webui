// 输入区模型 / 思考 chip（W2 todo 8）：顶栏下拉保留不动，两处 provider 分组语义一致
// ——镜像 topbar 的分组写法。2026-11-03 三稿：底栏双内联按钮落地后 ModelChip 无引用、
// ThinkingChip 退役删除，本文件仅存 ModelPickerBody 引用注释与 ModelChip 备用触发器。
// ModelChip 点击弹可搜索列表（radix Popover 外点/Escape 关闭），打开态落
// ui store modelPickerOpen，shell 的 Ctrl+L 远程置 true。
import { useEffect } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import { useT } from "@/i18n/i18n";
import { useUiStore } from "@/stores/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ModelPickerBody } from "./model-info";

/** 44px 触控达标（min-h-11）；模型 chip 桌面限宽、窄屏 36vw 收敛 */
const CHIP_CLASS =
  "flex min-h-11 min-w-0 items-center gap-1 rounded-lg border border-input bg-background px-2 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";

export function ModelChip() {
  const models = useUiStore((s) => s.models);
  const modelsLoaded = useUiStore((s) => s.modelsLoaded);
  const selectedModel = useUiStore((s) => s.selectedModel);
  const open = useUiStore((s) => s.modelPickerOpen);
  const setOpen = useUiStore((s) => s.setModelPickerOpen);

  // 卸载即复位打开态：切走「对话」页签等场景下 Ctrl+L（或无收藏时 Ctrl+P 兜底）置位的残留不在回页时突然弹出
  useEffect(() => () => useUiStore.getState().setModelPickerOpen(false), []);

  const t = useT();
  const noModels = modelsLoaded && models.length === 0;
  const label = noModels
    ? t("composer.chips.noModels")
    : (selectedModel ?? (models.length > 0 ? `${models[0].provider}/${models[0].id}` : t("composer.chips.loading")));

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="model-chip"
          disabled={noModels}
          title={selectedModel ?? undefined}
          className={`${CHIP_CLASS} max-w-[36vw] shrink sm:max-w-[220px]`}
        >
          <Cpu className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0" data-testid="model-picker-popover">
        <ModelPickerBody close={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
