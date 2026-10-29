// 提问卡片组件测试（q1；r11 todo 6 页签化控件模型后口径）：渲染形态（顶部条忽略/上一题/
// 下一题、页签行 Q1..Qn/问题+补充、倒计时/等待语义文案）、交互（跨页签作答与提交应答
// 载荷、comment-only 提交、多题守卫禁用+「剩 N 题未答」提示、取消应答、提交后不本地
// 出队）、草稿上提（卸载重挂已答/页签/提交态保真）。happy-dom + createRoot 惯例；
// fetch mock 捕获应答 POST。
// docs08-r5 任务 10 钉死的「自定义输入与选项同屏」契约在页签语义下迁移为：当前题的
// 选项与自定义输入同屏并存；跨页签作答状态保留并一并入提交载荷。
// r11 todo 2 互斥回归：单选题选项与自定义文本二选一（载荷 selected 恒在场）。
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
    askedAtMs: Date.now(),
    anchorEntryId: null,
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

/** 挂卡（入队保草稿写路径畅通）并渲染 */
async function mountCard(request: ReturnType<typeof makeRequest>) {
  useQuestionsStore.getState().pushRequest(SID, request);
  return render(createElement(QuestionCard, { sessionId: SID, request, position: 1, total: 1 }));
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
  useQuestionsStore.setState({ bySession: {}, drafts: {}, resolvedSummaries: {} });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = "";
});

