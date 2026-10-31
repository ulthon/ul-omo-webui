# ul-omo-webui

A web workbench for the senpi/omo agent engine. Self-hosted, single user, feature set benchmarked against the opencode v1 TUI, usable from a phone browser.

[中文版](README.md)

## What it is

A web client that runs next to the engine: a Hono Node server serving a React 19 + Vite SPA. REST for upstream actions, SSE for the downstream event stream. Sessions run on the server, so locking your phone or killing the browser never interrupts an agent run; refresh and pick up where you left off.

Key features:

- Multi-session management: sidebar list with create, switch, delete, search, pin, archive, sort, unread counts and run-state badges
- Chat stream: incremental SSE rendering, Markdown and code highlighting (Shiki), collapsible thinking blocks, virtualized long sessions
- Tool call cards: name, argument summary, run status, collapsed results, diff views (react-diff-view)
- Permission prompts: card style allow/deny/always-allow, touch friendly
- Structured rendering of todos, subagent panel, question cards, memory panel, stats panel
- File tree with read-only preview and @-mentions into chat; built-in file management (upload/download/edit)
- Read-only Git view: uncommitted changes overview (git status/diff rendering)
- Project management: sessions grouped by working directory, per-project agent/model preferences, engine lifecycle managed by the server (per-project spawn, restart, idle reclaim)
- Auto session titles, cross-device input drafts, basic commands (/compact /clear /new /undo), stop button

## Quick start

Prerequisites:

- Node.js >= 24 (the server uses node:sqlite; package.json engines enforces >=24)
- The omo/senpi engine available (engine packages such as `@code-yeongyu/senpi` stay external and resolve from node_modules at runtime)

Install and build (npm workspace, run at the repo root):

```bash
npm install
npm run build   # builds the web frontend and bundles server/dist/index.js (esbuild single file, static assets embedded)
```

Start the server:

```bash
node server/dist/index.js
# or dev mode (server only, skips the frontend build):
cd server && npm run dev
```

The default listen address is `0.0.0.0:7788`, open <http://localhost:7788>. If `UL_OMO_WEBUI_PASSWORD` is unset on first start, the server generates a random password, prints it to the console and writes it to the `password` file in the data directory.

### Production deployment (systemd)

The built-in CLI generates the service for you (it snapshots the current environment into the unit; changing envs requires re-enabling):

```bash
ul-omo-webui startup enable [--system]
```

A hand-written unit looks like this (matching what `server/src/startup.ts` generates):

```ini
[Unit]
Description=ul-omo-webui (senpi/omo web workbench)
After=network-online.target

[Service]
ExecStart=/usr/bin/node /usr/lib/node_modules/@ulthon/ul-omo-webui/server/dist/index.js
Restart=on-failure
RestartSec=3
Environment=UL_OMO_WEBUI_PORT=7788
Environment=UL_OMO_WEBUI_PASSWORD=your-password
Environment=UL_OMO_WEBUI_DATA_DIR=/var/lib/ul-omo-webui

[Install]
WantedBy=multi-user.target
```

A user-level unit (`--user`) needs `loginctl enable-linger` to survive logout; a system-level unit (`--system`) has no such dependency and the unit file is tightened to mode 600. See docs/09-自启动与更新立项.md for the design.

## Environment variables

Every env var the server actually reads (sources: `server/src/config.ts`, `obs/logger.ts`, `auth/password.ts`, `api/perf.ts`, `api/http.ts`, `conf/config-store.ts`, `title-gen.ts`, `engine/schedule-runner.ts`, `engine/process-manager.ts`, `api/routes-memory.ts`).

