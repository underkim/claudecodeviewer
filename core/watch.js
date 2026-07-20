import fs from 'node:fs';
import { discoverSessions } from './discover.js';
import { sessionIdFromPath } from './transcript.js';

/**
 * Follows every transcript under ~/.claude/projects at once, emitting each
 * newly appended line as it lands — no per-session setup. Files that
 * already exist when watching starts are baselined at their current size
 * (history is read on demand via core/transcript.js, not replayed here);
 * files that appear later are new sessions and stream from byte 0.
 *
 * Deliberately polling (default every 2s) instead of fs.watch: recursive
 * fs.watch is inconsistent across platforms and quietly unreliable on
 * some Windows setups (OneDrive-backed folders, network drives), and a
 * stat pass over a few dozen files every couple of seconds is negligible.
 * Reliability beats latency here.
 */
export function watchProjects({ onMessage, intervalMs = 2000 }) {
  /** @type {Map<string, { offset: number, pending: Buffer }>} */
  const files = new Map();

  for (const s of discoverSessions()) {
    files.set(s.transcriptPath, { offset: s.sizeBytes, pending: Buffer.alloc(0) });
  }

  function drainFile(transcriptPath, size) {
    let st = files.get(transcriptPath);
    if (!st) {
      st = { offset: 0, pending: Buffer.alloc(0) };
      files.set(transcriptPath, st);
    }
    if (size < st.offset) {
      // Truncated/replaced (e.g. /clear rewrote it) — start over.
      st.offset = 0;
      st.pending = Buffer.alloc(0);
    }
    if (size === st.offset) return;

    let chunk;
    try {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const len = size - st.offset;
        const buf = Buffer.alloc(len);
        const bytesRead = fs.readSync(fd, buf, 0, len, st.offset);
        chunk = buf.subarray(0, bytesRead);
        st.offset += bytesRead;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return; // transient read failure — retry next tick
    }

    // Split on newline at the BYTE level and only decode complete lines.
    // A poll boundary can land mid-way through a multi-byte UTF-8
    // character (e.g. Korean text); decoding each chunk independently
    // would corrupt that character on both sides and lose the line.
    // 0x0A never occurs inside a multi-byte UTF-8 sequence, so byte-level
    // splitting is safe.
    st.pending = st.pending.length === 0 ? chunk : Buffer.concat([st.pending, chunk]);
    let idx;
    while ((idx = st.pending.indexOf(0x0a)) !== -1) {
      const line = st.pending.subarray(0, idx).toString('utf8');
      st.pending = st.pending.subarray(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(sessionIdFromPath(transcriptPath), JSON.parse(line), transcriptPath);
      } catch {
        // Corrupt line — skip it rather than stall the watcher.
      }
    }
    // Detach the leftover partial line from the big chunk buffer so we
    // don't pin the whole read in memory until the line completes.
    if (st.pending.length > 0) st.pending = Buffer.from(st.pending);
  }

  function tick() {
    const seen = new Set();
    for (const s of discoverSessions()) {
      seen.add(s.transcriptPath);
      drainFile(s.transcriptPath, s.sizeBytes);
    }
    // Forget files that no longer exist (deleted transcripts) so the
    // map doesn't grow forever.
    for (const p of files.keys()) {
      if (!seen.has(p)) files.delete(p);
    }
  }

  const timer = setInterval(tick, intervalMs);

  return {
    close() {
      clearInterval(timer);
    },
  };
}
