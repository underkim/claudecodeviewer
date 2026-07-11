# claudecodeviewer

A desktop app for watching Claude Code work in real time on your local
projects. It's **view-only by design**: it never launches a Claude Code
session or sends it a prompt — it only attaches to sessions already
running (a terminal, another tool, anywhere on the machine) and tails
what they're doing. It also gives Claude Code's global settings
(`~/.claude/settings.json`) a small in-app editor, since that file is
otherwise hand-edited JSON with no UI at all.

## How it works

```
renderer (viewer/, in a BrowserWindow)
   |  window.viewerAPI.*  (IPC, via electron/preload.cjs)
   v
electron/main.cjs  <--(reads, never writes)--  ~/.claude/projects/**/*.jsonl
   |                                            (a session's own transcript)
SQLite (core/db.js)
```

1. **Discovery & tailing** (`core/discover.js`, `core/tail.js`) — Claude
   Code keeps a live, append-only transcript for every session, regardless
   of what started it, at
   `~/.claude/projects/<cwd, slashes as hyphens>/<session_id>.jsonl`.
   `discover.js` scans that directory (most recently modified first) so
   the app can offer a picker instead of requiring a path; `tail.js` reads
   a chosen transcript from byte 0 and then follows further writes via
   `fs.watch` — the same idea as `tail -f`, with no dependency on who
   owns the underlying process, and no way to write back into it.
2. **Main process** (`electron/main.cjs`) — owns the file watchers,
   persists every message verbatim to SQLite (`core/db.js`), and pushes
   each one to the renderer window the instant it arrives. It also reads
   and writes `~/.claude/settings.json` for the settings editor.
3. **Renderer** (`viewer/`) — the window contents. The default view is a
   **dashboard**: one card per session, showing its project name, whether
   it's live, and a one-line status derived from its latest events
   (`Running Bash`, `Thinking…`, `Idle — turn complete`, `Session ended`,
   color-coded busy/idle/ended) — the "what's going on across everything"
   view, updating live as events stream in. Click a card to drop into
   that session's detail view: the full event timeline, tool calls, hook
   activity, and turn text as color-coded cards, read-only (no composer
   to send anything — just a Detach button), with a back button to
   return to the dashboard. The renderer never touches the filesystem or
   watches files itself — everything goes through `window.viewerAPI`
   (`electron/preload.cjs`), an IPC bridge with no direct Node or OS
   access.

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the full transcript
message reference, captured from a real session, not a schema invented
on top of it.

## Running it

```bash
npm install
npm start
```

This opens the app on the dashboard. Use "Attach to a running session" in
the sidebar — Refresh to list recently active Claude Code sessions on
this machine, click one to start tailing it. Its card appears on the
dashboard immediately; click through for the detail view, or Detach to
stop watching (this only stops the app's file watcher — the underlying
Claude Code session is never touched).

SQLite history is stored under `data/events.db` in the project directory
(gitignored); override with `CLAUDE_VIEWER_DB`.

## Global settings editor

The ⚙ Settings button opens a plain editor for
`~/.claude/settings.json` (or the equivalent path on Windows/macOS via
`os.homedir()`) — a raw JSON textarea rather than a form with fixed
fields. That's deliberate: Claude Code's settings schema is large and
changes over time, and a form baked in with today's known field names
would go stale or, worse, silently drop fields it doesn't recognize.
Reload re-reads the file (defaults to `{}` if it doesn't exist yet); Save
validates the text is a JSON object before writing it back, and refuses
to write anything else — you can't corrupt the file with a syntax
mistake, but the app also isn't guessing at what belongs in it.

## Why a desktop app, and why not hooks or spawning?

Three design decisions worth knowing about, since this project changed
shape twice before landing here:

- **Desktop app, not a browser + server**: a browser tab can't watch
  files or hold a pipe open to a CLI tool — only a real process with
  Node/OS access can. Electron's main process *is* that process, so it
  can do that directly and talk to the window over IPC, instead of
  running an HTTP/WebSocket server on a port just to bridge browser
  sandboxing.
- **View-only, not a launcher**: earlier versions could also spawn a
  `claude` process and send it prompts and follow-up messages. That's
  gone — the app now only reads what Claude Code itself already wrote to
  disk. It can't instruct Claude Code to do anything, by construction,
  not just by convention.
- **Tailing a transcript, not hooks**: an even earlier version used
  Claude Code's hooks system — a script run as a subprocess per lifecycle
  event, POSTing JSON to a server. It worked, but every "event" required
  spawning a new process and a one-way HTTP call. Reading the transcript
  Claude Code already keeps for every session is simpler and needs no
  configuration on the session's side at all.
