# claudecodeviewer

A desktop app for watching Claude Code work in real time on your local
projects. Open it and every project and session on the machine is already
there — no registration, no attach step, no server. It's **view-only by
design**: it never launches a Claude Code session or sends it a prompt;
it only reads the transcripts Claude Code itself writes. It also gives
Claude Code's global settings (`~/.claude/settings.json`) a small in-app
editor, since that file is otherwise hand-edited JSON with no UI at all.

## How it works

```
renderer (viewer/, in a BrowserWindow)
   |  window.viewerAPI.*  (IPC, via electron/preload.cjs)
   v
electron/main.cjs  <--(reads, never writes)--  ~/.claude/projects/**/*.jsonl
                                                (every session's transcript)
```

Claude Code keeps a durable, append-only transcript for **every** session
it runs, regardless of how it was started, at
`~/.claude/projects/<cwd, slashes as hyphens>/<session_id>.jsonl`. Those
files are this app's entire data model — the transcript *is* the
database, so there is nothing to ingest, sync, or lose when the viewer
wasn't running:

1. **Discovery** (`core/discover.js`) — scans that directory to answer
   "what sessions exist". A session whose transcript was written in the
   last 5 minutes is shown as live.
2. **History on demand** (`core/transcript.js`) — opening a session or
   project view parses the relevant transcript file(s) right then. The
   full history is always available, including everything that happened
   while this app was closed.
3. **Live updates** (`core/watch.js`) — one poller checks every
   transcript for appended bytes every 2 seconds and pushes each new line
   to the window as it lands; brand-new session files stream from byte 0
   so new sessions pop onto the dashboard by themselves. Polling instead
   of `fs.watch` is deliberate: recursive watch is inconsistent across
   platforms and quietly unreliable on some Windows setups, and a stat
   pass over a few dozen files is negligible.

The renderer never touches the filesystem itself — everything goes
through `window.viewerAPI` (`electron/preload.cjs`), an IPC bridge with
no direct Node or OS access, and the main process refuses transcript
paths outside the projects directory.

## The views

- **Dashboard** (default) — one card per *project* (sessions grouped by
  working directory), each showing whether anything's live and a one-line
  status derived from the latest transcript entries (`Running Bash`,
  `Processing tool result…`, `Idle`), updating live.
- **Project view** (click a card) — stat tiles (sessions, tool calls,
  files touched, turns) with a per-tool usage breakdown, a **roadmap**
  reconstructed from the project's own `TaskCreate`/`TaskUpdate` tool
  calls (progress bar + status-sorted task list; says so plainly if the
  project never used those tools), and its sessions.
- **Session view** (click a session) — the full event timeline as
  color-coded cards, each expandable to the raw JSON.
- **⚙ Settings** — edits `~/.claude/settings.json` as raw JSON (a form
  with fixed fields would go stale as Claude Code's settings schema
  evolves, or silently drop keys it doesn't know). Save validates the
  text parses as a JSON object before writing; anything else is rejected
  without touching the file.

## Running it

```bash
npm install
npm start
```

That's it — the dashboard fills in from `~/.claude/projects`
automatically, and updates live while any Claude Code session is running
anywhere on the machine.

Env overrides: `CLAUDE_VIEWER_PROJECTS_DIR` points discovery somewhere
other than `~/.claude/projects` (used by the tests to run against a
synthetic directory).

## Why this shape?

This project changed shape several times before landing here, and the
discarded designs explain the current one:

- **Not hooks**: the first version registered Claude Code hooks that
  POSTed JSON to a local server — one subprocess and HTTP call per event,
  and per-project configuration before anything showed up.
- **Not a spawner**: a later version launched `claude` as a child process
  over its stream-json protocol and could drive it. Removed — this app
  watches, it doesn't instruct, and that's enforced by construction (no
  IPC channel can write to a session).
- **Not a browser + server**: a browser tab can't read files; Electron's
  main process can, and talks to the window over IPC instead of a port.
- **Not a private database**: an earlier version ingested events into its
  own SQLite while attached, which meant history only existed if the
  viewer happened to be running and attached at the time. Reading the
  transcripts directly means the app is correct the moment it opens.
