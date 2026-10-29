// 提问卡片组件测试（q1，docs08-r7 任务 14 stepper 重设计后口径）：渲染形态（步进指示/
// 一次一题/倒计时/等待语义文案）、交互（跨步选择与提交应答载荷、comment-only 提交、
// 空应答内联拦截、取消应答、提交后不本地出队）。happy-dom + createRoot 惯例；
// fetch mock 捕获应答 POST。
// docs08-r5 任务 10 钉死的「自定义输入与选项同屏」契约在 stepper 语义下迁移为：
// 当前题的选项与自定义输入同屏并存；跨步作答状态保留并一并入提交载荷。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { window?: unknown }).window) {
  GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { QuestionCard } = await import("@/components/chat/question-card");
const { QuestionQueue } = await import("@/components/chat/question-queue");
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

function makeRequest(extra: Record<string, unknown> = {}) {
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
  useQuestionsStore.setState({ bySession: {} });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("QuestionCard 渲染（stepper）", () => {
  test("一次一题：仅当前题可见，步进指示「第 1/2 题」，双步进点", async () => {
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request: makeRequest(), position: 1, total: 1 }),
    );
    const card = cardEl(container);
    expect(card.textContent).toContain("Which environment?");
    expect(card.textContent).not.toContain("Which features?");
    expect(card.querySelectorAll("[data-testid=question-option]")).toHaveLength(2);
    expect(card.querySelector("[data-testid=question-step-indicator]")!.textContent).toBe("第 1/2 题");
    expect(card.querySelectorAll("[data-testid^=question-step-dot-]")).toHaveLength(2);
    expect(card.querySelector("[data-testid=question-step-dot-0]")!.getAttribute("data-current")).toBe("true");
    // waitForAnswer=true → 等待语义文案
    expect(card.textContent).toContain("等待回答");
    expect(card.querySelector("[data-testid=question-countdown]")!.textContent).toMatch(/^\d+:\d{2}$/);
    await unmount();
  });

  test("waitForAnswer=false →「可稍后回答」文案；多卡时保留队列位置标注", async () => {
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

  test("单题卡无步进 chrome：无指示器/翻页钮", async () => {
    const single = makeRequest();
    single.questions = [single.questions[0]];
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request: single, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    expect(card.querySelector("[data-testid=question-step-indicator]")).toBeNull();
    expect(card.querySelector("[data-testid=question-step-prev]")).toBeNull();
    expect(card.querySelector("[data-testid=question-step-next]")).toBeNull();
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

describe("QuestionCard 步进导航", () => {
  test("下一/上一题来回翻：首步 prev 禁用、末步 next 禁用，切题仅换当前题", async () => {
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request: makeRequest(), position: 1, total: 1 }),
    );
    const card = cardEl(container);
    const prev = card.querySelector("[data-testid=question-step-prev]") as HTMLButtonElement;
    const next = card.querySelector("[data-testid=question-step-next]") as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    await click(next);
    expect((card.querySelector("[data-testid=question-step-indicator]") as HTMLElement).textContent).toBe("第 2/2 题");
    expect(card.textContent).toContain("Which features?");
    expect(card.textContent).not.toContain("Which environment?");
    expect(next.disabled).toBe(true);
    expect(prev.disabled).toBe(false);
    await click(prev);
    expect(card.textContent).toContain("Which environment?");
    await unmount();
  });

  test("已答标记：选择后步进点带 data-answered；步进点可直达", async () => {
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request: makeRequest(), position: 1, total: 1 }),
    );
    const card = cardEl(container);
    const dot0 = card.querySelector("[data-testid=question-step-dot-0]")!;
    expect(dot0.getAttribute("data-answered")).toBeNull();
    await click(card.querySelector("[data-testid=question-option]")!); // q1: staging
    expect(dot0.getAttribute("data-answered")).toBe("true");
    // 步进点直达第 2 题
    await click(card.querySelector("[data-testid=question-step-dot-1]")!);
    expect(card.textContent).toContain("Which features?");
    await unmount();
  });

  test("跨步作答状态保留：q1 选择后翻到 q2 再提交，两题答案一并入载荷", async () => {
    const request = makeRequest();
    useQuestionsStore.getState().pushRequest(SID, request);
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    await click(card.querySelector("[data-testid=question-option]")!); // q1: staging
    await click(card.querySelector("[data-testid=question-step-next]")!);
    const options = [...card.querySelectorAll("[data-testid=question-option]")] as HTMLButtonElement[];
    await click(options[0]); // q2: auth
    await click(options[1]); // q2: dark-mode
    // 翻回 q1 复核选择仍在
    await click(card.querySelector("[data-testid=question-step-prev]")!);
    const back = card.querySelector("[data-testid=question-option]") as HTMLButtonElement;
    expect(back.getAttribute("data-selected")).toBe("true");
    await click(card.querySelector("[data-testid=question-step-next]")!);
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.answers).toEqual({
      q1: { selected: ["staging"] },
      q2: { selected: ["auth", "dark-mode"] },
    });
    await unmount();
  });

  test("卡体滚动容器：max-height + overflow-y-auto，切题滚动复位", async () => {
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request: makeRequest(), position: 1, total: 1 }),
    );
    const card = cardEl(container);
    const scrollables = [...card.querySelectorAll("div")].filter((d) =>
      d.className.includes("overflow-y-auto"),
    );
    expect(scrollables.length).toBeGreaterThanOrEqual(1);
    expect(scrollables[0].className).toContain("max-h-");
    // 模拟滚走后切题归零
    const body = scrollables[0] as HTMLElement;
    body.scrollTop = 100;
    await click(card.querySelector("[data-testid=question-step-next]")!);
    expect(body.scrollTop).toBe(0);
    await unmount();
  });
});

