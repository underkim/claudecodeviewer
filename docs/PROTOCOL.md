# Claude Code Viewer — Event Protocol v1

This document defines the wire format used between **Claude Code** (the
producer, via its hooks system) and the **viewer server** (the consumer,
which stores events and streams them to connected browsers).

## Transport

- **Ingestion**: `POST /api/events` (HTTP, JSON body) — one event per request.
  Sent by the hook script (`hooks/emit-event.mjs`) that Claude Code invokes
  for each lifecycle hook.
- **Live delivery**: WebSocket at `/ws`. The server pushes every newly
  ingested event to all connected viewer clients as soon as it's stored.
- **History**: `GET /api/sessions` and `GET /api/sessions/:sessionId/events`
  (HTTP, JSON) let a viewer backfill events that happened before it connected.

The hook script is fire-and-forget: it POSTs with a short timeout and
**never fails or blocks Claude Code** if the viewer server is unreachable
(no server running is a normal, supported state).

## Envelope

Every event, whether stored in SQLite or pushed over the WebSocket, has this
shape:

```jsonc
{
  "protocolVersion": "1",
  "eventId": "b3f5b6b0-...",        // uuid, assigned by the server on ingest
  "sessionId": "b17b...",           // Claude Code session_id
  "receivedAt": "2026-07-11T05:10:00.000Z", // server ingest timestamp (ISO 8601)
  "hookEvent": "PreToolUse",        // see Hook Events below
  "cwd": "/home/user/project",
  "transcriptPath": "/home/user/.claude/projects/.../transcript.jsonl",
  "payload": { /* hook-specific fields, passed through verbatim */ }
}
```

The server does not interpret `payload` beyond storing/forwarding it as
JSON — it is exactly what Claude Code's hook runtime provides on stdin for
that hook event, so the viewer stays forward-compatible with new fields
Claude Code adds.

## Hook Events

These correspond 1:1 to Claude Code's hook lifecycle events
(https://docs.claude.com/en/docs/claude-code/hooks). The `payload` fields
listed are the ones the viewer actively renders; additional fields present
on stdin are stored but not specially handled.

| hookEvent          | payload fields commonly used                              | Meaning |
|---------------------|------------------------------------------------------------|---------|
| `SessionStart`       | `source` (`startup`\|`resume`\|`clear`\|`compact`)         | A session began or resumed |
| `UserPromptSubmit`   | `prompt`                                                    | User submitted a prompt |
| `PreToolUse`         | `tool_name`, `tool_input`                                   | About to run a tool |
| `PostToolUse`        | `tool_name`, `tool_input`, `tool_response`                  | Tool finished |
| `Notification`       | `message`                                                   | Claude Code surfaced a notification |
| `Stop`               | `stop_hook_active`                                          | Main agent turn finished |
| `SubagentStop`       | `stop_hook_active`                                          | A subagent turn finished |
| `PreCompact`         | `trigger` (`manual`\|`auto`)                                | Context is about to be compacted |

## Ingest request

```
POST /api/events
Content-Type: application/json

{
  "sessionId": "...",
  "hookEvent": "PreToolUse",
  "cwd": "...",
  "transcriptPath": "...",
  "payload": { "tool_name": "Bash", "tool_input": { "command": "ls" } }
}
```

Response: `201 { "eventId": "..." }` or `4xx/5xx { "error": "..." }`.

## WebSocket push

On connect, the server sends nothing proactively — the client fetches
history via REST, then listens for live updates. Every subsequent event is
pushed as:

```json
{ "type": "event", "data": { /* envelope, as above */ } }
```

A lightweight heartbeat may be sent as `{ "type": "ping" }`; clients don't
need to respond, it's just a pong-triggering keepalive at the WS layer.

## Versioning

`protocolVersion` is a string so it can be compared cheaply. Breaking
changes bump it; the server may choose to reject or namespace events from
mismatched versions in the future. Additive fields never bump the version.
