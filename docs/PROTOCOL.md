# Claude Code Viewer — Protocol

This app is **read-only**: it never spawns a `claude` process or writes
anything to a session's input. Everything it shows comes from reading
files Claude Code already writes on its own — the per-session transcript
for session data, and `~/.claude/settings.json` for the settings editor
(reads to populate the editor; writes only when you explicitly hit Save).

An earlier version spoke Claude Code's `stream-json` child-process
protocol directly (the same one the Claude Agent SDK uses) to launch and
drive sessions from the app. That capability was deliberately removed —
this app doesn't instruct Claude Code, only watches it — so that protocol
isn't documented here anymore; what follows is what the app actually
reads today.

## Transport: tailing a transcript file

Claude Code keeps a durable, append-only transcript for **every**
session, regardless of what started it, at:

```
~/.claude/projects/<cwd, every "/" replaced with "-">/<session_id>.jsonl
```

- `core/discover.js` scans that directory (most recently modified first)
  so the app can offer a picker instead of requiring a path. It peeks at
  the first ~8KB of each file for a `cwd` field (real value) rather than
  trying to decode it from the hyphen-joined directory name (lossy if the
  real path contains hyphens).
- `core/tail.js` reads a chosen transcript from byte 0 — backfilling
  everything Claude Code has logged so far — and then watches the file
  for further writes (`fs.watch` + a tracked byte offset), parsing each
  newly appended line the moment it lands. Same idea as `tail -f`,
  implemented without a subprocess. There is no way to write back into
  the file or the session — attaching is purely observational.

## Message types in the transcript

Captured from a real transcript, not invented:

| `type`              | Meaning |
|----------------------|---------|
| `user` / `assistant`  | `message.content` blocks (`text`, `tool_use`, `tool_result`) — the actual conversation and tool activity |
| `queue-operation`     | A turn was enqueued/dequeued for processing |
| `attachment`          | Auxiliary context attached to a turn (skills, agents, deferred tools) |
| `ai-title`            | An auto-generated short title for the session |
| `last-prompt`         | The most recent prompt text, kept for quick lookup |
| `mode`                | A mode/permission-state change |
| `system`              | Occasional session-level notes (subtype varies) |

There's no token-level granularity here (entries appear once Claude Code
writes them, not as they're generated) and no explicit "turn result"
message — the dashboard's activity line (`Running <tool>`, `Thinking…`,
`Idle`, `Session ended`) is derived client-side from whichever of these
messages arrived most recently (see `deriveActivity()` in
`viewer/app.js`), not read directly off the wire.

## Envelope stored in SQLite / sent to the renderer

The main process wraps each raw transcript line before storing/forwarding it:

```jsonc
{
  "protocolVersion": "2",
  "eventId": "uuid",           // main-process-assigned
  "sessionId": "...",          // Claude Code's own session_id
  "receivedAt": "2026-07-11T05:20:00.000Z",
  "type": "assistant",         // raw.type, passed through
  "subtype": null,             // raw.subtype, passed through (often null)
  "raw": { /* the exact parsed transcript line, untouched */ }
}
```

`raw` is never reshaped — new fields Claude Code adds show up immediately
without a code change. One synthetic type is added by the main process
itself, clearly namespaced so it's never confused with something Claude
Code wrote: `engine` (`subtype`: `exit`, `stderr`, `unparsed_stdout`) —
bookkeeping about the file watcher itself (an error reading the file, a
line that failed to parse).

## IPC surface (Electron main process ↔ renderer)

The main process (`electron/main.cjs`) owns all filesystem access; the
renderer (`viewer/`, running in a `BrowserWindow`) only calls the API
`electron/preload.cjs` exposes on `window.viewerAPI`, which forwards to
`ipcMain.handle` channels in the main process:

- `viewerAPI.discoverSessions()` → `sessions:discover` — scans
  `~/.claude/projects` for transcripts not already being tracked, most
  recently modified first.
- `viewerAPI.attachSession({ sessionId, transcriptPath, cwd })` →
  `sessions:attach` — starts tailing an existing transcript file.
- `viewerAPI.detachSession(sessionId)` → `sessions:detach` — stops
  tailing it (the underlying Claude Code session, if still running, is
  never touched).
- `viewerAPI.listSessions()` / `viewerAPI.getSessionEvents(sessionId)` →
  `sessions:list` / `sessions:events` — history, backed by SQLite.
- `viewerAPI.getEventsForProject(cwd)` → `sessions:eventsForCwd` — every
  event from every session recorded under that `cwd`, in one query
  (`core/db.js`'s `listEventsForCwd`); the renderer reduces this to the
  project view's stats and task roadmap (`computeProjectStats()` in
  `viewer/app.js`) rather than the main process precomputing them.
- `viewerAPI.readSettings()` → `settings:read` — reads
  `~/.claude/settings.json`, returning `{ path, contents, exists }`
  (`contents` is `"{}\n"` and `exists: false` if the file doesn't exist
  yet).
- `viewerAPI.writeSettings(contents)` → `settings:write` — validates
  `contents` parses as a JSON object, then writes it verbatim; rejects
  (and writes nothing) if it doesn't parse or isn't an object.
- `viewerAPI.onEvent(callback)` — subscribes to `viewer:event`, which the
  main process pushes (`mainWindow.webContents.send`) for every new
  transcript line as it's ingested, no polling involved.
