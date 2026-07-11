# claudecodeviewer

A real-time viewer for what Claude Code is doing, built on Claude Code's
hooks system. It captures every hook event (prompts, tool calls, results,
session lifecycle) as it happens and streams it into a live web dashboard.

## How it works

```
Claude Code  --(hook fires)-->  hooks/emit-event.mjs  --(HTTP POST)-->  server
                                                                          |
                                                                    SQLite storage
                                                                          |
browser  <--(WebSocket push)--  server  <-----------------------------+
```

1. **Hooks** — `.claude/settings.json` registers `hooks/emit-event.mjs` for
   every Claude Code hook event (`SessionStart`, `UserPromptSubmit`,
   `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SubagentStop`,
   `PreCompact`). The script reads the hook's JSON off stdin and forwards it
   to the viewer server. If the server isn't running, it silently no-ops —
   Claude Code is never blocked or slowed down.
2. **Server** (`server/`) — an Express + `ws` app that ingests events over
   `POST /api/events`, persists them to SQLite (`better-sqlite3`), and
   pushes each one to every connected browser over a WebSocket in real
   time. It also serves the viewer's static frontend and history endpoints
   (`GET /api/sessions`, `GET /api/sessions/:id/events`).
3. **Viewer** (`viewer/`) — a small static page (no build step) that lists
   sessions in a sidebar and renders events as they arrive: color-coded by
   hook type, with the raw JSON payload expandable per event.

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the full wire format.

## Running it

```bash
npm install
npm start          # starts the viewer server on http://localhost:4317
```

Open http://localhost:4317 in a browser, then run Claude Code in this repo
(hooks are already wired up in `.claude/settings.json`). Every prompt, tool
call, and lifecycle event shows up live.

To point the hooks/server at a different port, set `CLAUDE_VIEWER_PORT`
(defaults to `4317`) for both the server and any Claude Code session using
the hooks. The SQLite file location can be overridden with
`CLAUDE_VIEWER_DB` (defaults to `data/events.db`, gitignored).

## Using it from another project

Copy `hooks/emit-event.mjs` into the other project (or reference this repo's
copy by absolute path) and add the same hook entries to that project's
`.claude/settings.json`, pointing `command` at the script via
`$CLAUDE_PROJECT_DIR` or an absolute path. Run this repo's server
separately — it has no dependency on which project's Claude Code session is
feeding it events, since every event is tagged with `sessionId` and `cwd`.
