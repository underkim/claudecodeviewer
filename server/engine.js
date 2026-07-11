import { spawn } from 'node:child_process';
import readline from 'node:readline';

const CLAUDE_BIN = process.env.CLAUDE_VIEWER_CLAUDE_BIN || 'claude';

// A `claude` invocation inherits these from our own process environment when
// the viewer server itself happens to be running inside a Claude Code
// session (e.g. during development). Left in place, the spawned child
// attaches to *that* session instead of starting its own — same session_id,
// same transcript. Every session the viewer launches must be independent.
const SESSION_ENV_VARS_TO_CLEAR = [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
];

/**
 * Launches a Claude Code session as a child process speaking the CLI's own
 * `stream-json` protocol (the same one the Claude Agent SDK is built on):
 * newline-delimited JSON on stdout, newline-delimited JSON turns on stdin.
 * This is the real contract Claude Code exposes for programmatic
 * consumption — no hooks, no HTTP hop, one persistent bidirectional pipe.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} [opts.model]
 * @param {string} [opts.permissionMode] one of: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan
 * @param {(message: object) => void} opts.onMessage called with each parsed protocol message
 * @param {(info: {code: number|null, signal: string|null}) => void} opts.onExit
 */
export function launchSession({ cwd, model, permissionMode, onMessage, onExit }) {
  const env = { ...process.env };
  for (const key of SESSION_ENV_VARS_TO_CLEAR) delete env[key];

  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  if (model) args.push('--model', model);
  if (permissionMode) args.push('--permission-mode', permissionMode);

  const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      onMessage({ type: 'engine', subtype: 'unparsed_stdout', text: line });
      return;
    }
    onMessage(parsed);
  });

  let stderrBuf = '';
  child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

  child.on('exit', (code, signal) => {
    if (stderrBuf.trim()) {
      onMessage({ type: 'engine', subtype: 'stderr', text: stderrBuf.trim() });
    }
    onExit({ code, signal });
  });

  function send(text) {
    if (!child.stdin.writable) return false;
    const turn = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
    child.stdin.write(JSON.stringify(turn) + '\n');
    return true;
  }

  function stop() {
    child.kill('SIGTERM');
  }

  return { send, stop, pid: child.pid };
}
