// README 截图用的演示项目：三个看起来像真在用的仓库，目录与源码文件由 seed-demo.mjs 落盘。
// 会话脚本（demo-content.mjs）里 read 结果引用这些文件，edit 步骤按 oldText/newText 反推改动前内容。

export const DEMO_PROJECTS = [
  {
    name: "taskboard-api",
    files: {
      "package.json": `{
  "name": "taskboard-api",
  "version": "0.3.2",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.8",
    "hono": "^4.7.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "skipLibCheck": true
  },
  "include": ["src"]
}
`,
      ".gitignore": `node_modules/
dist/
data/*.db
.env
`,
      "README.md": `# taskboard-api

REST API for the Taskboard demo. Hono + node:sqlite, no services.

\`\`\`bash
npm install
npm run dev        # http://localhost:3000
npm test
\`\`\`

## Endpoints

| Method | Path           | Description                     |
| ------ | -------------- | ------------------------------- |
| GET    | /api/tasks     | List tasks (paged and sortable) |
| POST   | /api/tasks     | Create a task                   |
| GET    | /api/tasks/:id | Fetch one task                   |
| POST   | /auth/login   | Exchange credentials for cookie  |
| POST   | /auth/logout  | Clear the session cookie         |
`,
      "src/index.ts": `import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { auth } from "./routes/auth";
import { tasks } from "./routes/tasks";
import { logger } from "./middleware/logger";

const app = new Hono();
const port = Number(process.env.PORT) || 3000;

app.use("*", logger());
app.route("/auth", auth);
app.route("/api", tasks);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(\`listening on :\${info.port}\`);
});
`,
      "src/middleware/logger.ts": `import type { Context, Next } from "hono";
import { getLogger } from "../log";

export function logger() {
  return async (c: Context, next: Next) => {
    const started = performance.now();
    await next();
    const ms = Math.round(performance.now() - started);
    getLogger().info(\`\${c.req.method} \${c.req.path} \${c.res.status} \${ms}ms\`);
  };
}
`,
      "src/log.ts": `type Level = "info" | "warn" | "error";

export const logger = {
  info: (msg: string) => write("info", msg),
  warn: (msg: string) => write("warn", msg),
  error: (msg: string) => write("error", msg),
};

function write(level: Level, msg: string) {
  const line = \`\${new Date().toISOString()} [\${level}] \${msg}\`;
  (level === "error" ? console.error : console.log)(line);
}

export function getLogger() {
  return logger;
}
`,
      "src/db.ts": `import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.DB_PATH ?? "data/taskboard.db");

db.exec(\`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    priority INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
\`);

export type TaskStatus = "todo" | "doing" | "done";

export type Task = {
  id: number;
  title: string;
  status: TaskStatus;
  priority: number;
  dueDate: string | null;
  createdAt: string;
};

export type TaskSort = "createdAt" | "dueDate" | "priority";
export type SortOrder = "asc" | "desc";

const SORT_COLUMNS: Record<TaskSort, string> = {
  createdAt: "created_at",
  dueDate: "due_date",
  priority: "priority",
};

export type TaskPage = {
  items: Task[];
  total: number;
  page: number;
  pageSize: number;
};

/** 分页 + 排序查询。sort/order 走白名单，禁止把用户输入直接拼进 SQL。 */
export function listTasksPage(input: {
  page?: number;
  pageSize?: number;
  sort?: TaskSort;
  order?: SortOrder;
  status?: TaskStatus;
}): TaskPage {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 20));
  const column = SORT_COLUMNS[input.sort ?? "createdAt"];
  const order = input.order === "asc" ? "ASC" : "DESC";
  const offset = (page - 1) * pageSize;

  const where = input.status ? "WHERE status = ?" : "";
  const params: unknown[] = input.status ? [input.status] : [];

  const { total } = db.prepare(\`SELECT COUNT(*) AS total FROM tasks \${where}\`).get(...params) as {
    total: number;
  };
  const items = db
    .prepare(
      \`SELECT id, title, status, priority, due_date, created_at FROM tasks \${where}
       ORDER BY \${column} \${order}, id DESC LIMIT ? OFFSET ?\`,
    )
    .all(...params, pageSize, offset) as TaskRow[];

  return {
    items: items.map(toTask),
    total,
    page,
    pageSize,
  };
}

export function createTask(input: { title: string; priority?: number; dueDate?: string | null }) {
  const result = db
    .prepare("INSERT INTO tasks (title, priority, due_date) VALUES (?, ?, ?)")
    .run(input.title, input.priority ?? 0, input.dueDate ?? null);
  return getTask(Number(result.lastInsertRowid));
}

export function getTask(id: number) {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  return row ? toTask(row) : null;
}

type TaskRow = {
  id: number;
  title: string;
  status: TaskStatus;
  priority: number;
  due_date: string | null;
  created_at: string;
};

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    createdAt: row.created_at,
  };
}
`,
      "src/routes/tasks.ts": `import { Hono } from "hono";
import { createTask, getTask, listTasksPage } from "../db";
import type { SortOrder, TaskSort } from "../db";

export const tasks = new Hono();

const SORTS: readonly TaskSort[] = ["createdAt", "dueDate", "priority"];
const ORDERS: readonly SortOrder[] = ["asc", "desc"];

tasks.get("/", (c) => {
  const page = Number(c.req.query("page") ?? 1);
  const pageSize = Number(c.req.query("pageSize") ?? 20);
  const sort = c.req.query("sort") ?? "createdAt";
  const order = c.req.query("order") ?? "desc";

  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return c.json({ error: "page must be >= 1 and pageSize must be between 1 and 100" }, 400);
  }
  if (!SORTS.includes(sort as TaskSort) || !ORDERS.includes(order as SortOrder)) {
    return c.json({ error: \`unsupported sort or order\` }, 400);
  }

  return c.json(listTasksPage({ page, pageSize, sort: sort as TaskSort, order: order as SortOrder }));
});

tasks.post("/", async (c) => {
  const body = await c.req.json<{ title: string; priority?: number; dueDate?: string }>();
  if (!body.title?.trim()) {
    return c.json({ error: "title is required" }, 400);
  }
  return c.json(createTask(body), 201);
});

tasks.get("/:id", (c) => {
  const task = getTask(Number(c.req.param("id")));
  return task ? c.json(task) : c.json({ error: "not found" }, 404);
});
`,
      "src/routes/auth.ts": `import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { signSession, verifySession } from "../auth/session";
import { verifyCredentials } from "../auth/credentials";

export const auth = new Hono();

const COOKIE_NAME = "tb_session";
/** 14 天，单位是秒。 */
const MAX_AGE = 14 * 24 * 60 * 60;

auth.post("/login", async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  const user = await verifyCredentials(email, password);
  if (!user) return c.json({ error: "invalid credentials" }, 401);

  const token = await signSession({ sub: user.id });
  setCookie(c, COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: MAX_AGE,
    expires: new Date(Date.now() + MAX_AGE * 1000),
  });
  return c.json({ ok: true });
});

auth.get("/me", (c) => {
  const token = getCookie(c, COOKIE_NAME);
  const session = token ? verifySession(token) : null;
  return c.json({ user: session ? { id: session.sub } : null });
});

auth.post("/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});
`,
      "src/auth/session.ts": `import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.SESSION_SECRET ?? "dev-secret";
const TTL_SECONDS = 14 * 24 * 60 * 60;

type Claims = { sub: string; exp: number };

export async function signSession(claims: { sub: string }) {
  const payload: Claims = { sub: claims.sub, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS };
  return seal(JSON.stringify(payload));
}

export function verifySession(token: string): Claims | null {
  const raw = unseal(token);
  if (!raw) return null;
  const claims = JSON.parse(raw) as Claims;
  return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
}

function seal(value: string) {
  const mac = createHmac("sha256", SECRET).update(value).digest("base64url");
  return \`\${Buffer.from(value).toString("base64url")}.\${mac}\`;
}

function unseal(token: string) {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", SECRET).update(Buffer.from(body, "base64url")).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Buffer.from(body, "base64url").toString();
}
`,
      "src/auth/credentials.ts": `export type User = { id: string; email: string };

const USERS: User[] = [
  { id: "u_1", email: "dana@example.com" },
  { id: "u_2", email: "ming@example.com" },
];

/** 演示用：任意密码都通过，只校验邮箱是否存在。 */
export async function verifyCredentials(email: string, _password: string) {
  return USERS.find((u) => u.email === email) ?? null;
}
`,
      "src/webhook.ts": `const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

type Delivery = { attempt: number; status: number; delayMs: number };

/** 投递 webhook：失败最多重试 3 次，指数退避；429 尊重 Retry-After。 */
export async function deliverWebhook(
  url: string,
  payload: unknown,
  deps: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<Delivery> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { attempt, status: res.status, delayMs: 0 };

    const retryAfter = res.status === 429 ? Number(res.headers.get("retry-after")) * 1000 : NaN;
    const delayMs = Number.isFinite(retryAfter) ? retryAfter : BASE_DELAY_MS * 2 ** (attempt - 1);
    if (attempt === MAX_ATTEMPTS) return { attempt, status: res.status, delayMs };
    await sleep(delayMs);
  }
  throw new Error("unreachable");
}
`,
      "test/tasks.test.ts": `import { beforeEach, describe, expect, it } from "vitest";
import { createTask, listTasksPage } from "../src/db";

describe("listTasksPage", () => {
  beforeEach(() => {
    process.env.DB_PATH = ":memory:";
  });

  function seed(count: number, prefix = "task") {
    for (let i = 1; i <= count; i++) createTask({ title: \`\${prefix} \${i}\`, priority: i % 3 });
  }

  it("returns the first page with a total", () => {
    seed(25);
    const page = listTasksPage({ page: 1, pageSize: 20 });
    expect(page.items).toHaveLength(20);
    expect(page.total).toBe(25);
  });

  it("returns an empty last page past the end", () => {
    seed(5);
    expect(listTasksPage({ page: 3, pageSize: 5 }).items).toHaveLength(0);
  });

  it("clamps pageSize to 100", () => {
    seed(3);
    expect(listTasksPage({ pageSize: 500 }).pageSize).toBe(100);
  });

  it("sorts by priority ascending", () => {
    seed(6);
    const priorities = listTasksPage({ sort: "priority", order: "asc" }).items.map((t) => t.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  it("filters by status", () => {
    createTask({ title: "only todo" });
    expect(listTasksPage({ status: "doing" }).total).toBe(0);
  });
});
`,
      "test/auth.test.ts": `import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { auth } from "../src/routes/auth";

const app = new Hono().route("/auth", auth);

describe("POST /auth/login", () => {
  it("sets a session cookie that expires in about 14 days", async () => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dana@example.com", password: "pw" }),
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    const expires = /Expires=([^;]+)/i.exec(setCookie)?.[1];
    expect(expires).toBeTruthy();
    const days = (new Date(expires!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it("rejects unknown emails", async () => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "pw" }),
    });
    expect(res.status).toBe(401);
  });
});
`,
      "test/webhook.test.ts": `import { describe, expect, it } from "vitest";
import { deliverWebhook } from "../src/webhook";

function harness(responses: Array<{ status: number; retryAfter?: string }>) {
  const calls: { attempt: number; delayMs: number }[] = [];
  const sleeps: number[] = [];
  let attempt = 0;
  const fetch = (async () => {
    const current = responses[Math.min(attempt, responses.length - 1)];
    attempt += 1;
    return new Response(null, {
      status: current.status,
      headers: current.retryAfter ? { "retry-after": current.retryAfter } : {},
    });
  }) as typeof globalThis.fetch;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { fetch, sleep, calls, sleeps, attempts: () => attempt };
}

describe("deliverWebhook", () => {
  it("retries up to 3 times with exponential backoff", async () => {
    const h = harness([{ status: 500 }, { status: 500 }, { status: 500 }]);
    const result = await deliverWebhook("https://example.com/hook", {}, h);
    expect(h.attempts()).toBe(3);
    expect(h.sleeps).toEqual([500, 1000]);
    expect(result.status).toBe(500);
  });

  it("stops after the first success", async () => {
    const h = harness([{ status: 502 }, { status: 200 }]);
    const result = await deliverWebhook("https://example.com/hook", {}, h);
    expect(h.attempts()).toBe(2);
    expect(result.status).toBe(200);
  });

  it("waits for Retry-After on 429", async () => {
    const h = harness([{ status: 429, retryAfter: "2" }]);
    await deliverWebhook("https://example.com/hook", {}, h);
    expect(h.sleeps[0]).toBe(2000);
  });
});
`,
    },
  },
  {
    name: "taskboard-web",
    files: {
      "package.json": `{
  "name": "taskboard-web",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "lint": "eslint src"
  },
  "dependencies": {
    "@tanstack/react-virtual": "^3.11.2",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "eslint": "^9.17.0",
    "typescript": "^5.7.2",
    "vite": "^6.0.5"
  }
}
`,
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Taskboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
      "src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
      "src/App.tsx": `import { useEffect, useState } from "react";
import { TaskList } from "./components/TaskList";
import { ThemeToggle } from "./components/ThemeToggle";
import { listTasks } from "./api/client";
import type { Task } from "./api/client";

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  useEffect(() => {
    listTasks({ page }).then((result) => {
      setTasks((previous) => (page === 1 ? result.items : [...previous, ...result.items]));
      setTotal(result.total);
    });
  }, [page]);

  return (
    <main className="app">
      <header className="app-header">
        <h1>Taskboard</h1>
        <ThemeToggle />
      </header>
      <TaskList tasks={tasks} total={total} onLoadMore={() => setPage((p) => p + 1)} />
    </main>
  );
}
`,
      "src/components/TaskList.tsx": `import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { Task } from "../api/client";

const ROW_HEIGHT = 44;

type Props = {
  tasks: Task[];
  total: number;
  onLoadMore: () => void;
};

export function TaskList({ tasks, total, onLoadMore }: Props) {
  const parentRef = useRef<HTMLUListElement>(null);
  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const lastRow = virtualizer.getVirtualItems().at(-1);
  if (lastRow && lastRow.index >= tasks.length - 3 && tasks.length < total) {
    onLoadMore();
  }

  return (
    <ul className="task-list" ref={parentRef} style={{ height: "100vh", overflow: "auto" }}>
      <li style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((row) => {
          const task = tasks[row.index];
          return (
            <div
              key={task.id}
              className="task-row"
              style={{ position: "absolute", top: 0, transform: \`translateY(\${row.start}px)\`, height: ROW_HEIGHT }}
            >
              <span className={\`status status-\${task.status}\`}>{task.status}</span>
              <span className="title">{task.title}</span>
            </div>
          );
        })}
      </li>
    </ul>
  );
}
`,
      "src/components/ThemeToggle.tsx": `import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={\`Switch to \${theme === "dark" ? "light" : "dark"} theme\`}
      onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
    >
      {theme === "dark" ? "Light" : "Dark"} mode
    </button>
  );
}

type Theme = "light" | "dark";

function readStoredTheme(): Theme {
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
`,
      "src/api/client.ts": `const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export type TaskStatus = "todo" | "doing" | "done";

export type Task = {
  id: number;
  title: string;
  status: TaskStatus;
  priority: number;
  dueDate: string | null;
  createdAt: string;
};

export async function listTasks(params: { page: number; pageSize?: number; sort?: string; order?: string }) {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize ?? 20),
    sort: params.sort ?? "createdAt",
    order: params.order ?? "desc",
  });
  const res = await fetch(\`\${BASE_URL}/api/tasks?\${query}\`);
  if (!res.ok) throw new Error(\`listTasks failed: \${res.status}\`);
  return (await res.json()) as { items: Task[]; total: number; page: number; pageSize: number };
}
`,
      "src/styles.css": `:root {
  --bg: #ffffff;
  --fg: #111827;
  --muted: #6b7280;
  --accent: #2563eb;
}

:root[data-theme="dark"] {
  --bg: #0b1120;
  --fg: #e5e7eb;
  --muted: #9ca3af;
  --accent: #60a5fa;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: Inter, system-ui, sans-serif;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid color-mix(in srgb, var(--fg) 10%, transparent);
}

.task-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 24px;
  border-bottom: 1px solid color-mix(in srgb, var(--fg) 6%, transparent);
}

.status {
  font-size: 12px;
  text-transform: uppercase;
  color: var(--muted);
}
`,
    },
  },
  {
    name: "inbox-notifier",
    files: {
      "package.json": `{
  "name": "inbox-notifier",
  "version": "0.1.4",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node dist/notify.js",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "imapflow": "^1.0.170",
    "nodemailer": "^6.9.16"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
`,
      "README.md": `# inbox-notifier

Watches an IMAP inbox with IDLE and forwards new mail as desktop notifications.
Reconnects with exponential backoff when the IDLE connection drops.

\`\`\`bash
npm install
IMAP_HOST=imap.example.com IMAP_USER=me@example.com IMAP_PASS=... npm start
\`\`\`
`,
      "src/config.ts": `export type Config = {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
  reconnect: { initialDelayMs: number; maxDelayMs: number; factor: number };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.IMAP_HOST;
  const user = env.IMAP_USER;
  const password = env.IMAP_PASS;
  if (!host || !user || !password) {
    throw new Error("IMAP_HOST, IMAP_USER and IMAP_PASS are required");
  }
  return {
    host,
    port: Number(env.IMAP_PORT ?? 993),
    user,
    password,
    mailbox: env.IMAP_MAILBOX ?? "INBOX",
    reconnect: {
      initialDelayMs: 1_000,
      maxDelayMs: 5 * 60_000,
      factor: 2,
    },
  };
}
`,
      "src/imap.ts": `import { ImapFlow } from "imapflow";
import type { Config } from "./config";

type Handlers = {
  onMail: (count: number) => Promise<void>;
  onStatus?: (status: "connected" | "disconnected" | "reconnecting") => void;
};

/** 建立 IDLE 连接并保持；断线后按指数退避重连。 */
export function watchInbox(config: Config, handlers: Handlers) {
  let client: ImapFlow | null = null;
  let attempt = 0;
  let stopped = false;

  async function connect() {
    client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.port === 993,
      auth: { user: config.user, pass: config.password },
      logger: false,
    });
    client.on("close", () => void reconnect());
    client.on("exists", ({ count }: { count: number }) => void handlers.onMail(count));

    await client.connect();
    await client.mailboxOpen(config.mailbox);
    await client.idle();
    attempt = 0;
    handlers.onStatus?.("connected");
  }

  async function reconnect() {
    if (stopped) return;
    const delay = Math.min(
      config.reconnect.maxDelayMs,
      config.reconnect.initialDelayMs * config.reconnect.factor ** attempt,
    );
    attempt += 1;
    handlers.onStatus?.("reconnecting");
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (stopped) return;
    await connect().catch(() => void reconnect());
  }

  void connect().catch(() => void reconnect());

  return {
    async stop() {
      stopped = true;
      await client?.logout().catch(() => undefined);
    },
  };
}
`,
      "src/notify.ts": `import { watchInbox } from "./imap";
import { loadConfig } from "./config";
import { notify } from "./desktop";

const config = loadConfig();
const mailboxes = new Map<string, number>();

watchInbox(config, {
  async onMail(count) {
    const previous = mailboxes.get(config.mailbox) ?? count;
    mailboxes.set(config.mailbox, count);
    const fresh = count - previous;
    if (fresh <= 0) return;
    await notify("inbox-notifier", \`\${fresh} new message\${fresh === 1 ? "" : "s"} in \${config.mailbox}\`);
  },
  onStatus(status) {
    process.stdout.write(\`[\${new Date().toISOString()}] \${status}\\n\`);
  },
});
`,
      "src/desktop.ts": `import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Linux 走 notify-send，macOS 走 osascript；都没有时退回控制台输出。 */
export async function notify(title: string, body: string) {
  if (process.platform === "darwin") {
    await run("osascript", ["-e", \`display notification \${JSON.stringify(body)} with title \${JSON.stringify(title)}\`]).catch(
      () => console.log(\`\${title}: \${body}\`),
    );
    return;
  }
  await run("notify-send", ["-a", title, body]).catch(() => console.log(\`\${title}: \${body}\`));
}
`,
    },
  },
];