describe("QuestionCard 渲染（页签化）", () => {
  test("多题卡：页签行 Q1/Q2/补充，一次一题可见，顶部条忽略/上一题/下一题", async () => {
    const { container, unmount } = await mountCard(makeRequest());
    const card = cardEl(container);
    expect(card.textContent).toContain("Which environment?");
    expect(card.textContent).not.toContain("Which features?");
    expect(card.querySelectorAll("[data-testid=question-option]")).toHaveLength(2);
    // 页签行：Q1/Q2/补充，当前 Q1
    const tabs = [...card.querySelectorAll("[data-testid^=question-tab-]")];
    expect(tabs).toHaveLength(3);
    expect(tabs[0]!.textContent).toBe("Q1");
    expect(tabs[1]!.textContent).toBe("Q2");
    expect(card.querySelector("[data-testid=question-tab-comment]")!.textContent).toBe("补充");
    expect(tabs[0]!.getAttribute("data-current")).toBe("true");
    expect(tabs[1]!.getAttribute("data-current")).toBeNull();
    // 顶部条三控件
    expect(card.querySelector("[data-testid=question-dismiss]")).not.toBeNull();
    expect(card.querySelector("[data-testid=question-step-prev]")).not.toBeNull();
    expect(card.querySelector("[data-testid=question-step-next]")).not.toBeNull();
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

  test("单题卡轻量：仅 问题/补充 两页签，不渲染 Q 编号 chrome", async () => {
    const single = makeRequest();
    single.questions = [single.questions[0]];
    const { container, unmount } = await mountCard(single);
    const card = cardEl(container);
    const tabs = [...card.querySelectorAll("[data-testid^=question-tab-]")];
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.textContent).toBe("问题");
    expect(card.querySelector("[data-testid=question-tab-comment]")!.textContent).toBe("补充");
    expect(card.textContent).not.toContain("Q1");
    await unmount();
  });

  test("过期（deadline 已过）→ 选项禁用、显示已超时；补充页签提交禁用", async () => {
    const { container, unmount } = await mountCard(makeRequest({ deadlineAtMs: Date.now() - 1000 }));
    const card = cardEl(container);
    expect(card.textContent).toContain("已超时");
    const option = card.querySelector("[data-testid=question-option]") as HTMLButtonElement;
    expect(option.disabled).toBe(true);
    await click(card.querySelector("[data-testid=question-tab-comment]")!);
    const submit = card.querySelector("[data-testid=question-submit]") as HTMLButtonElement;
    expect(submit).not.toBeNull();
    expect(submit.disabled).toBe(true);
    await unmount();
  });
});

describe("QuestionCard 页签导航与多题守卫", () => {
  test("非末位页签无提交钮；末位页签（补充）按钮文案变提交", async () => {
    const { container, unmount } = await mountCard(makeRequest());
    const card = cardEl(container);
    // Q1：无提交钮，下一题在场
    expect(card.querySelector("[data-testid=question-submit]")).toBeNull();
    expect(card.querySelector("[data-testid=question-step-next]")).not.toBeNull();
    // Q2：同上
    await click(card.querySelector("[data-testid=question-step-next]")!);
    expect(card.querySelector("[data-testid=question-submit]")).toBeNull();
    // 补充页签：提交钮在场，文案为提交（非「下一题」）
    await click(card.querySelector("[data-testid=question-step-next]")!);
    const submit = card.querySelector("[data-testid=question-submit]") as HTMLButtonElement;
    expect(submit).not.toBeNull();
    expect(submit.textContent).toContain("提交");
    expect(submit.textContent).not.toContain("下一题");
    expect(card.querySelector("[data-testid=question-step-next]")).toBeNull();
    await unmount();
  });

  test("上一题/下一题来回翻：首页签 prev 禁用、补充页签 prev 可回退，切页签仅换当前内容", async () => {
    const { container, unmount } = await mountCard(makeRequest());
    const card = cardEl(container);
    const prev = card.querySelector("[data-testid=question-step-prev]") as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    await click(card.querySelector("[data-testid=question-step-next]")!);
    expect(card.textContent).toContain("Which features?");
    expect(card.textContent).not.toContain("Which environment?");
    await click(card.querySelector("[data-testid=question-step-next]")!);
    expect(card.querySelector("[data-testid=question-comment]")).not.toBeNull();
    expect((card.querySelector("[data-testid=question-step-prev]") as HTMLButtonElement).disabled).toBe(false);
    await click(card.querySelector("[data-testid=question-step-prev]")!);
    expect(card.textContent).toContain("Which features?");
    await unmount();
  });

  test("已答标记：作答后对应页签 data-answered；页签可直达", async () => {
    const { container, unmount } = await mountCard(makeRequest());
    const card = cardEl(container);
    const tab0 = card.querySelector("[data-testid=question-tab-0]")!;
    expect(tab0.getAttribute("data-answered")).toBeNull();
    await click(card.querySelector("[data-testid=question-option]")!); // q1: staging
    expect(tab0.getAttribute("data-answered")).toBe("true");
    // 页签直达第 2 题
    await click(card.querySelector("[data-testid=question-tab-1]")!);
    expect(card.textContent).toContain("Which features?");
    await unmount();
  });

  test("未答完禁用 + 行内提示含剩余数：Q1 未答直接翻补充 → 禁用 +「剩 2 题未答」；答一题后「剩 1 题未答」", async () => {
    const { container, unmount } = await mountCard(makeRequest());
    const card = cardEl(container);
    await click(card.querySelector("[data-testid=question-tab-comment]")!);
    const submit = card.querySelector("[data-testid=question-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const hint = card.querySelector("[data-testid=question-remaining-hint]")!;
    expect(hint).not.toBeNull();
    expect(hint.textContent).toContain("剩 2 题未答");
    expect(posted).toHaveLength(0); // 禁用即拦截，零 POST
    // 回答 Q1 后：剩 1 题
    await click(card.querySelector("[data-testid=question-tab-0]")!);
    await click(card.querySelector("[data-testid=question-option]")!);
    await click(card.querySelector("[data-testid=question-tab-comment]")!);
    const hint2 = card.querySelector("[data-testid=question-remaining-hint]")!;
    expect(hint2.textContent).toContain("剩 1 题未答");
    expect((card.querySelector("[data-testid=question-submit]") as HTMLButtonElement).disabled).toBe(true);
    await unmount();
  });

  test("全答启用：Q1/Q2 都答后补充页签提交可点且无提示", async () => {
    const { container, unmount } = await mountCard(makeRequest());
    const card = cardEl(container);
    await click(card.querySelector("[data-testid=question-option]")!); // q1: staging
    await click(card.querySelector("[data-testid=question-tab-1]")!);
    const opts = [...card.querySelectorAll("[data-testid=question-option]")] as HTMLButtonElement[];
    await click(opts[0]); // q2: auth
    await click(card.querySelector("[data-testid=question-tab-comment]")!);
    expect(card.querySelector("[data-testid=question-remaining-hint]")).toBeNull();
    const submit = card.querySelector("[data-testid=question-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await unmount();
  });

  test("补充非空启用：未答题存在但补充说明非空 → 提交可点（IS-2 三定调）", async () => {
    const { container, unmount } = await mountCard(makeRequest());
    const card = cardEl(container);
    await click(card.querySelector("[data-testid=question-tab-comment]")!);
    const comment = card.querySelector("[data-testid=question-comment]") as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(comment, "两题都用默认方案");
    });
    expect(card.querySelector("[data-testid=question-remaining-hint]")).toBeNull();
    const submit = card.querySelector("[data-testid=question-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await unmount();
  });

  test("卡体滚动容器：max-height + overflow-y-auto，切页签滚动复位", async () => {
    const { container, unmount } = await mountCard(makeRequest());
    const card = cardEl(container);
    const scrollables = [...card.querySelectorAll("div")].filter((d) =>
      d.className.includes("overflow-y-auto"),
    );
    expect(scrollables.length).toBeGreaterThanOrEqual(1);
    expect(scrollables[0].className).toContain("max-h-");
    const body = scrollables[0] as HTMLElement;
    body.scrollTop = 100;
    await click(card.querySelector("[data-testid=question-step-next]")!);
    expect(body.scrollTop).toBe(0);
    await unmount();
  });
});

describe("QuestionCard 交互（载荷契约）", () => {
  test("跨页签作答状态保留：q1 选择后翻到 q2 作答再到补充提交，两题答案一并入载荷", async () => {
    const { container, unmount } = await mountCard(makeRequest());
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
    await click(card.querySelector("[data-testid=question-tab-comment]")!);
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.answers).toEqual({
      q1: { selected: ["staging"] },
      q2: { selected: ["auth", "dark-mode"] },
    });
    await unmount();
  });

  test("自由文本进 answers.text、补充说明一并提交（补充页签填写）", async () => {
    const { container, unmount } = await mountCard(makeRequest());
    const card = cardEl(container);
    const text1 = card.querySelector("[data-testid=question-text-q1]") as HTMLInputElement;
    await act(async () => {
      setNativeValue(text1, "staging if possible");
    });
    await click(card.querySelector("[data-testid=question-tab-comment]")!);
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
    const { container, unmount } = await mountCard(makeRequest());
    const card = cardEl(container);
    await click(card.querySelector("[data-testid=question-tab-comment]")!);
    const comment = card.querySelector("[data-testid=question-comment]") as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(comment, "只补充说明，不选选项");
    });
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.answers).toEqual({});
    expect(posted[0].body.comment).toBe("只补充说明，不选选项");
    await unmount();
  });

  test("提交成功不本地出队（失败不消失）：卡仍在、输入禁用、显等待确认", async () => {
    const request = makeRequest();
    const { container, unmount } = await mountCard(request);
    const card = cardEl(container);
    await click(card.querySelector("[data-testid=question-option]")!);
    await click(card.querySelector("[data-testid=question-tab-comment]")!);
    await act(async () => {
      setNativeValue(card.querySelector("[data-testid=question-comment]") as HTMLTextAreaElement, "第二题稍后答");
    });
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    // question_resolved 未达：不出队，出等待确认文案，输入/提交禁用
    expect(useQuestionsStore.getState().bySession[SID]).toHaveLength(1);
    expect(card.querySelector("[data-testid=question-submit-pending]")).not.toBeNull();
    const submit = card.querySelector("[data-testid=question-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const comment = card.querySelector("[data-testid=question-comment]") as HTMLTextAreaElement;
    expect(comment.disabled).toBe(true);
    await unmount();
  });

  test("提交后 5s 无确认 → 兜底 UI（重试/取消）出现，取消路径 POST cancelled 并出队（fake timers）", async () => {
    vi.useFakeTimers();
    try {
      const request = makeRequest();
      const { container, unmount } = await mountCard(request);
      const card = cardEl(container);
      await click(card.querySelector("[data-testid=question-option]")!);
      await click(card.querySelector("[data-testid=question-tab-comment]")!);
      await act(async () => {
        setNativeValue(card.querySelector("[data-testid=question-comment]") as HTMLTextAreaElement, "第二题稍后答");
      });
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
    const { container, unmount } = await mountCard(request);
    await click(cardEl(container).querySelector("[data-testid=question-dismiss]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.cancelled).toBe(true);
    expect(useQuestionsStore.getState().bySession[SID] ?? []).toHaveLength(0);
    await unmount();
  });
});

describe("QuestionCard 自定义输入与选项同屏（docs08-r5 任务 10 钉死，页签语义迁移）", () => {
  test("当前题的选项与自定义输入同屏并存，无独立输入框形态", async () => {
    const request = makeRequest();
    const { container, unmount } = await mountCard(request);
    const card = cardEl(container);
    const item = card.querySelector("[data-testid=question-item-q1]");
    expect(item).not.toBeNull();
    expect(item!.querySelectorAll("[data-testid=question-option]").length).toBe(request.questions[0].options.length);
    expect(item!.querySelector("[data-testid=question-text-q1]")).not.toBeNull();
    await unmount();
  });

  test("单选互斥：选选项后再输入文本 → 选项取消选中，载荷 selected 空数组 + text", async () => {
    const { container, unmount } = await mountCard(makeRequest());
    const card = cardEl(container);
    await click(card.querySelector("[data-testid=question-option]")!); // q1: staging
    expect(card.querySelector("[data-testid=question-option][data-selected]")).not.toBeNull();
    const text1 = card.querySelector("[data-testid=question-text-q1]") as HTMLInputElement;
    await act(async () => {
      setNativeValue(text1, "别的");
    });
    expect(card.querySelector("[data-testid=question-option][data-selected]")).toBeNull();
    await click(card.querySelector("[data-testid=question-tab-comment]")!);
    await act(async () => {
      setNativeValue(card.querySelector("[data-testid=question-comment]") as HTMLTextAreaElement, "第二题用默认");
    });
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.answers).toEqual({ q1: { selected: [], text: "别的" } });
    await unmount();
  });

  test("单选互斥：先输入文本再选选项 → 输入框清空，载荷无 text 键", async () => {
    const { container, unmount } = await mountCard(makeRequest());
    const card = cardEl(container);
    const text1 = card.querySelector("[data-testid=question-text-q1]") as HTMLInputElement;
    await act(async () => {
      setNativeValue(text1, "自定义方案");
    });
    await click(card.querySelector("[data-testid=question-option]")!); // q1: staging
    expect((card.querySelector("[data-testid=question-text-q1]") as HTMLInputElement).value).toBe("");
    await click(card.querySelector("[data-testid=question-tab-comment]")!);
    await act(async () => {
      setNativeValue(card.querySelector("[data-testid=question-comment]") as HTMLTextAreaElement, "第二题用默认");
    });
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.answers).toEqual({ q1: { selected: ["staging"] } });
    await unmount();
  });

  test("多选不互斥：勾两个选项且输入文本 → selected 与 text 并存入载荷", async () => {
    const { container, unmount } = await mountCard(makeRequest());
    const card = cardEl(container);
    await click(card.querySelector("[data-testid=question-tab-1]")!); // 到 q2（多选）
    const options = [...card.querySelectorAll("[data-testid=question-option]")] as HTMLButtonElement[];
    await click(options[0]); // auth
    await click(options[1]); // dark-mode
    const text2 = card.querySelector("[data-testid=question-text-q2]") as HTMLInputElement;
    await act(async () => {
      setNativeValue(text2, "auth 必须要");
    });
    await click(card.querySelector("[data-testid=question-tab-comment]")!);
    await act(async () => {
      setNativeValue(card.querySelector("[data-testid=question-comment]") as HTMLTextAreaElement, "第一题用默认");
    });
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.answers).toEqual({ q2: { selected: ["auth", "dark-mode"], text: "auth 必须要" } });
    await unmount();
  });
});

