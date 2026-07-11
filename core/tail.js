import fs from 'node:fs';

/**
 * Follows a Claude Code transcript file (~/.claude/projects/<cwd>/<session_id>.jsonl)
 * from wherever it already is, backfilling existing lines and then
 * streaming new ones as Claude Code appends to it — independent of
 * whether *this* process spawned that Claude Code session. This is how
 * the viewer can watch a session someone started in their own terminal.
 *
 * Unlike core/engine.js, this is read-only: there's no stdin to write
 * follow-up turns into, since we're not the parent process.
 *
 * @param {string} transcriptPath
 * @param {(message: object) => void} onMessage
 * @param {(error: Error) => void} [onError]
 */
export function attachToTranscript(transcriptPath, { onMessage, onError }) {
  let offset = 0;
  let buffer = '';
  let closed = false;
  let reading = false;
  let pending = false;

  function processChunk(chunk) {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // Partial or corrupt line — skip it rather than crash the tail.
      }
    }
  }

  function readNewData() {
    if (closed) return;
    if (reading) {
      pending = true;
      return;
    }
    reading = true;
    fs.stat(transcriptPath, (err, stats) => {
      if (closed) return;
      if (err) {
        reading = false;
        onError?.(err);
        return;
      }
      if (stats.size <= offset) {
        reading = false;
        if (pending) { pending = false; readNewData(); }
        return;
      }
      const stream = fs.createReadStream(transcriptPath, {
        start: offset,
        end: stats.size - 1,
        encoding: 'utf8',
      });
      let data = '';
      stream.on('data', (c) => { data += c; });
      stream.on('error', (e) => {
        reading = false;
        onError?.(e);
      });
      stream.on('end', () => {
        offset = stats.size;
        processChunk(data);
        reading = false;
        if (pending) { pending = false; readNewData(); }
      });
    });
  }

  // Backfill whatever is already in the file, then watch for appends.
  readNewData();
  const watcher = fs.watch(transcriptPath, { persistent: true }, (eventType) => {
    if (eventType === 'change') readNewData();
  });
  watcher.on('error', (e) => onError?.(e));

  return {
    detach() {
      closed = true;
      watcher.close();
    },
  };
}
