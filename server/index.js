import express from 'express';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { insertEvent, listSessions, listEventsForSession } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CLAUDE_VIEWER_PORT) || 4317;
const PROTOCOL_VERSION = '1';
const VALID_HOOK_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
]);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'viewer')));

/** @type {Set<import('ws').WebSocket>} */
const wsClients = new Set();

function broadcast(envelope) {
  const message = JSON.stringify({ type: 'event', data: envelope });
  for (const client of wsClients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

app.post('/api/events', (req, res) => {
  const body = req.body ?? {};
  const { sessionId, hookEvent, cwd, transcriptPath, payload } = body;

  if (typeof sessionId !== 'string' || !sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  if (typeof hookEvent !== 'string' || !VALID_HOOK_EVENTS.has(hookEvent)) {
    return res.status(400).json({ error: `hookEvent must be one of: ${[...VALID_HOOK_EVENTS].join(', ')}` });
  }

  const envelope = {
    protocolVersion: PROTOCOL_VERSION,
    eventId: randomUUID(),
    sessionId,
    receivedAt: new Date().toISOString(),
    hookEvent,
    cwd: cwd ?? null,
    transcriptPath: transcriptPath ?? null,
    payload: payload ?? {},
  };

  insertEvent(envelope);
  broadcast(envelope);

  res.status(201).json({ eventId: envelope.eventId });
});

app.get('/api/sessions', (req, res) => {
  res.json(listSessions());
});

app.get('/api/sessions/:sessionId/events', (req, res) => {
  res.json(listEventsForSession(req.params.sessionId));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, protocolVersion: PROTOCOL_VERSION });
});

const server = app.listen(PORT, () => {
  console.log(`claude-code-viewer server listening on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

const heartbeat = setInterval(() => {
  const message = JSON.stringify({ type: 'ping' });
  for (const client of wsClients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}, 30000);

server.on('close', () => clearInterval(heartbeat));
