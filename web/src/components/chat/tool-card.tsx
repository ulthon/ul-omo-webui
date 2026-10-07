// 工具调用卡片（todo 17）：名称 + 参数摘要（折叠 JSON）+ 运行状态（转圈/完成/失败）
// + 结果折叠展示（长结果截断 + "展开全部"）。
// 数据面：toolRuns[toolCallId]（tool_execution_start/end 事件驱动，todo 13 建）提供运行态与 args；
// entries 中 role=toolResult 的配对消息（content[].text + isError，message_start/end 定格）提供结果——
// 历史会话（GET messages 载入、无 toolRuns）与流式会话同一数据通路。
// omo todo 工具的 details.phases 结构化渲染归 todo 23，本组件只按通用卡片展示文本摘要；
// 未知工具类型（未登记的 toolName / 异形 args / 无结果）一律走通用兜底，不崩。
import { useState } from "react";
import { useMessagesStore } from "@/stores/messages";
import type { WireMessage } from "@/lib/api";
import { RESULT_PREVIEW_CHARS, prettyJson, resultTextOf, summarizeArgs } from "./tool-card-data";
import { ChevronDown, CircleCheck, CircleX, Loader2, Wrench } from "lucide-react";

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
  const run = useMessagesStore((s) => s.bySession[sessionId]?.toolRuns[toolCallId]);
  const resultMessage = useMessagesStore((s) => {
    const entries = s.bySession[sessionId]?.entries;
    return entries ? findToolResultMessage(entries, toolCallId) : null;
  });

  const args = run && run.args != null ? run.args : (partArgs ?? null);
  const isError = resultMessage?.isError === true;
  const resultText = resultTextOf(resultMessage, run?.result);
  const hasResult = resultText.length > 0;
  // 运行中：有在途 run 或 live 且尚无任何结果；历史消息无结果也按完成处理（不空转）
  const running = !isError && !hasResult && (run?.status === "running" || live);
  const argsSummary = summarizeArgs(args);
  const argsPretty = args == null ? "" : prettyJson(args);
  const clipped = !showFull && resultText.length > RESULT_PREVIEW_CHARS;

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
        {argsSummary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{argsSummary}</span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <span
          className={`flex shrink-0 items-center gap-1 text-xs ${
            isError ? "text-destructive" : running ? "animate-pulse text-muted-foreground" : "text-muted-foreground"
          }`}
        >
          {running ? (
            <Loader2 className="size-3 shrink-0 animate-spin" />
          ) : isError ? (
            <CircleX className="size-3 shrink-0" />
          ) : (
            <CircleCheck className="size-3 shrink-0" />
          )}
          {running ? "运行中" : isError ? "失败" : "完成"}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {argsPretty ? (
            <section>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground/80">参数</div>
              <pre className="max-h-40 overflow-y-auto rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
                {argsPretty}
              </pre>
            </section>
          ) : null}
          <section>
            <div className="mb-1 text-[11px] font-medium text-muted-foreground/80">结果</div>
            {hasResult ? (
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
                    {showFull ? "收起结果" : "展开全部"}
                  </button>
                ) : null}
              </>
            ) : (
              <div className="text-xs text-muted-foreground/70">
                {running ? "等待工具返回…" : isError ? "（无结果文本）" : "（无文本结果）"}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
