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
   **dashboard**: one card per *project* (sessions grouped by working
   directory — a project can have several, past or live), showing
   whether anything's live and a one-line status derived from the
   busiest session's latest events (`Running Bash`, `Thinking…`, `Idle`,
   `Ended`, color-coded), updating live as events stream in. Click a card
   for the **project view**: stat tiles (sessions, tool calls, files
   touched, turns) and a tool-usage breakdown, a **roadmap** reconstructed
   from the project's `TaskCreate`/`TaskUpdate` tool calls (a progress bar
   plus each task's status), and the list of sessions under it — click
   one of those for the full event timeline (tool calls, hook activity,
   turn text as color-coded cards), read-only, with a Detach button. Back
   buttons return to the dashboard at each level. The renderer never
   touches the filesystem or watches files itself — everything goes
   through `window.viewerAPI` (`electron/preload.cjs`), an IPC bridge
   with no direct Node or OS access.

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

## Project stats & roadmap

Clicking a dashboard card doesn't just replay the raw event log — it
computes, across every session recorded under that working directory:

- **Stats**: session count (and how many are live), total tool calls,
  distinct files touched (from `file_path`/`path` on tool inputs), and
  turn count, plus a breakdown of which tools were used how often.
- **Roadmap**: Claude Code's own `TaskCreate`/`TaskUpdate` tool calls are
  effectively a todo list already — `computeProjectStats()` in
  `viewer/app.js` reconstructs it from the transcript (a task's numeric
  id only appears in `TaskCreate`'s result text, e.g. `"Task #7 created
  successfully: ..."`, so it's correlated back to the tool call via
  `tool_use_id`) and shows it as a progress bar plus a status-sorted list
  (`in_progress` → `pending` → `completed`). If a project's sessions
  never used those tools, this section just says so — it's not invented.

This is computed in the renderer from `viewerAPI.getEventsForProject(cwd)`
(→ `sessions:eventsForCwd`, `core/db.js`), which pulls every event for
every session sharing that `cwd` in one query; nothing beyond what's
already in the transcripts is used.

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
