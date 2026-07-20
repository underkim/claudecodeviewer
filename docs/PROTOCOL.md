# Claude Code Viewer — Protocol

This app is **read-only**: it never spawns a `claude` process or writes
anything to a session's input. Everything it shows comes from reading
files Claude Code already writes on its own — the per-session transcript
for session data, and `~/.claude/settings.json` for the settings editor
(reads to populate the editor; writes only when you explicitly hit Save).

## Source of truth: the transcript files

Claude Code keeps a durable, append-only transcript for **every**
session, regardless of what started it, at:

```
~/.claude/projects/<cwd, every "/" replaced with "-">/<session_id>.jsonl
```

(Override the root with `CLAUDE_VIEWER_PROJECTS_DIR`, mainly for tests.)

The app never maintains its own copy of this data:

- `core/discover.js` — scans the directory (most recently modified
  first) to enumerate sessions. It peeks at the first ~8KB of each file
  for a `cwd` field (the real value) rather than decoding the
  hyphen-joined directory name (lossy if the real path contains hyphens).
  A session is "live" if its transcript was modified within the last
  5 minutes (`LIVE_WINDOW_MS`) — liveness can't be read off a process
  table, since the app never owns or even knows the claude processes.
- `core/transcript.js` — parses a whole transcript into envelopes on
  demand, whenever a session or project view needs history. Lines without
  a `timestamp` field inherit the previous line's, which preserves
  ordering. Parsed results are cached keyed on the file's size+mtime
  (safe for append-only files), so project-view refreshes only re-parse
  transcripts that actually changed.
- `core/watch.js` — a single poller (every 2s) stats every transcript;
  files that grew stream their appended lines, files that appeared stream
  from byte 0. Polling is deliberate — recursive `fs.watch` is
  inconsistent across platforms and quietly unreliable on some Windows
  setups, and a stat pass over a few dozen files is negligible.

## Message types in a transcript

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

There's no token-level granularity (entries appear once Claude Code
writes them) and no explicit "turn result" message — the dashboard's
activity line (`Running <tool>`, `Processing tool result…`, `Idle`) is
derived client-side from whichever of these arrived most recently
(`deriveActivity()` in `viewer/app.js`), and the project view's stats and
task roadmap are reduced from the full history (`computeProjectStats()`),
including reconstructing the roadmap from `TaskCreate`/`TaskUpdate` tool
calls — a task's numeric id only appears in `TaskCreate`'s result text
(`"Task #7 created successfully: ..."`), so results are correlated back
to their tool call via `tool_use_id`.

## Envelope sent to the renderer

Every transcript line is wrapped (`core/transcript.js`) before being
returned or pushed:

```jsonc
{
  "protocolVersion": "2",
  "eventId": "uuid",            // viewer-assigned
  "sessionId": "...",           // from the transcript's filename
  "receivedAt": "2026-07-13T05:20:00.000Z", // line's own timestamp (history) or arrival time (live)
  "type": "assistant",          // raw.type, passed through
  "subtype": null,              // raw.subtype, passed through (often null)
  "transcriptPath": "...",      // which file this came from
  "raw": { /* the exact parsed transcript line, untouched */ }
}
```

`raw` is never reshaped — new fields Claude Code adds show up immediately
without a code change.

## IPC surface (Electron main process ↔ renderer)

The main process (`electron/main.cjs`) owns all filesystem access; the
renderer (`viewer/`) only calls `window.viewerAPI`
(`electron/preload.cjs`), which forwards to `ipcMain.handle` channels:

- `viewerAPI.listSessions()` → `sessions:list` — a fresh directory scan:
  `{ sessionId, cwd, transcriptPath, lastEventAt, isLive }` per session.
- `viewerAPI.getSessionEvents(transcriptPath)` → `sessions:events` —
  parses that transcript in full. The path is validated to resolve inside
  the projects directory; anything else is rejected.
- `viewerAPI.getEventsForProject(cwd)` → `sessions:eventsForCwd` — parses
  every transcript whose `cwd` matches and returns the merged,
  timestamp-sorted history.
- `viewerAPI.readSettings()` → `settings:read` — reads
  `~/.claude/settings.json`, returning `{ path, contents, exists }`
  (`contents` is `"{}\n"` and `exists: false` if the file doesn't exist
  yet).
- `viewerAPI.writeSettings(contents)` → `settings:write` — validates
  `contents` parses as a JSON object, then writes it verbatim; rejects
  (and writes nothing) otherwise.
- `viewerAPI.onEvent(callback)` — subscribes to `viewer:event`, pushed by
  the main process for every newly appended transcript line anywhere
  under the projects directory. No registration per session — new
  sessions announce themselves.
