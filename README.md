# claudecodeviewer

A desktop app for watching Claude Code work in real time on your local
projects. It launches Claude Code itself as a child process and speaks
its native `stream-json` protocol — the same structured, bidirectional
interface the Claude Agent SDK is built on — so it knows every token,
tool call, and lifecycle event directly, as it happens, with nothing
invented in between.

## How it works

```
renderer (viewer/, in a BrowserWindow)
   |  window.viewerAPI.*  (IPC, via electron/preload.cjs)
   v
electron/main.cjs  <--(stdin/stdout, stream-json)-->  claude (child process)
   |
SQLite (core/db.js)
```

1. **Engine** (`core/engine.js`) — spawns
   `claude --print --input-format stream-json --output-format stream-json
   --verbose --include-partial-messages` for a given working directory.
   Every conversational turn goes in over stdin as one JSON line; every
   message Claude Code emits about its own execution — token deltas, tool
   calls, hook firings, turn results — comes out over stdout as one JSON
   line. The pipe stays open, so a session can take follow-up prompts.
2. **Main process** (`electron/main.cjs`) — owns the child processes,
   persists every message verbatim to SQLite (`core/db.js`), and pushes
   each one to the renderer window the instant it arrives. It also
   exposes a native OS folder picker for choosing a project directory.
3. **Renderer** (`viewer/`) — the window contents: launch a new session
   (working directory + prompt) or pick a running one, and watch its
   assistant text stream in token-by-token, tool calls, hook activity,
   and turn results as color-coded cards. A composer lets you send
   follow-up messages to a live session, or stop it. It never touches the
   filesystem or spawns processes itself — everything goes through
   `window.viewerAPI` (`electron/preload.cjs`), an IPC bridge with no
   direct Node or OS access.

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the full message reference
— it documents Claude Code's actual protocol, captured from a real run,
not a schema invented on top of it.

## Running it

```bash
npm install
npm start
```

`npm install` also rebuilds `better-sqlite3` against Electron's own Node
ABI via a `postinstall` hook (`electron-rebuild`) — a plain `npm install`
compiles native modules against your system Node, which has a different
ABI than the one bundled in Electron, so without this step the app fails
at startup with an `NODE_MODULE_VERSION` mismatch. If you ever see that
error, re-run `npx electron-rebuild -f -w better-sqlite3`.

This opens the app window. Fill in a working directory (or use Browse…)
and a prompt in the "New session" panel, and hit Launch. The session's
output streams in live; use the composer at the bottom to send follow-up
turns, or Stop to end it.

Requires the `claude` CLI to be installed and on `PATH` (or set
`CLAUDE_VIEWER_CLAUDE_BIN` to its full path). SQLite history is stored
under `data/events.db` in the project directory (gitignored); override
with `CLAUDE_VIEWER_DB`.

## Why a desktop app, and why not hooks?

Two design decisions worth knowing about, since both changed from
earlier iterations of this project:

- **Desktop app, not a browser + server**: a browser tab can't spawn OS
  processes or hold open a pipe to a CLI tool — only a real process with
  Node/OS access can. Electron's main process *is* that process, so it
  can own `claude` directly and talk to it over IPC with the window,
  instead of running an HTTP/WebSocket server on a port just to bridge
  browser sandboxing.
- **Native `stream-json` protocol, not hooks**: an earlier version used
  Claude Code's hooks system — a script run as a subprocess per lifecycle
  event, POSTing JSON to a server. It worked, but every "event" required
  spawning a new process and a one-way HTTP call, and it couldn't see
  anything between hook boundaries (streamed text, partial tool input).
  Speaking Claude Code's own `stream-json` protocol directly — with the
  app as the actual parent process — is a real contract instead of a
  workaround: one persistent pipe, bidirectional, surfacing everything
  Claude Code itself knows about its own progress.
