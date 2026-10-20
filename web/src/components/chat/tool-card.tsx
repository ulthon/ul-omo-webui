// 工具调用卡片（todo 17）：名称 + 语义摘要（docs08-r4 任务 9：主标+副标按工具结构化，
// 状态徽标独立成右端 pill）+ 运行状态（转圈/完成/失败）+ 结果折叠展示（长结果截断 + "展开全部"）。
// 数据面：toolRuns[toolCallId]（tool_execution_start/end 事件驱动，todo 13 建）提供运行态与 args；
// entries 中 role=toolResult 的配对消息（content[].text + isError，message_start/end 定格）提供结果——
// 历史会话（GET messages 载入、无 toolRuns）与流式会话同一数据通路。
// omo todo 工具的 details.phases 结构化渲染归 todo 23，本组件只按通用卡片展示文本摘要；
// diff 视图（todo 19）：编辑类工具结果文本含 unified diff（```diff 围栏 / git diff 头 /
// @@ hunk 头启发式识别）时默认切 diff 渲染，可切回纯文本；解析不出结构的误判自动回退文本。
// 代码类工具（eval/bash）展开态直读原始代码/命令文本而非 JSON 包裹（codeTextOf，实样字段），
// 缺字段回落 prettyJson；未知工具类型（未登记的 toolName / 异形 args / 无结果）一律走通用兜底，不崩。
import { lazy, Suspense, useMemo, useState } from "react";
import { useMessagesStore } from "@/stores/messages";
import type { WireMessage } from "@/lib/api";
import { codeTextOf, RESULT_PREVIEW_CHARS, diffTextOf, prettyJson, resultTextOf, summarizeToolCall } from "./tool-card-data";
import { useT } from "@/i18n/i18n";
import { ChevronDown, CircleCheck, CircleX, Loader2, Wrench } from "lucide-react";

// W5-27 首屏拆分：diff 视图（react-diff-view）按需加载，未展开过 diff 的会话不下载该模块
const DiffView = lazy(() =>
  import("@/components/diff/diff-view").then((m) => ({ default: m.DiffView })),
);

/** entries 中按 toolCallId 反向找配对的 toolResult 消息（引用稳定：命中返回消息对象本身）。
 *  entry.type 两种来源：GET messages 定格条目为 "message"，SSE 实时入列为 wire 原样 "message_start"/"message_end"。 */
function findToolResultMessage(entries: { type: string; message?: unknown }[], toolCallId: string): WireMessage | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" && entry.type !== "message_start" && entry.type !== "message_end") continue;
    const msg = entry.message as WireMessage | undefined;
    if (msg && msg.role === "toolResult" && msg.toolCallId === toolCallId) return msg;
  }
  return null;
}

