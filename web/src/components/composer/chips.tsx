// 输入区模型 / 思考 chip（W2 todo 8）：工具条上的第二个模型选择面（顶栏下拉保留不动，
// 两处 provider 分组语义一致——此处镜像 topbar 的分组写法，不搬移其实现）。
// 模型 chip：点击弹可搜索列表（键入即过滤 provider/model），radix Popover 自带外部点击
// / Escape 关闭；打开态落 ui store modelPickerOpen，shell 的 Ctrl+P 远程置 true。
// 思考 chip：可选档 = 所选模型 supportedThinkingLevels ∩ 服务端可持久化档位
// （lib/thinking-level）；模型未下发该字段时整个 chip 不渲染（非禁用）。选择即写
// selectedThinkingLevel + 防抖 PATCH preferredThinkingLevel（latest-wins）。
import { useEffect, useMemo, useState } from "react";
import { Brain, Check, ChevronDown, Cpu, Star } from "lucide-react";
import type { ModelInfo } from "@/lib/api";
import { shortModelName } from "@/lib/api";
import { thinkingLevelOptions } from "@/lib/thinking-level";
import { scheduleModelPreferencePersist, scheduleThinkingPreferencePersist } from "@/lib/preferences";
import { t } from "@/i18n/i18n";
import { useUiStore } from "@/stores/ui";
import { Input } from "@/components/ui/input";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** 44px 触控达标（min-h-11）；模型 chip 桌面限宽、窄屏 36vw 收敛，档位 chip 内容短 */
const CHIP_CLASS =
  "flex min-h-11 min-w-0 items-center gap-1 rounded-lg border border-input bg-background px-2 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";

/** provider 分组（与 topbar 模型下拉同款镜像） */
function groupByProvider(models: ModelInfo[]): Array<[string, ModelInfo[]]> {
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }
  return [...byProvider.entries()];
}

