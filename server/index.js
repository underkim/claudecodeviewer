import express from 'express';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, endSession, insertEvent, listSessions, listEventsForSession } from './db.js';
import { launchSession } from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CLAUDE_VIEWER_PORT) || 4317;
const PROTOCOL_VERSION = '2';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'viewer')));

/** @type {Set<import('ws').WebSocket>} */
const wsClients = new Set();

/** @type {Map<string, { engine: ReturnType<typeof launchSession>, cwd: string }>} */
const liveSessions = new Map();

function broadcast(envelope) {
  const message = JSON.stringify({ type: 'event', data: envelope });
  for (const client of wsClients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

function ingest(sessionId, raw) {
  const envelope = {
    protocolVersion: PROTOCOL_VERSION,
    eventId: randomUUID(),
    sessionId,
    receivedAt: new Date().toISOString(),
    type: raw.type,
    subtype: raw.subtype ?? null,
    raw,
  };
  insertEvent(envelope);
  broadcast(envelope);
}

app.post('/api/sessions', (req, res) => {
  const { cwd, prompt, model, permissionMode } = req.body ?? {};
  if (typeof cwd !== 'string' || !cwd) return res.status(400).json({ error: 'cwd is required' });
  if (typeof prompt !== 'string' || !prompt) return res.status(400).json({ error: 'prompt is required' });

  let sessionId = null;
  let responded = false;

  const startupTimer = setTimeout(() => {
    if (!responded) {
      responded = true;
      res.status(504).json({ error: 'Timed out waiting for Claude Code to start' });
    }
  }, 20000);

  const engine = launchSession({
    cwd,
    model,
    permissionMode,
    onMessage(msg) {
      if (!sessionId && msg.session_id) {
        sessionId = msg.session_id;
        liveSessions.set(sessionId, { engine, cwd });
        createSession({ sessionId, cwd, model, permissionMode });
        if (!responded) {
          responded = true;
          clearTimeout(startupTimer);
          res.status(201).json({ sessionId });
        }
      }
      if (sessionId) ingest(sessionId, msg);
    },
    onExit({ code, signal }) {
      if (sessionId) {
        endSession(sessionId);
        liveSessions.delete(sessionId);
        ingest(sessionId, { type: 'engine', subtype: 'exit', code, signal });
      } else if (!responded) {
        responded = true;
        clearTimeout(startupTimer);
        res.status(502).json({ error: 'Claude Code exited before starting a session', code, signal });
      }
    },
  });

  engine.send(prompt);
});

app.post('/api/sessions/:sessionId/message', (req, res) => {
  const live = liveSessions.get(req.params.sessionId);
  if (!live) return res.status(404).json({ error: 'session is not live' });

  const { text } = req.body ?? {};
  if (typeof text !== 'string' || !text) return res.status(400).json({ error: 'text is required' });

  live.engine.send(text);
  res.status(202).json({ ok: true });
});

app.post('/api/sessions/:sessionId/stop', (req, res) => {
  const live = liveSessions.get(req.params.sessionId);
  if (!live) return res.status(404).json({ error: 'session is not live' });

  live.engine.stop();
  res.status(202).json({ ok: true });
});

app.get('/api/sessions', (req, res) => {
  const sessions = listSessions().map((s) => ({ ...s, isLive: liveSessions.has(s.sessionId) }));
  res.json(sessions);
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