export function ToolCard({
  sessionId,
  toolCallId,
  name,
  args: partArgs,
  live,
}: {
  sessionId: string;
  toolCallId: string;
  name: string;
  /** part.arguments（定格消息自带）；运行期以 toolRuns.args（事件确认）优先 */
  args?: unknown;
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [resultMode, setResultMode] = useState<"diff" | "text">("diff");
  const run = useMessagesStore((s) => s.bySession[sessionId]?.toolRuns[toolCallId]);
  const resultMessage = useMessagesStore((s) => {
    const entries = s.bySession[sessionId]?.entries;
    return entries ? findToolResultMessage(entries, toolCallId) : null;
  });

  const t = useT();
  const args = run && run.args != null ? run.args : (partArgs ?? null);
  const isError = resultMessage?.isError === true;
  const resultText = resultTextOf(resultMessage, run?.result);
  const hasResult = resultText.length > 0;
  // 运行中：有在途 run 或 live 且尚无任何结果；历史消息无结果也按完成处理（不空转）
  const running = !isError && !hasResult && (run?.status === "running" || live);
  // 语义摘要（docs08-r4 任务 9）：primary/secondary/kind 按工具结构化；result 供 task_id 与变更概要
  const summary = useMemo(() => summarizeToolCall(name, args, resultMessage), [name, args, resultMessage]);
  // 代码类展开态直读原始代码/命令文本（eval.code / bash.command），缺字段回落 prettyJson
  const codeText = summary.kind === "code" ? codeTextOf(args) : "";
  const argsPretty = args == null ? "" : prettyJson(args);
  const clipped = !showFull && resultText.length > RESULT_PREVIEW_CHARS;
  // 结果含可解析的 unified diff 时默认切 diff 渲染（todo 19）：
  // details.patch（引擎 edit 类工具结构化字段）优先，结果文本 diff 形态启发式兜底；
  // 误判（解析为空）自动回退纯文本。判定逻辑在 tool-card-data.diffTextOf（单测覆盖）。
  const diffText = useMemo(() => diffTextOf(resultMessage, resultText), [resultMessage, resultText]);
  const showDiff = diffText != null && resultMode === "diff";

  return (
    <div
      data-tool-call={toolCallId}
      className={`my-1.5 overflow-hidden rounded-lg border text-sm ${
        isError ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/20"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-xs font-medium">{name}</span>
        {summary.chip && (
          <span className="shrink-0 rounded border bg-muted/40 px-1 py-px font-mono text-[10px] leading-4 text-muted-foreground">
            {summary.chip}
          </span>
        )}
        {/* 摘要区（docs08-r4 任务 9）：主标正常字重 + 副标 muted 小字，纵向堆叠、各自截断 */}
        <span className="min-w-0 flex-1">
          {summary.primary && <span className="block truncate text-xs text-foreground/90">{summary.primary}</span>}
          {summary.secondary && <span className="block truncate text-[11px] text-muted-foreground">{summary.secondary}</span>}
        </span>
        {/* 状态徽标独立：右端 pill，运行中/失败/完成语义不变（docs08-r4 任务 9 视觉分组） */}
        <span
          className={`flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs ${
            isError ? "border-destructive/30 text-destructive" : "border-border text-muted-foreground"
          } ${running ? "animate-pulse" : ""}`}
        >
          {running ? (
            <Loader2 className="size-3 shrink-0 animate-spin" />
          ) : isError ? (
            <CircleX className="size-3 shrink-0" />
          ) : (
            <CircleCheck className="size-3 shrink-0" />
          )}
          {running ? t("chat.toolcard.statusRunning") : isError ? t("chat.toolcard.statusFailed") : t("chat.toolcard.statusDone")}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {argsPretty || codeText ? (
            <section>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground/80">{codeText ? t("chat.toolcard.code") : t("chat.toolcard.args")}</div>
              <pre className="max-h-40 overflow-y-auto rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
                {codeText || argsPretty}
              </pre>
            </section>
          ) : null}
          <section>
            <div className="mb-1 flex items-center gap-2">
              <div className="text-[11px] font-medium text-muted-foreground/80">{t("chat.toolcard.result")}</div>
              {diffText != null && (
                <div role="group" aria-label={t("chat.toolcard.resultViewToggle")} className="flex items-center rounded-md border p-0.5">
                  {(["diff", "text"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={resultMode === mode}
                      onClick={() => setResultMode(mode)}
                      className={`min-h-9 rounded px-1.5 text-[11px] transition-colors lg:min-h-6 ${
                        resultMode === mode
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      {mode === "diff" ? "Diff" : t("chat.toolcard.textView")}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {hasResult ? (
              showDiff ? (
                <div
                  data-testid="tool-diff-view"
                  className="max-h-64 overflow-y-auto rounded-md bg-muted/20 p-1.5"
                >
                  <Suspense fallback={<div className="p-2 text-xs text-muted-foreground">{t("chat.toolcard.loadingDiff")}</div>}>
                    <DiffView diffText={diffText} />
                  </Suspense>
                </div>
              ) : (
                <>
                  <pre className="max-h-64 overflow-y-auto rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
                    {showFull ? resultText : `${resultText.slice(0, RESULT_PREVIEW_CHARS)}${clipped ? "…" : ""}`}
                  </pre>
                  {resultText.length > RESULT_PREVIEW_CHARS ? (
                    <button
                      type="button"
                      onClick={() => setShowFull((v) => !v)}
                      aria-expanded={showFull}
                      className="mt-0.5 inline-flex min-h-11 items-center gap-1 text-xs text-primary transition-colors hover:underline"
                    >
                      {showFull ? t("chat.toolcard.collapse") : t("chat.toolcard.expand")}
                    </button>
                  ) : null}
                </>
              )
            ) : (
              <div className="text-xs text-muted-foreground/70">
                {running ? t("chat.toolcard.waiting") : isError ? t("chat.toolcard.noResult") : t("chat.toolcard.noTextResult")}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
