#!/usr/bin/env node
// Claude Code hook entry point: reads the hook's JSON payload from stdin and
// forwards it to the viewer server as a protocol event. This script must
// NEVER throw, never print to stdout (Claude Code interprets PreToolUse
// stdout as a permission decision), and never block Claude Code for more
// than a few hundred milliseconds — a viewer that isn't running is a normal,
// supported state.

const PORT = process.env.CLAUDE_VIEWER_PORT || 4317;
const TIMEOUT_MS = 300;

async function main() {
  const raw = await readStdin();
  if (!raw) return;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  const { session_id: sessionId, hook_event_name: hookEvent, cwd, transcript_path: transcriptPath, ...payload } = data;
  if (!sessionId || !hookEvent) return;

  const body = JSON.stringify({ sessionId, hookEvent, cwd, transcriptPath, payload });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await fetch(`http://localhost:${PORT}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch {
    // Viewer server not running or unreachable — silently no-op.
  } finally {
    clearTimeout(timer);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let chunks = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { chunks += chunk; });
    process.stdin.on('end', () => resolve(chunks));
    process.stdin.on('error', () => resolve(''));
    // If stdin isn't piped at all, don't hang.
    if (process.stdin.isTTY) resolve('');
  });
}

main().finally(() => process.exit(0));
