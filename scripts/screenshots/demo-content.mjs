// README 截图用的演示会话：每种语言一套，步骤结构相同、文案不同。
// 由 seed-demo.mjs 转成引擎格式的会话文件（JSONL），read/edit/write 的结果按 demo-projects.mjs
// 里的最终文件内容自动推导（edit 按 newText -> oldText 反推改动前内容）。
import { DEMO_PROJECTS } from "./demo-projects.mjs";

export const DEMO_HOME = "/home/dev/projects";

const files = (project) => DEMO_PROJECTS.find((p) => p.name === project).files;
const slice = (text, from, to) => {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`slice anchor not found: ${from} .. ${to}`);
  return text.slice(start, end);
};

// ---- 工具步骤（assistant 带 toolCall，结果由 seed-demo.mjs 生成） ----
const read = (path) => ({ name: "read", args: { path }, auto: "read" });
const edit = (path, edits) => ({ name: "edit", args: { path, edits }, auto: "edit" });
const write = (path, content, before = null) => ({ name: "write", args: { path, content }, auto: "write", before });
const bash = (command, output, seconds) => ({ name: "bash", args: { command }, auto: "bash", output, seconds });
const grep = (pattern, path, output) => ({ name: "grep", args: { pattern, path }, auto: "grep", output });
const todo = (args, phases) => ({ name: "todo", args, auto: "todo", phases });

const user = (text) => ({ kind: "user", text });
const say = (fields) => ({ kind: "say", ...fields });
const tool = (fields) => ({ kind: "tool", ...fields });

// ---- 各会话涉及的改动片段（从最终文件里切出来，保证与 demo-projects.mjs 一致） ----
const api = files("taskboard-api");
const web = files("taskboard-web");
const notifier = files("inbox-notifier");

const DB_PAGINATION = slice(api["src/db.ts"], "export type TaskSort", "export function createTask");
const DB_OLD_LIST = `export function listTasks(): Task[] {
  return db
    .prepare("SELECT id, title, status, priority, due_date, created_at FROM tasks ORDER BY created_at DESC")
    .all() as TaskRow[];
}

`;
const TASKS_ROUTE_PAGED = slice(api["src/routes/tasks.ts"], 'import { createTask, getTask, listTasksPage }', 'tasks.post("/",');
const TASKS_ROUTE_OLD = `import { createTask, getTask, listTasks } from "../db";

export const tasks = new Hono();

tasks.get("/", (c) => {
  const items = listTasks();
  return c.json({ items, total: items.length });
});

`;
const TASKS_TESTS_OLD = `import { beforeEach, describe, expect, it } from "vitest";
import { createTask, listTasks } from "../src/db";

describe("tasks", () => {
  beforeEach(() => {
    process.env.DB_PATH = ":memory:";
  });

  it("creates and lists tasks", () => {
    createTask({ title: "Write release notes" });
    expect(listTasks()).toHaveLength(1);
  });
});
`;
const AUTH_EXPIRES_NEW = "    expires: new Date(Date.now() + MAX_AGE * 1000),";
const AUTH_EXPIRES_OLD = "    expires: new Date(Date.now() + MAX_AGE),";
const LOGGER_PATH_NEW = "getLogger().info(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);";
const LOGGER_PATH_OLD = "getLogger().info(`${c.req.method} ${c.req.routePath} ${c.res.status} ${ms}ms`);";
const TASKLIST_VIRTUAL = web["src/components/TaskList.tsx"];
const TASKLIST_OLD = `import type { Task } from "../api/client";

type Props = {
  tasks: Task[];
  total: number;
  onLoadMore: () => void;
};

export function TaskList({ tasks }: Props) {
  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <li key={task.id} className="task-row">
          <span className={\`status status-\${task.status}\`}>{task.status}</span>
          <span className="title">{task.title}</span>
        </li>
      ))}
    </ul>
  );
}
`;
const THEME_TOGGLE_EFFECT = slice(
  web["src/components/ThemeToggle.tsx"],
  "  useEffect(() => {",
  "  return (",
);
const IMAP_RECONNECT = notifier["src/imap.ts"];
const IMAP_OLD = `import { ImapFlow } from "imapflow";
import type { Config } from "./config";

type Handlers = {
  onMail: (count: number) => Promise<void>;
};

/** 建立 IDLE 连接并保持。 */
export async function watchInbox(config: Config, handlers: Handlers) {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.port === 993,
    auth: { user: config.user, pass: config.password },
    logger: false,
  });
  client.on("exists", ({ count }: { count: number }) => void handlers.onMail(count));

  await client.connect();
  await client.mailboxOpen(config.mailbox);
  await client.idle();
}
`;
const NOTIFY_STATUS_NEW = slice(notifier["src/notify.ts"], "  onStatus(status) {", "});");
const NOTIFY_STATUS_OLD = "";

