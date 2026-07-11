# Claude Code Viewer — Protocol v2

v1 of this document specified a protocol we invented ourselves: a hook
script that Claude Code ran as a subprocess per lifecycle event, POSTing
JSON to a server over HTTP. That worked, but it wasn't really a contract
*with* Claude Code — it was a workaround built entirely on our side, one
HTTP round trip per event, one-way, and unable to see anything happening
between hook boundaries (streamed text, partial tool input, etc).

v2 drops that layer. Claude Code already exposes a real, bidirectional,
documented protocol for exactly this purpose — the same one the Claude
Agent SDK is built on — and this viewer now speaks it directly.

## Transport: the `claude` CLI itself

The Electron main process spawns `claude` as a child process:

```
claude --print \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  [--model <model>] \
  [--permission-mode <mode>]
```

- **stdin**: newline-delimited JSON. Each line is one conversational turn:
  ```json
  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
  ```
  The process is kept alive between turns — sending another line on stdin
  continues the same session, same conversation.
- **stdout**: newline-delimited JSON. Every message Claude Code emits about
  its own execution — not just tool calls, but token-level streaming,
  hook lifecycle, rate limits, turn results — comes through here, verbatim,
  as it happens.

This is a single persistent pipe per session: the main process *is* the
parent process, so it knows the session's progress by construction, not
by inference from a side channel.

## Message types observed on stdout

These are Claude Code's own message types (captured directly from a real
`claude -p --output-format stream-json` run — this is not a schema we
made up):

| `type`             | `subtype`                              | Meaning |
|--------------------|-----------------------------------------|---------|
| `system`            | `init`                                   | Session started: `session_id`, `cwd`, `model`, `tools`, `permissionMode` |
| `system`            | `status`                                 | Lightweight state change (`requesting`, `responding`, …) |
| `system`            | `hook_started` / `hook_response`         | A project hook fired as part of this turn (`hook_name`, `exit_code`, `stdout`/`stderr`) |
| `system`            | `post_turn_summary`                      | Short human-readable recap of what just happened |
| `stream_event`      | —                                        | Wraps a raw Anthropic API streaming event (`message_start`, `content_block_delta` with `text_delta`/`input_json_delta`, `content_block_stop`, `message_delta`, `message_stop`) — token-by-token output |
| `assistant`         | —                                        | A complete assistant message for this turn (text and/or `tool_use` blocks), superseding the partial `stream_event`s that built up to it |
| `user`              | —                                        | A synthetic "user" turn Claude Code feeds back to itself carrying `tool_result` content |
| `result`            | `success` / `error_*`                    | Turn finished: final `result` text, `duration_ms`, `total_cost_usd`, `usage`, `permission_denials` |
| `rate_limit_event`  | —                                        | Rate-limit status snapshot |
| `active_goal`       | —                                        | The active `/goal` condition, if any |

Every message carries `session_id`, so the main process never has to
wait for a specific message to learn which session an event belongs to —
the very first line already has it.

## Envelope stored in SQLite / sent to the renderer

The main process wraps each raw message before storing/forwarding it:

```jsonc
{
  "protocolVersion": "2",
  "eventId": "uuid",           // main-process-assigned
  "sessionId": "...",          // Claude Code's own session_id
  "receivedAt": "2026-07-11T05:20:00.000Z",
  "type": "assistant",         // raw.type, passed through
  "subtype": null,             // raw.subtype, passed through (often null)
  "raw": { /* the exact parsed stdout line, untouched */ }
}
```

`raw` is never reshaped — new fields Claude Code adds show up immediately
without a code change.

One synthetic type is added by the main process itself, clearly
namespaced so it's never confused with Claude Code's own protocol:
`engine` (`subtype`: `exit`, `stderr`, `unparsed_stdout`) — bookkeeping
about the child process (it exited, it wrote to stderr, a line failed to
parse).

## IPC surface (Electron main process ↔ renderer)

This app is a desktop app, not a client/server pair over a network port.
The main process (`electron/main.cjs`) owns the `claude` child processes
directly; the renderer (`viewer/`, running in a `BrowserWindow`) never
touches the network or the filesystem itself — it only calls the API
`electron/preload.cjs` exposes on `window.viewerAPI`, which forwards to
`ipcMain.handle` channels in the main process:

- `viewerAPI.createSession({ cwd, prompt, model?, permissionMode? })` →
  `sessions:create` — spawns a new `claude` child process in `cwd`, sends
  `prompt` as the first turn, resolves `{ sessionId }` once Claude Code
  reports its own session id.
- `viewerAPI.sendMessage(sessionId, text)` → `sessions:message` — writes
  another turn to a live session's stdin.
- `viewerAPI.stopSession(sessionId)` → `sessions:stop` — sends `SIGTERM`
  to the child.
- `viewerAPI.listSessions()` / `viewerAPI.getSessionEvents(sessionId)` →
  `sessions:list` / `sessions:events` — history, backed by SQLite.
- `viewerAPI.pickDirectory()` → `dialog:pickDirectory` — native OS folder
  picker for choosing a project directory.
- `viewerAPI.onEvent(callback)` — subscribes to `viewer:event`, which the
  main process pushes (`mainWindow.webContents.send`) for every new
  message as it's ingested, no polling involved.

## A note on environment isolation

`claude` reads several `CLAUDE_CODE_*` environment variables to attach to
an existing session (useful when Claude Code re-execs itself, harmful
here). The main process explicitly strips `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_REMOTE_SESSION_ID`, and `CLAUDE_CODE_CHILD_SESSION` from the
child's environment before spawning (`core/engine.js`) — otherwise, if
the viewer app itself happens to be launched from inside a Claude Code
session, every session it launches would silently attach to *that* one
instead of starting its own.