| Variable | Default | Purpose |
|---|---|---|
| UL_OMO_WEBUI_HOST | 0.0.0.0 | Listen address |
| UL_OMO_WEBUI_PORT | 7788 | Listen port, invalid values abort startup |
| UL_OMO_WEBUI_DATA_DIR | source form server/data; npm install form platform data dir (Linux follows XDG_DATA_HOME, default ~/.local/share/ul-omo-webui; macOS Application Support; Windows APPDATA) | Runtime data dir (meta db, logs, PID registry, password file) |
| UL_OMO_WEBUI_STATIC_DIR | web/dist in source form | On-disk static dir, only read in source form or when explicitly set; installed builds use embedded assets |
| UL_OMO_WEBUI_META_DB | DATA_DIR/meta.db | Meta database (sqlite) path |
| UL_OMO_WEBUI_AGENT_DIR | ~/.omo/agent | Engine agent dir (credentials, custom models, session store), shared by spawn and SDK path resolution |
| UL_OMO_WEBUI_SITE_NAME | unset | Custom site name, injected into the tab title and top bar / login page; empty string counts as unset |
| UL_OMO_WEBUI_PASSWORD | randomly generated on first start, written to DATA_DIR/password | Login password |
| UL_OMO_WEBUI_LOG_LEVEL | info | Log level (trace/debug/info/warn/error) |
| UL_OMO_WEBUI_LOG_FILE | on | File logging toggle (0/false/no/off disables); dir is DATA_DIR/logs, daily rotation, 7 day retention |
| UL_OMO_WEBUI_DEBUG_SSE | off | SSE diagnostics logging (connections, state transitions, frame writes) |
| UL_OMO_WEBUI_DEBUG_PERF | off | Performance instrumentation logging (switch-path latency attribution) |
| UL_OMO_WEBUI_SLOW_MS | 1000 | Slow request threshold in milliseconds |
| UL_OMO_WEBUI_FS_UPLOAD_MAX_BYTES | 1073741824 (1 GiB) | Built-in file manager upload cap; invalid values warn and fall back |
| UL_OMO_WEBUI_CONFIG_DIR | ~/.config/ul-omo-webui | Global config store directory |
| UL_OMO_WEBUI_TITLE_BASEURL | https://api.z.ai/api/coding/paas/v4/chat/completions | API endpoint for auto session titles |
| UL_OMO_WEBUI_TITLE_MODEL | zai-coding-cn/glm-5.3-flash | Model used for auto titles |
| UL_OMO_WEBUI_TITLE_LANG | follows settings (zh) | Auto title language, only zh/en accepted |
| UL_OMO_WEBUI_SCHEDULE_DELIVER_URL | unset | Webhook URL for scheduled task result delivery |
| UL_OMO_WEBUI_SCHEDULE_DELIVER_TOKEN | unset | Bearer token for the delivery webhook |
| SENPI_ENGINE_PROBE_GATE | off | Engine process probe gate switch (read by the process manager) |
| OMO_MEMORY_HOME | ~/.omo/memory | Memory directory (read by the memory routes) |

Also: `XDG_DATA_HOME` (Linux) and `APPDATA` (Windows) indirectly affect data dir defaults; a systemd user unit carries the `PATH` captured at enable time (engine child processes spawn node by name).

## Directory layout

```
senpi-webui/
├── server/            # Hono Node server
│   ├── src/           # entry cli.ts/index.ts, config.ts, engine/ (process manager), api/ (REST+SSE routes), auth/, db/, obs/
│   ├── test/          # vitest suites
│   └── dist/          # build output (gitignored)
├── web/               # React + Vite SPA
│   ├── src/components/chat/   # chat UI components: sessions, message stream, tool cards, permissions, todos, subagents
│   ├── tests/         # vitest suites
│   └── dist/          # build output (gitignored)
├── docs/              # design docs
├── scripts/           # build scripts (build-package.mjs: esbuild bundling; build-binary.ts)
└── deploy/            # deployment helpers
```

## Docs

- [01-功能清单.md](docs/01-功能清单.md): feature scope and boundaries (Chinese)
- [02-技术选型.md](docs/02-技术选型.md): tech stack and rationale (Chinese)
- [03-架构设计.md](docs/03-架构设计.md): overall architecture and engine adapter (Chinese)
- [09-自启动与更新立项.md](docs/09-自启动与更新立项.md): autostart services and update mechanism (Chinese)

## Screenshots

<!-- TODO: add real images under docs/screenshots/ later -->

<!--
<img src="docs/screenshots/desktop-session.png" alt="Desktop session" width="800">
<img src="docs/screenshots/mobile-session.png" alt="Mobile session" width="390">
<img src="docs/screenshots/permission-card.png" alt="Permission card" width="390">
-->

## Development

```bash
npm test                          # run all workspace tests at the root (vitest)
cd web && npm run dev             # frontend dev server (Vite HMR)
cd server && npm run dev          # build server only, then start
cd web && npm run build           # tsc -b typecheck + vite build
cd web && npm run lint            # oxlint
```

- Tests: server and web each ship vitest suites (`server/test`, `web/tests`); `npm test` at the root runs both
- Type checking: the web build gates on `tsc -b`; the server bundles with esbuild
- Run `npm test` and the web `tsc -b` before submitting changes
