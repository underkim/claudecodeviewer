# claudecodeviewer

A real-time viewer for what Claude Code is doing. The server launches
Claude Code itself as a child process and speaks its native `stream-json`
protocol — the same structured, bidirectional interface the Claude Agent
SDK is built on — so it knows every token, tool call, and lifecycle event
directly, as it happens, with nothing invented in between.

## How it works

```
browser  <--(WebSocket push)-->  server  <--(stdin/stdout, stream-json)-->  claude (child process)
                                    |
                              SQLite storage
```

1. **Engine** (`server/engine.js`) — spawns
   `claude --print --input-format stream-json --output-format stream-json
   --verbose --include-partial-messages` for a given working directory.
   Every conversational turn goes in over stdin as one JSON line; every
   message Claude Code emits about its own execution — token deltas, tool
   calls, hook firings, turn results — comes out over stdout as one JSON
   line. The pipe stays open, so a session can take follow-up prompts.
2. **Server** (`server/index.js`) — owns the child process, persists every
   message verbatim to SQLite (`server/db.js`), and pushes each one to
   connected browsers over a WebSocket the instant it arrives.
3. **Viewer** (`viewer/`) — a static page (no build step): launch a new
   session (working directory + prompt) or pick a running one, and watch
   its assistant text stream in token-by-token, tool calls, hook activity,
   and turn results as color-coded cards. A composer lets you send
   follow-up messages to a live session, or stop it.

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the full message reference
— it documents Claude Code's actual protocol, captured from a real run,
not a schema invented on top of it.

## Running it

```bash
npm install
npm start          # starts the viewer server on http://localhost:4317
```

Open http://localhost:4317, fill in a working directory and a prompt in
the "New session" panel, and hit Launch. The session's output streams in
live; use the composer at the bottom to send follow-up turns, or Stop to
end it.

Configuration (env vars):
- `CLAUDE_VIEWER_PORT` — server port (default `4317`).
- `CLAUDE_VIEWER_DB` — SQLite file path (default `data/events.db`,
  gitignored).
- `CLAUDE_VIEWER_CLAUDE_BIN` — path to the `claude` executable, if it's
  not on `PATH` (default `claude`).

## Why not hooks?

An earlier version of this project used Claude Code's hooks system: a
script run as a subprocess per lifecycle event, POSTing JSON to this
server over HTTP. It worked, but every "event" required spawning a new
process and a one-way HTTP call, and it couldn't see anything between
hook boundaries (streamed text, partial tool input). Speaking Claude
Code's own `stream-json` protocol directly — with the server as the
actual parent process — is a real contract instead of a workaround: one
persistent pipe, bidirectional, and it surfaces everything Claude Code
itself knows about its own progress.