/** 搜索过滤：provider/model 整串子串（大小写不敏感） */
function matchQuery(m: ModelInfo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${m.provider}/${m.id}`.toLowerCase().includes(needle);
}

/** 模型选择弹层面板（ModelChip 与 CapsuleModelTag 共用）：搜索 + provider 分组列表 */
function ModelPickerBody({ close }: { close: () => void }) {
  const models = useUiStore((s) => s.models);
  const favoriteModels = useUiStore((s) => s.favoriteModels);
  const selectedModel = useUiStore((s) => s.selectedModel);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => groupByProvider(models.filter((m) => matchQuery(m, query))), [models, query]);
  // 收藏组：CLI settings.json 收藏置顶（"provider/model" 归一值直渲染，不在 models
  // 列表也照常展示——自定义模型未同步时仍可选中）；命中搜索词时按整串过滤
  const favList = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? favoriteModels.filter((v) => v.toLowerCase().includes(needle)) : favoriteModels;
  }, [favoriteModels, query]);

  const selectModel = (value: string) => {
    if (useUiStore.getState().selectedModel === value) return;
    useUiStore.getState().setSelectedModel(value);
    scheduleModelPreferencePersist();
  };

  return (
    <>
      <div className="border-b p-1">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("composer.chips.searchPlaceholder")}
          data-testid="model-chip-search"
          className="h-8 text-sm"
        />
      </div>
      <div className="max-h-72 overflow-y-auto">
        {groups.length === 0 && favList.length === 0 && (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground" data-testid="model-chip-empty">
            {t("composer.chips.noMatch")}
          </p>
        )}
        {favList.length > 0 && (
          <div>
            <div className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground">
              <Star className="size-3" />
              {t("composer.chips.favorites")}
            </div>
            {favList.map((value) => (
              <button
                key={`fav-${value}`}
                type="button"
                data-testid="model-chip-fav-item"
                data-value={value}
                title={value}
                onClick={() => {
                  selectModel(value);
                  close();
                }}
                className="flex min-h-9 w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-none transition-colors hover:bg-accent"
              >
                <Check
                  className={`size-4 shrink-0 ${selectedModel === value ? "opacity-100" : "opacity-0"}`}
                />
                <span className="ml-1 truncate">{value.slice(value.indexOf("/") + 1)}</span>
              </button>
            ))}
          </div>
        )}
        {groups.map(([provider, list]) => (
          <div key={provider}>
            <div className="px-2 py-1 text-[11px] text-muted-foreground" title={provider}>
              {provider}
            </div>
            {list.map((m) => {
              const value = `${m.provider}/${m.id}`;
              return (
                <button
                  key={value}
                  type="button"
                  data-testid="model-chip-item"
                  data-value={value}
                  title={value}
                  onClick={() => {
                    selectModel(value);
                    close();
                  }}
                  className="flex min-h-9 w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-none transition-colors hover:bg-accent"
                >
                  <Check
                    className={`size-4 shrink-0 ${selectedModel === value ? "opacity-100" : "opacity-0"}`}
                  />
                  <span className="ml-1 truncate">{m.id}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}

export function ModelChip() {
  const models = useUiStore((s) => s.models);
  const modelsLoaded = useUiStore((s) => s.modelsLoaded);
  const selectedModel = useUiStore((s) => s.selectedModel);
  const open = useUiStore((s) => s.modelPickerOpen);
  const setOpen = useUiStore((s) => s.setModelPickerOpen);

  // 卸载即复位打开态：切走「对话」页签等场景下 Ctrl+P 置位的残留不在回页时突然弹出
  useEffect(() => () => useUiStore.getState().setModelPickerOpen(false), []);

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

/** 手机胶囊模型浮签（docs08 2026-10-15 手机端模型可见性缺口 ①③）：常驻于胶囊右上角的
 * 小徽标，显示当前模型短名，点开直达选择弹层（与 ModelChip 共用 modelPickerOpen——
 * 两触发器按断点互斥挂载：手机档 ModelChip 不上工具行，弹层永不双开）。替代原
 * "+"展开行里的 ModelChip（聚焦自动收起导致收起态全界面无模型信息）。 */
export function CapsuleModelTag() {
  const models = useUiStore((s) => s.models);
  const modelsLoaded = useUiStore((s) => s.modelsLoaded);
  const selectedModel = useUiStore((s) => s.selectedModel);
  const open = useUiStore((s) => s.modelPickerOpen);
  const setOpen = useUiStore((s) => s.setModelPickerOpen);

  // 卸载即复位（与 ModelChip 同款；桌面↔手机断点切换时防残留打开态）
  useEffect(() => () => useUiStore.getState().setModelPickerOpen(false), []);

  const noModels = modelsLoaded && models.length === 0;
  const full = selectedModel ?? (models.length > 0 ? `${models[0].provider}/${models[0].id}` : null);
  const label = noModels ? t("composer.chips.noModelShort") : full !== null ? shortModelName(full) : "…";

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
          data-testid="capsule-model-tag"
          disabled={noModels}
          aria-label={t("composer.chips.currentModelAria", { model: full ?? "" })}
          title={full ?? undefined}
          className="flex max-w-[38vw] items-center gap-0.5 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] leading-none text-muted-foreground shadow-sm transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
        >
          <Cpu className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-2.5 shrink-0" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0" data-testid="model-picker-popover">
        <ModelPickerBody close={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

export function ThinkingChip() {
  const models = useUiStore((s) => s.models);
  const selectedModel = useUiStore((s) => s.selectedModel);
  const selectedThinkingLevel = useUiStore((s) => s.selectedThinkingLevel);

  const selectedModelInfo = useMemo(
    () => models.find((m) => `${m.provider}/${m.id}` === selectedModel) ?? null,
    [models, selectedModel],
  );
  const options = useMemo(() => thinkingLevelOptions(selectedModelInfo), [selectedModelInfo]);

  // 模型未下发 supportedThinkingLevels（或过滤后为空）→ 整体不渲染（非禁用）
  if (options.length === 0) return null;

  const select = (level: string) => {
    useUiStore.getState().setSelectedThinkingLevel(level);
    scheduleThinkingPreferencePersist();
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="thinking-chip"
          title={t("composer.chips.thinkingTitle", { level: selectedThinkingLevel ?? t("composer.chips.defaultLevel") })}
          className={`${CHIP_CLASS} shrink`}
        >
          <Brain className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate" data-testid="thinking-chip-label">
            {selectedThinkingLevel ?? t("composer.chips.defaultLevel")}
          </span>
          <ChevronDown className="size-3 shrink-0" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 p-1" data-testid="thinking-picker-popover">
        {options.map((level) => (
          <PopoverClose key={level} asChild>
            <button
              type="button"
              data-testid="thinking-chip-item"
              data-value={level}
              onClick={() => select(level)}
              className="flex min-h-9 w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-none transition-colors hover:bg-accent"
            >
              <Check
                className={`size-4 shrink-0 ${selectedThinkingLevel === level ? "opacity-100" : "opacity-0"}`}
              />
              <span className="ml-1">{level}</span>
            </button>
          </PopoverClose>
        ))}
      </PopoverContent>
    </Popover>
  );
}
