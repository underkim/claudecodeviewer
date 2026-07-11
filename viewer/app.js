const ALL_SESSIONS = '__all__';

const BADGE_COLORS = {
  SessionStart: '#58a6ff',
  UserPromptSubmit: '#bc8cff',
  PreToolUse: '#d29922',
  PostToolUse: '#3fb950',
  Notification: '#39c5cf',
  Stop: '#8b949e',
  SubagentStop: '#8b949e',
  PreCompact: '#f85149',
};

const state = {
  selectedSession: ALL_SESSIONS,
  sessions: new Map(), // sessionId -> {sessionId, eventCount, startedAt, lastEventAt, cwd}
};

const el = {
  sessions: document.getElementById('sessions'),
  timeline: document.getElementById('timeline'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
};

function summarize(envelope) {
  const p = envelope.payload || {};
  switch (envelope.hookEvent) {
    case 'PreToolUse':
    case 'PostToolUse': {
      const input = p.tool_input || {};
      const detail = input.command || input.file_path || input.path || input.pattern || '';
      return `${p.tool_name || 'tool'}${detail ? ' — ' + truncate(String(detail), 80) : ''}`;
    }
    case 'UserPromptSubmit':
      return truncate(String(p.prompt || ''), 100);
    case 'Notification':
      return truncate(String(p.message || ''), 100);
    case 'SessionStart':
      return `source: ${p.source || 'unknown'}`;
    case 'PreCompact':
      return `trigger: ${p.trigger || 'unknown'}`;
    default:
      return '';
  }
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour12: false });
}

function renderSessionList() {
  const sessions = [...state.sessions.values()].sort((a, b) => (b.lastEventAt || '').localeCompare(a.lastEventAt || ''));

  el.sessions.innerHTML = '';
  el.sessions.appendChild(buildSessionItem({ sessionId: ALL_SESSIONS, label: 'All sessions (live)' }));

  for (const s of sessions) {
    el.sessions.appendChild(buildSessionItem(s));
  }
}

function buildSessionItem(s) {
  const div = document.createElement('div');
  div.className = 'session-item' + (state.selectedSession === s.sessionId ? ' active' : '');
  div.dataset.sessionId = s.sessionId;

  const sid = document.createElement('div');
  sid.className = 'sid';
  sid.textContent = s.label || s.sessionId.slice(0, 12);
  div.appendChild(sid);

  if (!s.label) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${s.eventCount} events · ${s.cwd || ''}`;
    div.appendChild(meta);
  }

  div.addEventListener('click', () => selectSession(s.sessionId));
  return div;
}

async function selectSession(sessionId) {
  state.selectedSession = sessionId;
  renderSessionList();
  el.timeline.innerHTML = '';

  if (sessionId === ALL_SESSIONS) {
    const empty = document.createElement('div');
    empty.id = 'empty-state';
    empty.textContent = 'Watching all sessions — showing new events as they arrive.';
    el.timeline.appendChild(empty);
    return;
  }

  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
  const events = await res.json();
  for (const e of events) appendEventCard(e);
  el.timeline.scrollTop = el.timeline.scrollHeight;
}

function appendEventCard(envelope) {
  const emptyState = document.getElementById('empty-state');
  if (emptyState && state.selectedSession !== ALL_SESSIONS) emptyState.remove();
  if (emptyState && state.selectedSession === ALL_SESSIONS) {
    // keep the "watching" note but still add cards below it
  }

  const card = document.createElement('div');
  card.className = 'event-card';

  const head = document.createElement('div');
  head.className = 'event-head';

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.style.background = BADGE_COLORS[envelope.hookEvent] || '#8b949e';
  badge.textContent = envelope.hookEvent;
  head.appendChild(badge);

  const summary = document.createElement('span');
  summary.className = 'event-summary';
  summary.textContent = summarize(envelope);
  head.appendChild(summary);

  const time = document.createElement('span');
  time.className = 'event-time';
  time.textContent = formatTime(envelope.receivedAt);
  head.appendChild(time);

  head.addEventListener('click', () => card.classList.toggle('expanded'));
  card.appendChild(head);

  const payload = document.createElement('div');
  payload.className = 'event-payload';
  payload.textContent = JSON.stringify(
    { sessionId: envelope.sessionId, cwd: envelope.cwd, ...envelope.payload },
    null,
    2
  );
  card.appendChild(payload);

  el.timeline.appendChild(card);
  el.timeline.scrollTop = el.timeline.scrollHeight;
}

function touchSession(envelope) {
  const existing = state.sessions.get(envelope.sessionId);
  if (existing) {
    existing.eventCount += 1;
    existing.lastEventAt = envelope.receivedAt;
    existing.cwd = existing.cwd || envelope.cwd;
  } else {
    state.sessions.set(envelope.sessionId, {
      sessionId: envelope.sessionId,
      eventCount: 1,
      startedAt: envelope.receivedAt,
      lastEventAt: envelope.receivedAt,
      cwd: envelope.cwd,
    });
  }
  renderSessionList();
}

function handleLiveEvent(envelope) {
  touchSession(envelope);
  if (state.selectedSession === ALL_SESSIONS || state.selectedSession === envelope.sessionId) {
    appendEventCard(envelope);
  }
}

async function loadInitialSessions() {
  const res = await fetch('/api/sessions');
  const sessions = await res.json();
  for (const s of sessions) state.sessions.set(s.sessionId, s);
  renderSessionList();
}

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('open', () => {
    el.statusDot.className = 'status-dot connected';
    el.statusText.textContent = 'connected';
  });

  ws.addEventListener('close', () => {
    el.statusDot.className = 'status-dot disconnected';
    el.statusText.textContent = 'disconnected — retrying…';
    setTimeout(connectWebSocket, 2000);
  });

  ws.addEventListener('error', () => ws.close());

  ws.addEventListener('message', (msg) => {
    const parsed = JSON.parse(msg.data);
    if (parsed.type === 'event') handleLiveEvent(parsed.data);
  });
}

loadInitialSessions();
renderSessionList();
connectWebSocket();