const vitestRun = (dir, files) => `> ${dir.split("/").pop()}@0.3.2 test
> vitest run

 RUN  v2.1.8 ${dir}

${files}
 Test Files  ${files.split("\n").length} passed (${files.split("\n").length})
      Tests  ${files.match(/(\d+) tests?/g).reduce((sum, m) => sum + Number(m.match(/\d+/)[0]), 0)} passed
   Start at  02:14:31
   Duration  2.11s (transform 312ms, setup 0ms, collect 420ms, tests 940ms)
`;

const TEXT = {
  "zh-CN": {
    tags: [
      { name: "bug", color: "#dc2626", sort: 0 },
      { name: "enhancement", color: "#2563eb", sort: 1 },
    ],
    notes: [
      { title: "", content: "任务到期提醒：后端每天扫描 dueDate，提前一天推送给前端", daysAgo: 3 },
      { title: "", content: "接入 Webhook 失败告警，参考 inbox-notifier 的退避重试", daysAgo: 5 },
      { title: "", content: "README 补充 Docker 部署说明和环境变量表", daysAgo: 8 },
    ],
    sessions: {
      pagination: {
        title: "给任务列表加分页和排序",
        user: "GET /api/tasks 现在一次性返回全部任务，任务一多前端就卡。加上 page/pageSize 分页，支持按 dueDate、priority 排序，默认按 createdAt 倒序，顺便把测试补上。",
        think1: "明确的改动请求：给列表接口加分页和排序。先看路由和查询层的现状，确认有没有现成的分页辅助，再决定改哪一层。排序字段必须走白名单，不能把用户输入直接拼进 SQL；pageSize 要有上限，避免一次拉太多。最后补测试。",
        say1: "先看任务路由和查询层的现状。",
        say2: "查询层没有分页辅助，先在 db.ts 加 listTasksPage()，再改路由。",
        phases: [
          { name: "实现", items: ["db.ts 增加分页查询 listTasksPage", "路由接入 page/pageSize/sort 并做参数校验"] },
          { name: "验证", items: ["补充分页与排序测试", "跑 npm test 确认通过"] },
        ],
        say3: "路由改好了，补测试。",
        say4: "跑一下测试。",
        final: [
          "改完了，共三处改动：",
          "",
          "1. `src/db.ts`：新增 `listTasksPage()`，返回 `{ items, total, page, pageSize }`；`sort` 只接受 `createdAt`、`dueDate`、`priority`，`order` 只接受 `asc`、`desc`。",
          "2. `src/routes/tasks.ts`：`GET /api/tasks` 支持 `page`、`pageSize`、`sort`、`order`，`pageSize` 默认 20、上限 100，非法参数返回 400。",
          "3. `test/tasks.test.ts`：补了 5 个用例，覆盖分页边界、排序、状态过滤和 pageSize 上限。",
          "",
          "```ts",
          'const { items, total } = await listTasksPage({ page: 2, pageSize: 20, sort: "dueDate", order: "asc" });',
          "```",
          "",
          "前端把 `page` 和 `pageSize` 传过来就行，响应里带了 `total`，可以直接算总页数。",
        ].join("\n"),
      },
      login: {
        title: "修复登录态隔天丢失",
        user: "有几个用户反馈隔天回来就被登出了，cookie 的 maxAge 明明设了 14 天。查一下原因并修掉。",
        think1: "maxAge 是 14 天但隔天就丢，说明 cookie 实际过期时间比预期短。先看签发 cookie 的代码，重点核对 expires 和 maxAge 的单位是否一致。",
        say1: "先看签发登录 cookie 的代码。",
        think2: "找到了：expires 用的是 Date.now() + MAX_AGE，而 MAX_AGE 是秒，这里当成了毫秒，等于只给了 20 分钟。浏览器以 expires 为准，所以 maxAge 的 14 天形同虚设。",
        say2: "expires 把秒当成了毫秒：`Date.now() + MAX_AGE` 只加了约 20 分钟，浏览器以 `expires` 为准，所以 14 天的 `maxAge` 没生效。先修掉，再补一个断言过期时间的测试。",
        say3: "跑一下测试。",
        final: [
          "根因是 `expires` 的单位用错了：`MAX_AGE` 是秒，`Date.now() + MAX_AGE` 只加了 20 分钟，浏览器以 `expires` 为准，所以 14 天的 `maxAge` 没生效。",
          "",
          "改动：",
          "",
          "- `src/routes/auth.ts`：`expires` 改为 `MAX_AGE * 1000`",
          "- `test/auth.test.ts`：新增 2 个用例，断言 cookie 的 `Expires` 距现在 14 天左右",
          "",
          "已经登录的用户要重新登录一次才能拿到新的 cookie。",
        ].join("\n"),
      },
      webhook: {
        title: "补齐 Webhook 重试的测试",
        user: "src/webhook.ts 的重试逻辑没有测试覆盖，补一下：失败重试 3 次、成功后不再重试、429 按 Retry-After 等待。",
        think1: "重试逻辑在 deliverWebhook 里，fetch 和 sleep 都能从 deps 注入，测试不需要真实网络。按用户列的三个场景各写一个用例。",
        say1: "先看一下重试逻辑的注入点。",
        say2: "fetch 和 sleep 都能注入，不用真实网络。按三个场景各写一个用例。",
        say3: "跑一下测试。",
        final: "补了 3 个用例：失败后按 500ms、1000ms 退避重试到 3 次；首次成功后不再重试；429 时按 `Retry-After` 等待。全部通过，现在 12 个用例。",
      },
      hono: {
        title: "升级 Hono 4.7 并修类型错误",
        user: "把 hono 升到 4.7，升级后类型有报错，一起处理掉。",
        think1: "先升级再跑 typecheck 看报什么错，按错误逐个修。",
        say1: "先升级，然后跑一遍 typecheck 看报错。",
        think2: "只剩一处：HonoRequest 在 4.7 里没有 routePath 了，改回 path。",
        say2: "只剩一处：4.7 里 `HonoRequest` 没有 `routePath` 了，改回 `path`。",
        say3: "再跑一次 typecheck。",
        final: "升级到 `hono@4.7.0`，类型错误只有一处：`c.req.routePath` 在 4.7 里被移除，改回 `c.req.path`。`typecheck` 和测试都通过。",
      },
      virtual: {
        title: "任务列表改成虚拟滚动",
        user: "任务超过 500 条时滚动明显掉帧，把 TaskList 改成虚拟滚动。",
        think1: "掉帧是因为一次性渲染了几百个 DOM 节点。用 @tanstack/react-virtual 做虚拟滚动，保留 onLoadMore 的触发逻辑。",
        say1: "先看一下 TaskList 现在的实现。",
        say2: "一次性渲染几百行是瓶颈，用 @tanstack/react-virtual 只渲染可视区域。",
        say3: "装一下依赖，然后重写列表。",
        say4: "跑一下构建确认类型没问题。",
        final: "改完了：`TaskList` 改用 `useVirtualizer`，只渲染可视区域加 8 行 overscan，`onLoadMore` 改为在滚动到倒数 3 行时触发。构建通过。",
      },
      theme: {
        title: "深色模式切换按钮不生效",
        user: "右上角的深色模式按钮点了没反应，控制台也没报错。",
        think1: "点击没反应但没报错，多半是状态更新了但没写到 document 上。先找主题相关代码。",
        say1: "先找主题相关的代码。",
        say2: "按钮只更新了 state，没有把主题写到 `document.documentElement` 上，也没有持久化。补一个 effect。",
        final: "原因是 `ThemeToggle` 只更新了组件 state，没有同步到 `document.documentElement.dataset.theme`，样式表的选择器一直匹配不到。补了一个 `useEffect`，同时把选择写进 `localStorage`。",
      },
      reconnect: {
        title: "IMAP IDLE 断线后自动重连",
        user: "IMAP IDLE 连接每隔几个小时会断，之后就收不到通知了。加上断线重连，退避重试。",
        think1: "现在的 watchInbox 连上就 idle，close 事件没人处理。改成监听 close 后按指数退避重连，并把连接状态暴露给调用方。",
        say1: "先看一下现在的连接逻辑。",
        say2: "连上之后没有监听 close，断了就永远不会再连。改成监听 close 后按指数退避重连，并把状态回调暴露出来。",
        say3: "再让入口把连接状态打到日志里。",
        say4: "跑一下测试。",
        final: "改动：\n\n- `src/imap.ts`：监听 `close` 事件，按 1s、2s、4s 退避重连，上限 5 分钟，连接成功后计数归零；新增 `stop()` 停止重连\n- `src/notify.ts`：把 `connected` / `reconnecting` 状态写到 stdout\n\n断线后最多 1 秒就会开始重连。",
      },
    },
  },
  en: {
    tags: [
      { name: "bug", color: "#dc2626", sort: 0 },
      { name: "enhancement", color: "#2563eb", sort: 1 },
    ],
    notes: [
      { title: "", content: "Due-date reminders: scan dueDate once a day and push a notice one day ahead", daysAgo: 3 },
      { title: "", content: "Wire webhook failures into alerting, reuse the backoff from inbox-notifier", daysAgo: 5 },
      { title: "", content: "README: add Docker deployment section and an env var table", daysAgo: 8 },
    ],
    sessions: {
      pagination: {
        title: "Add pagination and sorting to the task list",
        user: "GET /api/tasks returns every task in one go and the frontend gets sluggish once there are more than a few hundred. Add page/pageSize pagination, support sorting by dueDate and priority, default to createdAt descending, and cover it with tests.",
        think1: "Clear change request: pagination and sorting for the list endpoint. First look at the route and query layer to see whether a pagination helper already exists, then decide where the change goes. Sort fields must go through an allowlist, never concatenated into SQL; pageSize needs an upper bound. Finish with tests.",
        say1: "Let me look at the task route and the query layer first.",
        say2: "There is no pagination helper in the query layer. I will add listTasksPage() to db.ts, then update the route.",
        phases: [
          { name: "Implement", items: ["Add listTasksPage() to db.ts", "Wire page/pageSize/sort into the route with validation"] },
          { name: "Verify", items: ["Add pagination and sorting tests", "Run npm test"] },
        ],
        say3: "Route is done, now the tests.",
        say4: "Run the tests.",
        final: [
          "Done, three changes:",
          "",
          "1. `src/db.ts`: added `listTasksPage()`, returning `{ items, total, page, pageSize }`. `sort` accepts only `createdAt`, `dueDate` and `priority`; `order` only `asc` or `desc`.",
          "2. `src/routes/tasks.ts`: `GET /api/tasks` now takes `page`, `pageSize`, `sort` and `order`. `pageSize` defaults to 20 and is capped at 100; invalid values return 400.",
          "3. `test/tasks.test.ts`: 5 new cases covering page boundaries, sorting, status filtering and the pageSize cap.",
          "",
          "```ts",
          'const { items, total } = await listTasksPage({ page: 2, pageSize: 20, sort: "dueDate", order: "asc" });',
          "```",
          "",
          "The frontend only needs to pass `page` and `pageSize`; the response includes `total`, so computing the page count is straightforward.",
        ].join("\n"),
      },
      login: {
        title: "Fix sessions expiring overnight",
        user: "A few users report being logged out the next day even though the cookie maxAge is set to 14 days. Find the cause and fix it.",
        think1: "maxAge says 14 days but the cookie dies overnight, so the effective expiry is shorter than intended. Look at how the cookie is issued and check whether expires and maxAge use the same unit.",
        say1: "Let me look at the code that issues the session cookie.",
        think2: "Found it: expires uses Date.now() + MAX_AGE while MAX_AGE is in seconds, so it is treated as milliseconds, which is about 20 minutes. Browsers honour expires over maxAge, so the 14-day maxAge never mattered.",
        say2: "`expires` treats seconds as milliseconds: `Date.now() + MAX_AGE` only adds about 20 minutes, and browsers honour `expires` over `maxAge`, so the 14 days never applied. Fixing that first, then adding a test that asserts the expiry.",
        say3: "Run the tests.",
        final: [
          "Root cause: `expires` used the wrong unit. `MAX_AGE` is in seconds, so `Date.now() + MAX_AGE` added only 20 minutes, and since browsers honour `expires` over `maxAge` the 14 days never applied.",
          "",
          "Changes:",
          "",
          "- `src/routes/auth.ts`: `expires` now uses `MAX_AGE * 1000`",
          "- `test/auth.test.ts`: 2 new cases asserting the cookie `Expires` is about 14 days from now",
          "",
          "Users who are already logged in need to sign in once more to get the new cookie.",
        ].join("\n"),
      },
      webhook: {
        title: "Add tests for webhook retries",
        user: "The retry logic in src/webhook.ts has no test coverage. Please add tests: retry 3 times on failure, stop after a success, and honour Retry-After on 429.",
        think1: "The retry logic lives in deliverWebhook; both fetch and sleep are injectable through deps, so the tests need no network. One case per scenario the user listed.",
        say1: "Let me check the injection points in the retry logic.",
        say2: "Both fetch and sleep are injectable, so no network is needed. One case per scenario.",
        say3: "Run the tests.",
        final: "Added 3 cases: back off 500ms then 1000ms and stop after 3 failed attempts; no retry after the first success; wait for `Retry-After` on 429. All green, 12 cases in total.",
      },
      hono: {
        title: "Upgrade to Hono 4.7 and fix type errors",
        user: "Upgrade hono to 4.7. There are type errors afterwards; fix those too.",
        think1: "Upgrade first, then run typecheck and fix whatever it reports.",
        say1: "Upgrade first, then run typecheck to see what breaks.",
        think2: "Only one left: HonoRequest no longer has routePath in 4.7, switch back to path.",
        say2: "Only one left: `HonoRequest` has no `routePath` in 4.7, switching back to `path`.",
        say3: "Run typecheck once more.",
        final: "Upgraded to `hono@4.7.0`. The only type error was `c.req.routePath`, which was removed in 4.7; switched back to `c.req.path`. Typecheck and tests pass.",
      },
      virtual: {
        title: "Virtualize the task list",
        user: "Scrolling gets choppy once there are more than 500 tasks. Turn TaskList into a virtualized list.",
        think1: "The jank comes from rendering hundreds of DOM nodes at once. Use @tanstack/react-virtual and keep the onLoadMore trigger working.",
        say1: "Let me look at the current TaskList implementation.",
        say2: "Rendering hundreds of rows at once is the bottleneck. @tanstack/react-virtual only renders the visible window.",
        say3: "Install the dependency, then rewrite the list.",
        say4: "Run the build to make sure the types are fine.",
        final: "Done: `TaskList` now uses `useVirtualizer` and renders only the visible window plus 8 rows of overscan; `onLoadMore` fires when scrolling within 3 rows of the end. Build passes.",
      },
      theme: {
        title: "Dark mode toggle does nothing",
        user: "The dark mode button in the top-right corner does nothing when clicked, and the console shows no errors.",
        think1: "No effect and no error usually means state updates but never reaches the document. Find the theme code first.",
        say1: "Let me find the theme-related code.",
        say2: "The button only updates state; it never writes the theme to `document.documentElement` and does not persist it. Adding an effect.",
        final: "The cause was that `ThemeToggle` only updated component state and never synced it to `document.documentElement.dataset.theme`, so the stylesheet selector never matched. Added a `useEffect` that applies the theme and stores the choice in `localStorage`.",
      },
      reconnect: {
        title: "Reconnect after IMAP IDLE drops",
        user: "The IMAP IDLE connection drops every few hours and notifications stop afterwards. Add reconnection with backoff.",
        think1: "watchInbox connects and idles but nobody handles the close event. Listen for close, reconnect with exponential backoff, and expose the connection status to the caller.",
        say1: "Let me look at the current connection logic.",
        say2: "Nothing listens for close after connecting, so one dropped connection ends notifications for good. Listen for close, reconnect with exponential backoff, and expose a status callback.",
        say3: "Now make the entry point log the connection status.",
        say4: "Run the tests.",
        final: "Changes:\n\n- `src/imap.ts`: listen for `close`, reconnect with 1s, 2s, 4s backoff capped at 5 minutes, reset the counter on success, and add `stop()` to shut down\n- `src/notify.ts`: write `connected` / `reconnecting` status to stdout\n\nAfter a drop the first reconnect attempt starts within a second.",
      },
    },
  },
};

