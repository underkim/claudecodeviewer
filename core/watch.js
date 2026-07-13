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
  /** @type {Map<string, { offset: number, buffer: string }>} */
  const files = new Map();

  for (const s of discoverSessions()) {
    files.set(s.transcriptPath, { offset: s.sizeBytes, buffer: '' });
  }

  function drainFile(transcriptPath, size) {
    let st = files.get(transcriptPath);
    if (!st) {
      st = { offset: 0, buffer: '' };
      files.set(transcriptPath, st);
    }
    if (size < st.offset) {
      // Truncated/replaced (e.g. /clear rewrote it) — start over.
      st.offset = 0;
      st.buffer = '';
    }
    if (size === st.offset) return;

    let chunk;
    try {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const len = size - st.offset;
        const buf = Buffer.alloc(len);
        const bytesRead = fs.readSync(fd, buf, 0, len, st.offset);
        chunk = buf.toString('utf8', 0, bytesRead);
        st.offset += bytesRead;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return; // transient read failure — retry next tick
    }

    st.buffer += chunk;
    let idx;
    while ((idx = st.buffer.indexOf('\n')) !== -1) {
      const line = st.buffer.slice(0, idx);
      st.buffer = st.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(sessionIdFromPath(transcriptPath), JSON.parse(line), transcriptPath);
      } catch {
        // Corrupt line — skip it rather than stall the watcher.
      }
    }
  }

  function tick() {
    for (const s of discoverSessions()) {
      drainFile(s.transcriptPath, s.sizeBytes);
    }
  }

  const timer = setInterval(tick, intervalMs);

  return {
    close() {
      clearInterval(timer);
    },
  };
}
