// 提问卡片组件测试（q1）：渲染形态（选项/多选/倒计时/等待语义文案）、交互（选择/
// 提交应答载荷、空应答拦截、取消应答、超时禁用）。happy-dom + createRoot 惯例；
// fetch mock 捕获应答 POST。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { QuestionCard } = await import("@/components/chat/question-card");
const { useQuestionsStore } = await import("@/stores/questions");
const { useUiStore } = await import("@/stores/ui");

const ORIGINAL_FETCH = globalThis.fetch;
const SID = "sess-card-1";

interface Posted {
  url: string;
  body: Record<string, unknown>;
}

let posted: Posted[] = [];

async function render(ui: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function makeRequest(extra: Partial<Parameters<typeof useQuestionsStore.getState> extends never ? never : NonNullable<unknown>> & Record<string, unknown> = {}) {
  return {
    id: "q-card-1",
    waitForAnswer: true,
    questions: [
      {
        id: "q1",
        header: "Deploy",
        question: "Which environment?",
        options: [
          { label: "staging", description: "stage first" },
          { label: "production" },
        ],
        multiSelect: false,
      },
      {
        id: "q2",
        header: "Features",
        question: "Which features?",
        options: [
          { label: "auth" },
          { label: "dark-mode" },
          { label: "i18n" },
        ],
        multiSelect: true,
      },
    ],
    deadlineAtMs: Date.now() + 30 * 60_000,
    timeout: 30 * 60_000,
    ...extra,
  };
}

/** React 受控输入的原生赋值（绕过 value tracker 的去重，标准测试口径） */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(el: Element): Promise<void> {
  return act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function cardEl(container: ParentNode): HTMLElement {
  const el = container.querySelector("[data-testid=question-card]");
  if (!el) throw new Error("question-card 未渲染");
  return el as HTMLElement;
}

beforeEach(() => {
  posted = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    posted.push({
      url: String(_input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  useUiStore.setState({ toast: null });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("QuestionCard 渲染", () => {
  test("逐问渲染：header/问题/选项（含 description）、单选与多选并存", async () => {
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request: makeRequest(), position: 1, total: 1 }),
    );
    const card = cardEl(container);
    expect(card.textContent).toContain("Which environment?");
    expect(card.textContent).toContain("Which features?");
    expect(card.textContent).toContain("stage first");
    expect(card.querySelectorAll("[data-testid=question-option]")).toHaveLength(5);
    // waitForAnswer=true → 等待语义文案
    expect(card.textContent).toContain("等待回答");
    expect(card.querySelector("[data-testid=question-countdown]")!.textContent).toMatch(/^\d+:\d{2}$/);
    await unmount();
  });

  test("waitForAnswer=false → “可稍后回答”文案；多问时显示第 x/y 个", async () => {
    const { container, unmount } = await render(
      createElement(QuestionCard, {
        sessionId: SID,
        request: makeRequest({ waitForAnswer: false }),
        position: 2,
        total: 3,
      }),
    );
    const card = cardEl(container);
    expect(card.textContent).toContain("可稍后回答");
    expect(card.textContent).toContain("第 2/3 个待处理");
    await unmount();
  });

  test("过期（deadline 已过）→ 选项与提交禁用、显示已超时", async () => {
    const { container, unmount } = await render(
      createElement(QuestionCard, {
        sessionId: SID,
        request: makeRequest({ deadlineAtMs: Date.now() - 1000 }),
        position: 1,
        total: 1,
      }),
    );
    const card = cardEl(container);
    expect(card.textContent).toContain("已超时");
    const submit = card.querySelector("[data-testid=question-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const option = card.querySelector("[data-testid=question-option]") as HTMLButtonElement;
    expect(option.disabled).toBe(true);
    await unmount();
  });
});

describe("QuestionCard 交互", () => {
  test("单选点击选中、多选可多选、提交应答载荷形态（answers 键=问题 id，selected=label）", async () => {
    const request = makeRequest();
    useQuestionsStore.getState().pushRequest(SID, request);
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    const options = [...card.querySelectorAll("[data-testid=question-option]")] as HTMLButtonElement[];
    // 选项序：[0]=staging [1]=production（q1）；[2]=auth [3]=dark-mode [4]=i18n（q2）
    await click(options[0]); // q1: staging（单选）
    await click(options[2]); // q2: auth（多选）
    await click(options[3]); // q2: dark-mode（多选第二项）
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toContain(`/api/sessions/${SID}/permission`);
    expect(posted[0].body.requestId).toBe("q-card-1");
    expect(posted[0].body.answers).toEqual({
      q1: { selected: ["staging"] },
      q2: { selected: ["auth", "dark-mode"] },
    });
    // 应答成功后出队
    expect(useQuestionsStore.getState().bySession[SID] ?? []).toHaveLength(0);
    await unmount();
  });

  test("自由文本进 answers.text、全局 comment 一并提交", async () => {
    const request = makeRequest();
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    const text1 = card.querySelector("[data-testid=question-text-q1]") as HTMLInputElement;
    await act(async () => {
      setNativeValue(text1, "staging if possible");
    });
    const comment = card.querySelector("[data-testid=question-comment]") as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(comment, "尽快部署");
    });
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted[0].body.answers).toEqual({ q1: { selected: [], text: "staging if possible" } });
    expect(posted[0].body.comment).toBe("尽快部署");
    await unmount();
  });

  test("空应答本地拦截（不 POST，toast 提示）", async () => {
    const request = makeRequest();
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    await click(cardEl(container).querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(0);
    expect(useUiStore.getState().toast?.text).toContain("至少回答一个问题");
    await unmount();
  });

  test("忽略 → cancelled 应答并出队", async () => {
    const request = makeRequest();
    useQuestionsStore.getState().pushRequest(SID, request);
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    await click(cardEl(container).querySelector("[data-testid=question-dismiss]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.cancelled).toBe(true);
    expect(useQuestionsStore.getState().bySession[SID] ?? []).toHaveLength(0);
    await unmount();
  });
});

// docs08-r5 任务 10 stop 分支定案钉死：待办症状所述「选择自定义输入后卡片切换为
// 独立输入框形态、无法返回选项列表」与本组件现状不符——自定义输入与选项常驻同屏、
// 无形态切换状态机（成因排查见 .omo/evidence/docs08-r5/task-10-report.md）。
// 以下两条把「同屏并存」与「使用自定义输入不排挤选项」的现状契约钉死；
// 若未来引入形态切换，应有意识地更新而非顺带破坏这两条。
describe("QuestionCard 自定义输入与选项同屏现状（docs08-r5 任务 10 钉死）", () => {
  test("渲染即并存：每个问题的选项与自定义输入同屏，无独立输入框形态", async () => {
    const request = makeRequest();
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    for (const q of request.questions) {
      const item = card.querySelector(`[data-testid=question-item-${q.id}]`);
      expect(item).not.toBeNull();
      expect(item!.querySelectorAll("[data-testid=question-option]").length).toBe(q.options.length);
      expect(item!.querySelector(`[data-testid=question-text-${q.id}]`)).not.toBeNull();
    }
    await unmount();
  });

  test("填自定义文本后选项仍可见可选：选项与文本一并入提交载荷", async () => {
    const request = makeRequest();
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    const text1 = card.querySelector("[data-testid=question-text-q1]") as HTMLInputElement;
    await act(async () => {
      setNativeValue(text1, "prefer canary");
    });
    // 自定义输入使用中：选项仍在屏、仍可用、仍可选
    const options = [...card.querySelectorAll("[data-testid=question-option]")] as HTMLButtonElement[];
    expect(options[0].disabled).toBe(false);
    await click(options[0]); // q1: staging（单选）
    const stillText = card.querySelector("[data-testid=question-text-q1]") as HTMLInputElement;
    expect(stillText.value).toBe("prefer canary");
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.answers).toEqual({ q1: { selected: ["staging"], text: "prefer canary" } });
    await unmount();
  });
});
