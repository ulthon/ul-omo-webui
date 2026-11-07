# ul-omo-webui

The web UI for omo native — works out of the box on desktop and mobile browsers.

[中文版](README.zh-CN.md)

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

## Quick Start

Prerequisites: Node.js >= 24 (the server uses node:sqlite) and a working npm registry.

Install and run (global package, ready to use):

```bash
npm install -g @ulthon/ul-omo-webui
ul-omo-webui
```

The server listens on `0.0.0.0:7788` by default; open <http://localhost:7788> in a browser. On first start, if `UL_OMO_WEBUI_PASSWORD` is not set, a random password is generated, printed to the console and written to the `password` file in the data directory — use it to sign in.

Run as a daemon (systemd-managed, auto-start on boot, auto-restart on crash):

```bash
sudo ul-omo-webui startup enable --system     # system-level service (recommended for servers)
ul-omo-webui startup status --system          # check service status
sudo ul-omo-webui startup disable --system    # stop and remove the service
```

A user-level service (`ul-omo-webui startup enable`, without `sudo`) suits personal machines; `enable` automatically attempts `loginctl enable-linger` so it survives logout, printing a warning if that fails (run it manually in that case).

Upgrading: check and self-update in one click from the Settings page (npm global reinstall + self-healing restart); or from a terminal, `npm install -g @ulthon/ul-omo-webui@latest` then `systemctl restart ul-omo-webui` (system-level service; for a user-level service use `systemctl --user restart ul-omo-webui`).

## Environment variables

Every user-facing env var the server reads (sources: `server/src/config.ts`, `obs/logger.ts`, `auth/password.ts`, `api/perf.ts` + `conf/diagnostics-flags.ts`, `api/http.ts`, `conf/config-store.ts`, `title-gen.ts`, `engine/schedule-runner.ts`, `engine/process-manager.ts`, `api/routes-memory.ts` + `lib/runtime-retention.ts`, `startup.ts`). Not listed: internal/QA override vars of the update module (`UL_OMO_WEBUI_UPDATE_REGISTRY`, `UL_OMO_WEBUI_UPDATE_PKG`, `UL_OMO_WEBUI_UPDATE_CURRENT_OVERRIDE`, `UL_OMO_WEBUI_UPDATE_ENGINE_PKG`, `UL_OMO_WEBUI_UPDATE_ENGINE_BIN`, `UL_OMO_WEBUI_UPDATE_RESTART_CMD` from `update/checker.ts` / `update/installer.ts`) — leave them unset in normal deployments.

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
| OMO_MEMORY_HOME | ~/.omo/memory | Memory directory (read by memory routes and runtime retention) |

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
- [03-架构设计.md](docs/03-架构设计.md): overall architecture and engine adapter (Chinese)
- Built-in updater: check for new versions and self-update from Settings (npm global reinstall + self-healing restart)

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
cd web && npm run scan:cn         # hardcoded-Chinese scan
```

- Tests: server and web each ship vitest suites (`server/test`, `web/tests`); `npm test` at the root runs both
- Type checking: the web build gates on `tsc -b`; the server bundles with esbuild
- Run `npm test` and the web `tsc -b` before submitting changes
