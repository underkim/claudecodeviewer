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

// The project view re-reads a whole project's history on every refresh
// (debounced to ~0.4s while events stream in), and transcripts can be
// megabytes. Parsed results are cached keyed on the file's size+mtime —
// append-only files make that a safe fingerprint — so a refresh only
// re-parses transcripts that actually changed.
const parseCache = new Map(); // transcriptPath -> { size, mtimeMs, events }
const PARSE_CACHE_MAX = 24;

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
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return [];
  }

  const cached = parseCache.get(transcriptPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.events;
  }

  let text;
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }

  const sessionId = sessionIdFromPath(transcriptPath);
  const fallbackTs = stat.mtime.toISOString();

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

  if (parseCache.size >= PARSE_CACHE_MAX && !parseCache.has(transcriptPath)) {
    parseCache.delete(parseCache.keys().next().value);
  }
  parseCache.set(transcriptPath, { size: stat.size, mtimeMs: stat.mtimeMs, events });
  return events;
}