describe("草稿上提（r11 todo 6a）：跨组件卸载存续", () => {
  test("已答跨卸载存续：答 Q1 → 卸载 → 重挂 → 选择保留并进提交载荷", async () => {
    const request = makeRequest();
    const first = await mountCard(request);
    await click(cardEl(first.container).querySelector("[data-testid=question-option]")!); // q1: staging
    await first.unmount();
    // 卸载（虚拟化滚出/切页签等价）后重挂：已答保留
    const second = await mountCard(request);
    const card = cardEl(second.container);
    const opt = card.querySelector("[data-testid=question-option]") as HTMLButtonElement;
    expect(opt.getAttribute("data-selected")).toBe("true");
    expect(card.querySelector("[data-testid=question-tab-0]")!.getAttribute("data-answered")).toBe("true");
    await click(card.querySelector("[data-testid=question-tab-comment]")!);
    await act(async () => {
      setNativeValue(card.querySelector("[data-testid=question-comment]") as HTMLTextAreaElement, "第二题用默认");
    });
    await click(card.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.answers).toEqual({ q1: { selected: ["staging"] } });
    await second.unmount();
  });

  test("页签位置跨卸载存续：翻到补充页签卸载重挂仍停在补充", async () => {
    const request = makeRequest();
    const first = await mountCard(request);
    await click(cardEl(first.container).querySelector("[data-testid=question-tab-comment]")!);
    expect(cardEl(first.container).querySelector("[data-testid=question-comment]")).not.toBeNull();
    await first.unmount();
    const second = await mountCard(request);
    expect(cardEl(second.container).querySelector("[data-testid=question-comment]")).not.toBeNull();
    expect(cardEl(second.container).querySelector("[data-testid=question-tab-comment]")!.getAttribute("data-current")).toBe("true");
    await second.unmount();
  });

  test("提交待确认态跨卸载存续：重挂不重复 POST、仍显等待确认", async () => {
    const request = makeRequest();
    const first = await mountCard(request);
    const card1 = cardEl(first.container);
    await click(card1.querySelector("[data-testid=question-option]")!);
    await click(card1.querySelector("[data-testid=question-tab-comment]")!);
    await act(async () => {
      setNativeValue(card1.querySelector("[data-testid=question-comment]") as HTMLTextAreaElement, "第二题稍后答");
    });
    await click(card1.querySelector("[data-testid=question-submit]")!);
    expect(posted).toHaveLength(1);
    await first.unmount();
    const second = await mountCard(request);
    const card2 = cardEl(second.container);
    expect(card2.querySelector("[data-testid=question-submit-pending]")).not.toBeNull();
    const submit = card2.querySelector("[data-testid=question-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // 草稿 submitted=true：等待确认期间重挂零重复应答
    expect(posted).toHaveLength(1);
    await second.unmount();
  });
});
