import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CLAUDE_VIEWER_DB || path.join(__dirname, '..', 'data', 'events.db');

import fs from 'node:fs';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    hook_event TEXT NOT NULL,
    received_at TEXT NOT NULL,
    cwd TEXT,
    transcript_path TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, received_at);
`);

const insertStmt = db.prepare(`
  INSERT INTO events (event_id, session_id, hook_event, received_at, cwd, transcript_path, payload)
  VALUES (@eventId, @sessionId, @hookEvent, @receivedAt, @cwd, @transcriptPath, @payload)
`);

export function insertEvent(envelope) {
  insertStmt.run({
    eventId: envelope.eventId,
    sessionId: envelope.sessionId,
    hookEvent: envelope.hookEvent,
    receivedAt: envelope.receivedAt,
    cwd: envelope.cwd ?? null,
    transcriptPath: envelope.transcriptPath ?? null,
    payload: JSON.stringify(envelope.payload ?? {}),
  });
}

function rowToEnvelope(row) {
  return {
    protocolVersion: '1',
    eventId: row.event_id,
    sessionId: row.session_id,
    hookEvent: row.hook_event,
    receivedAt: row.received_at,
    cwd: row.cwd,
    transcriptPath: row.transcript_path,
    payload: JSON.parse(row.payload),
  };
}

export function listSessions() {
  const rows = db.prepare(`
    SELECT
      session_id AS sessionId,
      COUNT(*) AS eventCount,
      MIN(received_at) AS startedAt,
      MAX(received_at) AS lastEventAt,
      (SELECT cwd FROM events e2 WHERE e2.session_id = e1.session_id AND cwd IS NOT NULL LIMIT 1) AS cwd
    FROM events e1
    GROUP BY session_id
    ORDER BY lastEventAt DESC
  `).all();
  return rows;
}

export function listEventsForSession(sessionId) {
  const rows = db.prepare(`
    SELECT * FROM events WHERE session_id = ? ORDER BY received_at ASC
  `).all(sessionId);
  return rows.map(rowToEnvelope);
}