describe("QuestionCard 交互", () => {
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

  test("comment-only 提交：answers 为空对象 + comment（r6 卡死回归：载荷必须带 answers 键）", async () => {
    const request = makeRequest();
    useQuestionsStore.getState().pushRequest(SID, request);
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    const comment = card.querySelector("[data-testid=question-comment]") as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(comment, "只补充说明，不选选项");
    });
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.answers).toEqual({});
    expect(posted[0].body.comment).toBe("只补充说明，不选选项");
    expect(card.querySelector("[data-testid=question-inline-error]")).toBeNull();
    await unmount();
  });

  test("空提交内联拦截：不 POST、内联错误态（role=alert）", async () => {
    const request = makeRequest();
    useQuestionsStore.getState().pushRequest(SID, request);
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(0);
    const err = card.querySelector("[data-testid=question-inline-error]");
    expect(err).not.toBeNull();
    expect(err!.getAttribute("role")).toBe("alert");
    expect(err!.textContent).toContain("至少回答一个问题");
    // 作答后错误态清除并可提交
    await click(card.querySelector("[data-testid=question-option]")!);
    expect(card.querySelector("[data-testid=question-inline-error]")).toBeNull();
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    await unmount();
  });

  test("提交成功不本地出队（失败不消失）：卡仍在、输入禁用、显等待确认", async () => {
    const request = makeRequest();
    useQuestionsStore.getState().pushRequest(SID, request);
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    await click(card.querySelector("[data-testid=question-option]")!);
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    // question_resolved 未达：不出队，出等待确认文案，输入/提交禁用
    expect(useQuestionsStore.getState().bySession[SID]).toHaveLength(1);
    expect(card.querySelector("[data-testid=question-submit-pending]")).not.toBeNull();
    const submit = card.querySelector("[data-testid=question-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // SSE question_resolved 消费路径（removeRequest）仍可出队
    await act(async () => {
      useQuestionsStore.getState().removeRequest(SID, request.id);
    });
    expect(useQuestionsStore.getState().bySession[SID] ?? []).toHaveLength(0);
    await unmount();
  });

  test("提交后 5s 无确认 → 兜底 UI（重试/取消）出现，取消路径 POST cancelled 并出队（fake timers）", async () => {
    vi.useFakeTimers();
    try {
      const request = makeRequest();
      useQuestionsStore.getState().pushRequest(SID, request);
      const { container, unmount } = await render(
        createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
      );
      const card = cardEl(container);
      await click(card.querySelector("[data-testid=question-option]")!);
      await click(card.querySelector("[data-testid=question-submit]")!);
      expect(posted).toHaveLength(1);
      // 5s 内：仅等待确认，无兜底
      expect(card.querySelector("[data-testid=question-submit-fallback]")).toBeNull();
      expect(card.querySelector("[data-testid=question-submit-pending]")).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      const fb = card.querySelector("[data-testid=question-submit-fallback]");
      expect(fb).not.toBeNull();
      // 取消路径：cancelled POST 并出队
      await click(card.querySelector("[data-testid=question-submit-cancel]")!);
      expect(posted).toHaveLength(2);
      expect(posted[1].body.cancelled).toBe(true);
      expect(useQuestionsStore.getState().bySession[SID] ?? []).toHaveLength(0);
      await unmount();
    } finally {
      vi.useRealTimers();
    }
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

describe("QuestionCard 自定义输入与选项同屏（docs08-r5 任务 10 钉死，stepper 语义迁移）", () => {
  test("当前题的选项与自定义输入同屏并存，无独立输入框形态", async () => {
    const request = makeRequest();
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    const item = card.querySelector("[data-testid=question-item-q1]");
    expect(item).not.toBeNull();
    expect(item!.querySelectorAll("[data-testid=question-option]").length).toBe(request.questions[0].options.length);
    expect(item!.querySelector("[data-testid=question-text-q1]")).not.toBeNull();
    await unmount();
  });

  test("填自定义文本后选项仍可见可选（r11 互斥：单选下选中选项即清空文本）", async () => {
    const request = makeRequest();
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    const text1 = card.querySelector("[data-testid=question-text-q1]") as HTMLInputElement;
    await act(async () => {
      setNativeValue(text1, "prefer canary");
    });
    const options = [...card.querySelectorAll("[data-testid=question-option]")] as HTMLButtonElement[];
    expect(options[0].disabled).toBe(false);
    await click(options[0]); // q1: staging（单选）→ 文本被清空
    const stillText = card.querySelector("[data-testid=question-text-q1]") as HTMLInputElement;
    expect(stillText.value).toBe("");
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.answers).toEqual({ q1: { selected: ["staging"] } });
    await unmount();
  });

  test("单选互斥：选选项后再输入文本 → 选项取消选中，载荷 selected 空数组 + text", async () => {
    const request = makeRequest();
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    await click(card.querySelector("[data-testid=question-option]")!); // q1: staging
    const selected = card.querySelector("[data-testid=question-option][data-selected]");
    expect(selected).not.toBeNull();
    const text1 = card.querySelector("[data-testid=question-text-q1]") as HTMLInputElement;
    await act(async () => {
      setNativeValue(text1, "别的");
    });
    expect(card.querySelector("[data-testid=question-option][data-selected]")).toBeNull();
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.answers).toEqual({ q1: { selected: [], text: "别的" } });
    await unmount();
  });

  test("单选互斥：先输入文本再选选项 → 输入框清空，载荷无 text 键", async () => {
    const request = makeRequest();
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    const text1 = card.querySelector("[data-testid=question-text-q1]") as HTMLInputElement;
    await act(async () => {
      setNativeValue(text1, "自定义方案");
    });
    await click(card.querySelector("[data-testid=question-option]")!); // q1: staging
    expect((card.querySelector("[data-testid=question-text-q1]") as HTMLInputElement).value).toBe("");
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.answers).toEqual({ q1: { selected: ["staging"] } });
    await unmount();
  });

  test("多选不互斥：勾两个选项且输入文本 → selected 与 text 并存入载荷", async () => {
    const request = makeRequest();
    useQuestionsStore.getState().pushRequest(SID, request);
    const { container, unmount } = await render(
      createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }),
    );
    const card = cardEl(container);
    await click(card.querySelector("[data-testid=question-step-dot-1]")!); // 到 q2（多选）
    const options = [...card.querySelectorAll("[data-testid=question-option]")] as HTMLButtonElement[];
    await click(options[0]); // auth
    await click(options[1]); // dark-mode
    const text2 = card.querySelector("[data-testid=question-text-q2]") as HTMLInputElement;
    await act(async () => {
      setNativeValue(text2, "auth 必须要");
    });
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.answers).toEqual({ q2: { selected: ["auth", "dark-mode"], text: "auth 必须要" } });
    await unmount();
  });
});

