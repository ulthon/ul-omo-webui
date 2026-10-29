// 中断逃逸口真值表（docs08-r6 任务 6 ①）：停止钮可见性 = queueAvailable ||
// runState running/waiting || hasPendingQuestion（保守并集，宁多勿少）。
// 桌面/手机双档经同一 stopButtonNode 工厂——matchMedia 桩切档（anchored-panel 惯例），
// renderToStaticMarkup 静态断言（无定时器/无网络，按构造无抖动）。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Composer } = await import("@/components/composer/composer");
const { useSessionsStore } = await import("@/stores/sessions");
const { useQuestionsStore } = await import("@/stores/questions");

const SID = "qa-interrupt-1";
const SHEET_QUERY = "(max-width: 639.98px)";

const REAL_MATCH_MEDIA = window.matchMedia.bind(window);

function stubMatchMedia(compact: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: compact && query === SHEET_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

function setRunState(state: "running" | "waiting" | "idle" | "error" | undefined): void {
  useSessionsStore.setState((s) => {
    const runStates = { ...s.runStates };
    if (state === undefined) delete runStates[SID];
    else runStates[SID] = state;
    return { runStates };
  });
}

/** 未决提问入队（q1 wire 形态经 store 语义化后的最小请求体） */
function setPendingQuestion(pending: boolean): void {
  useQuestionsStore.setState((s) => {
    const bySession = { ...s.bySession };
    if (pending) {
      bySession[SID] = [
        {
          id: "q-frame-1",
          waitForAnswer: true,
          questions: [
            {
              id: "q1",
              header: "Deploy",
              question: "Which environment?",
              options: [{ label: "staging" }, { label: "production" }],
              multiSelect: false,
            },
          ],
          deadlineAtMs: Date.now() + 30 * 60_000,
          timeout: 30 * 60_000,
          askedAtMs: Date.now(),
          anchorEntryId: null,
        },
      ];
    } else {
      delete bySession[SID];
    }
    return { bySession };
  });
}

function renderComposer(queueAvailable: boolean): string {
  return renderToStaticMarkup(
    createElement(Composer, {
      sessionId: SID,
      queueAvailable,
      permissionLocked: false,
      hydrationLocked: false,
      onSent: () => {},
      onAborted: () => {},
    }),
  );
}

beforeEach(() => {
  setRunState(undefined);
  setPendingQuestion(false);
});

afterEach(() => {
  window.matchMedia = REAL_MATCH_MEDIA;
  setRunState(undefined);
  setPendingQuestion(false);
});

describe("中断逃逸口真值表（桌面档）", () => {
  test("全空闲（queueAvailable=false / runState 未知 / 无提问）→ 无中断钮（基线不变）", () => {
    const html = renderComposer(false);
    expect(html).not.toContain('data-testid="abort-btn"');
  });

  test("runState=idle 且无提问 → 无中断钮（idle 不计入并集）", () => {
    setRunState("idle");
    const html = renderComposer(false);
    expect(html).not.toContain('data-testid="abort-btn"');
  });

  test("runState=error 且无提问 → 无中断钮（仅 running/waiting 计入）", () => {
    setRunState("error");
    const html = renderComposer(false);
    expect(html).not.toContain('data-testid="abort-btn"');
  });

  test("runState=waiting 且无流式态 → 中断钮（验收：waiting 态渲染中断钮）", () => {
    setRunState("waiting");
    const html = renderComposer(false);
    expect(html).toContain('data-testid="abort-btn"');
  });

  test("runState=running 且无流式态 → 中断钮", () => {
    setRunState("running");
    const html = renderComposer(false);
    expect(html).toContain('data-testid="abort-btn"');
  });

  test("runState=idle（SSE 帧丢失后脱同步）+ 未决提问 → 中断钮（保守并集宁多勿少）", () => {
    setRunState("idle");
    setPendingQuestion(true);
    const html = renderComposer(false);
    expect(html).toContain('data-testid="abort-btn"');
  });

  test("runState 未知 + 未决提问 → 中断钮", () => {
    setPendingQuestion(true);
    const html = renderComposer(false);
    expect(html).toContain('data-testid="abort-btn"');
  });

  test("queueAvailable=true（既有流式/已知运行态）→ 中断钮（原行为不回归）", () => {
    const html = renderComposer(true);
    expect(html).toContain('data-testid="abort-btn"');
    expect(html).toContain('data-testid="queue-mode-btn"');
  });

  test("仅未决提问（queueAvailable=false）→ 有中断钮但无排队模式钮（排队语义不随提问扩展）", () => {
    setPendingQuestion(true);
    const html = renderComposer(false);
    expect(html).toContain('data-testid="abort-btn"');
    expect(html).not.toContain('data-testid="queue-mode-btn"');
  });
});

describe("中断逃逸口真值表（手机胶囊档）", () => {
  test("runState=waiting → 胶囊档渲染中断钮（双档都出）", () => {
    stubMatchMedia(true);
    setRunState("waiting");
    const html = renderComposer(false);
    expect(html).toContain('data-testid="composer-capsule"');
    expect(html).toContain('data-testid="abort-btn"');
  });

  test("仅未决提问 → 胶囊档渲染中断钮（双档保守并集）", () => {
    stubMatchMedia(true);
    setPendingQuestion(true);
    const html = renderComposer(false);
    expect(html).toContain('data-testid="composer-capsule"');
    expect(html).toContain('data-testid="abort-btn"');
    expect(html).not.toContain('data-testid="queue-mode-btn"');
  });

  test("全空闲 → 胶囊档无中断钮（手机档不放宽基线）", () => {
    stubMatchMedia(true);
    const html = renderComposer(false);
    expect(html).toContain('data-testid="composer-capsule"');
    expect(html).not.toContain('data-testid="abort-btn"');
  });
});
