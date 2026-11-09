// 底栏模型区 + 模型选择弹层面板（2026-11-03 胶囊退役迁移；同日二稿：胶囊形态被用户
// 否决，重设计为 openchamber 同款内联文本控件——无边框无背景，仅 muted 文本 + hover
// 提亮）：弹层面板（搜索 + provider 分组 + 收藏组）与底栏模型信息区共用一处。
// 三稿（2026-11-03 底栏重做，用户截图反馈整块观感差）：模型名与思考档拆成两个并列
// 的内联文字按钮（同组同风格，均 muted 小字号 + hover 提亮，无盒装/边框/背景块/紫色）：
// 「模型短名 ▾」开 ModelPickerBody 弹层（不自动聚焦搜索框，防手机拉起键盘），
// 「档位 ▾」开思考档小弹层可直接切换（原 ThinkingChip 退役）。preset 提示迁总览面板
// （2026-11-03 用户定版），composer 不再显示；待生效 (待生效) 后缀保留。
// docs08-r6 任务 8 ④ 的待生效黄标语义原样平移：pendingEffect 由 Composer 按
// 「选中 ≠ 生效」判定后传入。
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Star } from "lucide-react";
import type { ModelInfo } from "@/lib/api";
import { shortModelName } from "@/lib/api";
import { thinkingLevelOptions } from "@/lib/thinking-level";
import { diag } from "@/lib/diag";
import { scheduleThinkingPreferencePersist } from "@/lib/preferences";
import { selectModel, selectFavoriteModel } from "@/lib/model-cycle";
import { useT } from "@/i18n/i18n";
import { useUiStore } from "@/stores/ui";
import { useSessionsStore } from "@/stores/sessions";
import { Input } from "@/components/ui/input";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

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

/** 模型选择弹层面板（ModelChip 与 ComposerModelInfo 共用）：搜索 + provider 分组列表 */
export function ModelPickerBody({ close }: { close: () => void }) {
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

  const t = useT();
  // 选中逻辑油出 lib/model-cycle.selectModel（r9 2026-10-26 批次）：chip 点击与
  // shell Ctrl+P 循环走同一条「写选中 + 防抖持久化」路径

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
                  selectFavoriteModel(value);
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

/** 内联文字按钮同组风格：muted 小字号 + hover 提亮，无盒装（min-h-11 手机触控达标） */
const INLINE_BTN_CLASS =
  "flex min-h-11 min-w-0 items-center gap-1 rounded-md px-1 text-xs leading-none text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

/** 思考档小弹层（与原 ThinkingChip 同数据源：可选档 = supportedThinkingLevels ∩ 可
 * 持久化档位；弹层内选中态用 Check 对比，无紫色高亮） */
function ThinkingLevelMenu({
  options,
  selected,
  onSelect,
  children,
}: {
  options: string[];
  selected: string | null;
  onSelect: (level: string) => void;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="center" className="w-40 p-1" data-testid="thinking-picker-popover">
        {options.map((level) => (
          <PopoverClose key={level} asChild>
            <button
              type="button"
              data-testid="thinking-level-item"
              data-value={level}
              onClick={() => onSelect(level)}
              className="flex min-h-9 w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-none transition-colors hover:bg-accent"
            >
              <Check
                className={`size-4 shrink-0 ${selected === level ? "opacity-100" : "opacity-0"}`}
              />
              <span className="ml-1">{level}</span>
            </button>
          </PopoverClose>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** 底栏模型区（2026-11-03 三稿）：两个并列内联文字按钮——「模型短名 ▾」开模型选择
 * 弹层（modelPickerOpen 通道），「思考 · 档位 ▾」开思考档弹层可直接切换；preset
 * 提示已迁总览；待生效后缀挂模型钮。模型无可用档位时
 * 思考钮不渲染（与原 ThinkingChip 隐藏口径一致）。 */
export function ComposerModelInfo({ pendingEffect = false }: { pendingEffect?: boolean }) {
  const models = useUiStore((s) => s.models);
  const modelsLoaded = useUiStore((s) => s.modelsLoaded);
  const selectedModel = useUiStore((s) => s.selectedModel);
  const selectedThinkingLevel = useUiStore((s) => s.selectedThinkingLevel);
  const open = useUiStore((s) => s.modelPickerOpen);
  const setOpen = useUiStore((s) => s.setModelPickerOpen);

  // 卸载即复位打开态（断点切换防残留）
  useEffect(() => () => useUiStore.getState().setModelPickerOpen(false), []);

  const t = useT();
  const noModels = modelsLoaded && models.length === 0;
  const full = selectedModel ?? (models.length > 0 ? `${models[0]!.provider}/${models[0]!.id}` : null);
  const label = noModels ? t("composer.chips.noModelShort") : full !== null ? shortModelName(full) : "…";
  const selectedModelInfo = models.find((m) => `${m.provider}/${m.id}` === selectedModel) ?? null;
  const levelOptions = useMemo(() => thinkingLevelOptions(selectedModelInfo), [selectedModelInfo]);
  const selectLevel = (level: string) => {
    // #23 观测埋点：思考档变更动作（档位随下次 prompt 生效，无引擎拒绝概念）。
    // 思考档三链 B：显式手选路径（pickThinkingLevel 置位）——引擎 thinking_level_changed
    // 回显不再覆盖手选显示。
    diag.info("run", "thinking", { level });
    // 来源分级日志（2026-11-10 思考档排查）：用户主动切换——old 取不到记 unknown
    diag.info("thinking-level", "user_change", {
      from: useUiStore.getState().selectedThinkingLevel ?? "unknown",
      to: level,
      session: useSessionsStore.getState().selectedId ?? "unknown",
    });
    useUiStore.getState().pickThinkingLevel(level);
    scheduleThinkingPreferencePersist();
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="composer-model-info"
            disabled={noModels}
            aria-label={t("composer.chips.currentModelAria", { model: full ?? "" })}
            title={full ?? undefined}
            className={`${INLINE_BTN_CLASS} max-w-[52vw] sm:max-w-[280px]`}
          >
            <span className="truncate">{label}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
            {pendingEffect && (
              <span
                data-testid="composer-model-pending"
                title={t("composer.chips.pendingEffect")}
                className="shrink-0 text-amber-600/90"
              >
                ({t("composer.chips.pendingEffect")})
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="center"
          className="w-72 p-0"
          data-testid="model-picker-popover"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <ModelPickerBody close={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
      {levelOptions.length > 0 && (
        <ThinkingLevelMenu options={levelOptions} selected={selectedThinkingLevel} onSelect={selectLevel}>
          <button
            type="button"
            data-testid="composer-level"
            title={t("composer.chips.thinkingTitle", { level: selectedThinkingLevel ?? t("composer.chips.defaultLevel") })}
            className={`${INLINE_BTN_CLASS} shrink-0`}
          >
            {/* 四稿后补（2026-11-03 手机反馈）：只显档位词，不加「思考」前缀；语义留给 title */}
            <span data-testid="composer-model-level">{selectedThinkingLevel ?? t("composer.chips.defaultLevel")}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
          </button>
        </ThinkingLevelMenu>
      )}
    </div>
  );
}
