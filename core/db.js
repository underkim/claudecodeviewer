import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CLAUDE_VIEWER_DB || path.join(__dirname, '..', 'data', 'events.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// node:sqlite is built into Node/Electron itself — no native addon to
// compile, so no NODE_MODULE_VERSION mismatch between the system Node
// used for `npm install` and the Node version Electron bundles.
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    cwd TEXT,
    model TEXT,
    permission_mode TEXT,
    created_at TEXT NOT NULL,
    ended_at TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    msg_type TEXT NOT NULL,
    msg_subtype TEXT,
    received_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, received_at);
`);

const upsertSessionStmt = db.prepare(`
  INSERT INTO sessions (session_id, cwd, model, permission_mode, created_at)
  VALUES (@sessionId, @cwd, @model, @permissionMode, @createdAt)
  ON CONFLICT(session_id) DO NOTHING
`);

const endSessionStmt = db.prepare(`
  UPDATE sessions SET ended_at = @endedAt WHERE session_id = @sessionId
`);

const insertEventStmt = db.prepare(`
  INSERT INTO events (event_id, session_id, msg_type, msg_subtype, received_at, payload)
  VALUES (@eventId, @sessionId, @msgType, @msgSubtype, @receivedAt, @payload)
`);

export function createSession({ sessionId, cwd, model, permissionMode }) {
  upsertSessionStmt.run({
    sessionId,
    cwd: cwd ?? null,
    model: model ?? null,
    permissionMode: permissionMode ?? null,
    createdAt: new Date().toISOString(),
  });
}

export function endSession(sessionId) {
  endSessionStmt.run({ sessionId, endedAt: new Date().toISOString() });
}

export function insertEvent(envelope) {
  insertEventStmt.run({
    eventId: envelope.eventId,
    sessionId: envelope.sessionId,
    msgType: envelope.type,
    msgSubtype: envelope.subtype ?? null,
    receivedAt: envelope.receivedAt,
    payload: JSON.stringify(envelope.raw ?? {}),
  });
}

function rowToEnvelope(row) {
  return {
    protocolVersion: '2',
    eventId: row.event_id,
    sessionId: row.session_id,
    receivedAt: row.received_at,
    type: row.msg_type,
    subtype: row.msg_subtype,
    raw: JSON.parse(row.payload),
  };
}

export function listSessions() {
  return db.prepare(`
    SELECT
      s.session_id AS sessionId,
      s.cwd,
      s.model,
      s.permission_mode AS permissionMode,
      s.created_at AS createdAt,
      s.ended_at AS endedAt,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) AS eventCount,
      (SELECT MAX(received_at) FROM events e WHERE e.session_id = s.session_id) AS lastEventAt
    FROM sessions s
    ORDER BY s.created_at DESC
  `).all();
}

export function listEventsForSession(sessionId) {
  return db.prepare(`
    SELECT * FROM events WHERE session_id = ? ORDER BY received_at ASC
  `).all(sessionId).map(rowToEnvelope);
}