describe("QuestionQueue 多卡收敛", () => {
  test("默认仅最新展开：旧卡折叠单行摘要，点摘要展开", async () => {
    const r1 = makeRequest({ id: "q-old", questions: [makeRequest().questions[0]] });
    const r2 = makeRequest({ id: "q-new", questions: [makeRequest().questions[1]] });
    useQuestionsStore.getState().pushRequest(SID, r1);
    useQuestionsStore.getState().pushRequest(SID, r2);
    const { container, unmount } = await render(createElement(QuestionQueue, { sessionId: SID }));
    // 旧卡折叠摘要（首题题干 + 位置），新卡完整展开
    const collapsed = container.querySelector("[data-testid=question-card-collapsed]");
    expect(collapsed).not.toBeNull();
    expect(collapsed!.textContent).toContain("Which environment?");
    expect(collapsed!.textContent).toContain("第 1/2 个待处理");
    expect(container.querySelector("[data-testid=question-card]")).not.toBeNull();
    expect(container.querySelectorAll("[data-testid=question-card-collapsed]")).toHaveLength(1);
    // 点摘要展开旧卡
    await click(collapsed!.querySelector("[data-testid=question-collapse-toggle]")!);
    expect(container.querySelectorAll("[data-testid=question-card]")).toHaveLength(2);
    expect(container.querySelector("[data-testid=question-card-collapsed]")).toBeNull();
    await unmount();
  });
});