/** 构建一种语言的完整计划：项目、会话步骤、标签、笔记。 */
export function buildPlan(lang, projectsRoot) {
  const t = TEXT[lang];
  if (!t) throw new Error(`unknown lang: ${lang}`);
  const dir = (name) => `${DEMO_HOME}/${name}`;
  const s = t.sessions;
  const apiDir = dir("taskboard-api");
  const runTests = (fileLines) => vitestRun(apiDir, fileLines);

  const sessions = [
    {
      key: "pagination",
      project: "taskboard-api",
      title: s.pagination.title,
      pinned: true,
      tags: ["enhancement"],
      modifiedAgoMin: 12,
      steps: [
        user(s.pagination.user),
        say({
          thinking: s.pagination.think1,
          text: s.pagination.say1,
          tools: [todo({ op: "init", list: s.pagination.phases.map((p) => ({ phase: p.name, items: p.items })) }, s.pagination.phases), read("src/routes/tasks.ts"), read("src/db.ts")],
        }),
        say({ thinking: "路由直接调用 listTasks()，没有任何分页参数；db.ts 也没有分页辅助。方案：加 listTasksPage({ page, pageSize, sort, order }) 返回 { items, total }；sort 和 order 走白名单；pageSize 默认 20、上限 100。", text: s.pagination.say2, tool: edit("src/db.ts", [{ oldText: DB_OLD_LIST, newText: DB_PAGINATION }]) }),
        say({
          tools: [
            edit("src/routes/tasks.ts", [{ oldText: TASKS_ROUTE_OLD, newText: TASKS_ROUTE_PAGED }]),
            todo({ op: "done", phase: s.pagination.phases[0].name }, null),
          ],
        }),
        say({ text: s.pagination.say3, tool: write("test/tasks.test.ts", api["test/tasks.test.ts"], TASKS_TESTS_OLD) }),
        say({ text: s.pagination.say4, tool: bash("npm test", runTests(" ✓ test/tasks.test.ts (5 tests) 812ms\n ✓ test/auth.test.ts (2 tests) 95ms"), 7) }),
        tool({ tool: todo({ op: "done", phase: s.pagination.phases[1].name }, null) }),
        say({ text: s.pagination.final }),
      ],
    },
    {
      key: "login",
      project: "taskboard-api",
      title: s.login.title,
      tags: ["bug"],
      modifiedAgoMin: 3 * 60,
      steps: [
        user(s.login.user),
        say({ thinking: s.login.think1, text: s.login.say1, tool: read("src/routes/auth.ts") }),
        say({ thinking: s.login.think2, text: s.login.say2, tool: edit("src/routes/auth.ts", [{ oldText: AUTH_EXPIRES_OLD, newText: AUTH_EXPIRES_NEW }]) }),
        tool({ tool: write("test/auth.test.ts", api["test/auth.test.ts"]) }),
        say({ text: s.login.say3, tool: bash("npm test", runTests(" ✓ test/tasks.test.ts (5 tests) 804ms\n ✓ test/auth.test.ts (2 tests) 61ms"), 6) }),
        say({ text: s.login.final }),
      ],
    },
    {
      key: "webhook",
      project: "taskboard-api",
      title: s.webhook.title,
      modifiedAgoMin: 26 * 60,
      steps: [
        user(s.webhook.user),
        say({ thinking: s.webhook.think1, text: s.webhook.say1, tool: read("src/webhook.ts") }),
        say({ text: s.webhook.say2, tool: write("test/webhook.test.ts", api["test/webhook.test.ts"]) }),
        say({ text: s.webhook.say3, tool: bash("npm test", runTests(" ✓ test/tasks.test.ts (5 tests) 790ms\n ✓ test/auth.test.ts (2 tests) 58ms\n ✓ test/webhook.test.ts (3 tests) 112ms"), 6) }),
        say({ text: s.webhook.final }),
      ],
    },
    {
      key: "hono",
      project: "taskboard-api",
      title: s.hono.title,
      modifiedAgoMin: 3 * 24 * 60,
      steps: [
        user(s.hono.user),
        say({ thinking: s.hono.think1, text: s.hono.say1, tool: bash("npm install hono@4.7.0", "\nadded 1 package, and audited 2 packages in 3s\n\n1 found 0 vulnerabilities\n", 4) }),
        tool({
          tool: bash("npm run typecheck", "\n> taskboard-api@0.3.2 typecheck\n> tsc -p tsconfig.json --noEmit\n\nsrc/middleware/logger.ts:6:31 - error TS2339: Property 'routePath' does not exist on type 'HonoRequest<string, Env, {}>'.\n\n6     getLogger().info(`${c.req.method} ${c.req.routePath} ${c.res.status} ${ms}ms`);\n                                    ~~~~~~~~~\n\nFound 1 error in src/middleware/logger.ts:6\n", 9),
        }),
        say({ thinking: s.hono.think2, text: s.hono.say2, tool: edit("src/middleware/logger.ts", [{ oldText: LOGGER_PATH_OLD, newText: LOGGER_PATH_NEW }]) }),
        tool({ tool: bash("npm run typecheck", "\n> taskboard-api@0.3.2 typecheck\n> tsc -p tsconfig.json --noEmit\n", 8) }),
        say({ text: s.hono.final }),
      ],
    },
    {
      key: "virtual",
      project: "taskboard-web",
      title: s.virtual.title,
      modifiedAgoMin: 2 * 24 * 60,
      steps: [
        user(s.virtual.user),
        say({ thinking: s.virtual.think1, text: s.virtual.say1, tool: read("src/components/TaskList.tsx") }),
        say({ text: s.virtual.say2, tool: bash("npm install @tanstack/react-virtual", "\nadded 1 package, and audited 3 packages in 2s\n\n1 found 0 vulnerabilities\n", 3) }),
        say({ text: s.virtual.say3, tool: edit("src/components/TaskList.tsx", [{ oldText: TASKLIST_OLD, newText: TASKLIST_VIRTUAL }]) }),
        say({ text: s.virtual.say4, tool: bash("npm run build", "\n> taskboard-web@0.2.0 build\n> tsc -b && vite build\n\nvite v6.0.5 building for production...\n✓ 34 modules transformed.\ndist/index.html                   0.48 kB\n dist/assets/index-C3k9x1Qa.css    1.21 kB │ gzip: 0.58 kB\n dist/assets/index-B7d2m4Lc.js   142.60 kB │ gzip: 46.12 kB\n✓ built in 2.41s\n", 11) }),
        say({ text: s.virtual.final }),
      ],
    },
    {
      key: "theme",
      project: "taskboard-web",
      title: s.theme.title,
      tags: ["bug"],
      modifiedAgoMin: 5 * 24 * 60,
      steps: [
        user(s.theme.user),
        say({ thinking: s.theme.think1, text: s.theme.say1, tool: grep("prefers-color-scheme|data-theme", "src", "src/components/ThemeToggle.tsx:11:  return window.matchMedia(\"(prefers-color-scheme: dark)\").matches ? \"dark\" : \"light\";\nsrc/styles.css:10: :root[data-theme=\"dark\"] {\n") }),
        say({ text: s.theme.say2, tool: edit("src/components/ThemeToggle.tsx", [{ oldText: "", newText: THEME_TOGGLE_EFFECT }]) }),
        say({ text: s.theme.final }),
      ],
    },
    {
      key: "reconnect",
      project: "inbox-notifier",
      title: s.reconnect.title,
      modifiedAgoMin: 6 * 24 * 60,
      steps: [
        user(s.reconnect.user),
        say({ thinking: s.reconnect.think1, text: s.reconnect.say1, tool: read("src/imap.ts") }),
        say({ text: s.reconnect.say2, tool: edit("src/imap.ts", [{ oldText: IMAP_OLD, newText: IMAP_RECONNECT }]) }),
        say({ text: s.reconnect.say3, tool: edit("src/notify.ts", [{ oldText: NOTIFY_STATUS_OLD, newText: NOTIFY_STATUS_NEW }]) }),
        say({ text: s.reconnect.say4, tool: bash("npm test", "\n> inbox-notifier@0.1.4 test\n> vitest run\n\n RUN  v2.1.8 " + dir("inbox-notifier") + "\n\n ✓ test/retry.test.ts (4 tests) 203ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n   Duration  0.71s\n", 4) }),
        say({ text: s.reconnect.final }),
      ],
    },
  ];

  return {
    lang,
    projects: DEMO_PROJECTS.map((p) => ({ name: p.name, path: `${projectsRoot}/${p.name}`, files: p.files })),
    tags: t.tags,
    notes: t.notes,
    sessions: sessions.map((session) => ({ ...session, steps: localizeSteps(session.steps, lang) })),
  };
}

/** 少数步骤的思考文案只写了一份中文，英文界面下替换成英文。 */
const THINKING_EN = [
  [
    "路由直接调用 listTasks()，没有任何分页参数；db.ts 也没有分页辅助。方案：加 listTasksPage({ page, pageSize, sort, order }) 返回 { items, total }；sort 和 order 走白名单；pageSize 默认 20、上限 100。",
    "The route calls listTasks() with no pagination parameters and db.ts has no pagination helper either. Plan: add listTasksPage({ page, pageSize, sort, order }) returning { items, total }; sort and order go through an allowlist; pageSize defaults to 20 with a cap of 100.",
  ],
];
function localizeSteps(steps, lang) {
  if (lang !== "en") return steps;
  return steps.map((step) => {
    if (!step.thinking) return step;
    const hit = THINKING_EN.find(([zh]) => zh === step.thinking);
    return hit ? { ...step, thinking: hit[1] } : step;
  });
}
