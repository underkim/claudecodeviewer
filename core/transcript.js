import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function sessionIdFromPath(transcriptPath) {
  return path.basename(transcriptPath).replace(/\.jsonl$/, '');
}

export function wrapEnvelope(sessionId, raw, receivedAt, transcriptPath) {
  return {
    protocolVersion: '2',
    eventId: randomUUID(),
    sessionId,
    receivedAt,
    type: raw.type,
    subtype: raw.subtype ?? null,
    transcriptPath,
    raw,
  };
}

/**
 * Parses a whole transcript file into envelopes, on demand. History is
 * read straight from the file every time a view needs it — the transcript
 * IS the database, so there's nothing to ingest, sync, or lose when the
 * viewer wasn't running.
 *
 * Not every transcript line carries a `timestamp` (user/assistant and
 * queue-operation entries do; ai-title/last-prompt don't), so lines
 * without one inherit the previous line's — good enough for ordering,
 * which is already guaranteed by file position within one session.
 */
export function readTranscriptEvents(transcriptPath) {
  let text;
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }

  const sessionId = sessionIdFromPath(transcriptPath);
  let fallbackTs;
  try {
    fallbackTs = fs.statSync(transcriptPath).mtime.toISOString();
  } catch {
    fallbackTs = new Date().toISOString();
  }

  const events = [];
  let lastTs = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (raw.timestamp) lastTs = raw.timestamp;
    events.push(wrapEnvelope(sessionId, raw, lastTs || fallbackTs, transcriptPath));
  }
  return events;
}
