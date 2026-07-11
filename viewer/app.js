const ALL_SESSIONS = '__all__';

const BADGE_COLORS = {
  system: '#58a6ff',
  assistant: '#3fb950',
  user: '#bc8cff',
  result: '#d29922',
  rate_limit_event: '#8b949e',
  active_goal: '#8b949e',
  engine: '#f85149',
  // These only ever come from tailing an attached session's transcript
  // file (core/tail.js) — the durable per-session log Claude Code keeps
  // has a different, plainer message shape than the live stream-json
  // protocol a spawned session speaks.
  'queue-operation': '#6e7681',
  attachment: '#6e7681',
  'ai-title': '#6e7681',
  'last-prompt': '#6e7681',
  mode: '#6e7681',
};

// Raw protocol message types that only exist to drive the live "typing"
// effect — they're folded into the assistant card they belong to and never
// get their own row, in history or live.
const SUPPRESSED_TYPES = new Set(['stream_event']);

const state = {
  selectedSession: ALL_SESSIONS,
  sessions: new Map(), // sessionId -> session summary row (+ isLive)
  streaming: new Map(), // sessionId -> { card, textEl, text }
};

const el = {
  sessions: document.getElementById('sessions'),
  timeline: document.getElementById('timeline'),
  newSessionForm: document.getElementById('new-session-form'),
  newSessionError: document.getElementById('new-session-error'),
  composer: document.getElementById('composer'),
  composerText: document.querySelector('#composer [name="text"]'),
  composerSendBtn: document.querySelector('#composer button[type="submit"]'),
  stopBtn: document.getElementById('stop-btn'),
  discoverList: document.getElementById('discover-list'),
  discoverRefreshBtn: document.getElementById('discover-refresh-btn'),
};

function truncate(str, n) {
  str = String(str);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'tool_use') return `[tool_use ${block.name}] ${JSON.stringify(block.input)}`;
      if (block.type === 'tool_result') {
        const c = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        return `[tool_result${block.is_error ? ' ERROR' : ''}] ${c}`;
      }
      return `[${block.type}]`;
    })
    .join(' ');
}

function summarize(envelope) {
  const raw = envelope.raw || {};
  switch (envelope.type) {
    case 'system':
      switch (envelope.subtype) {
        case 'init': return `session started — model ${raw.model}, cwd ${raw.cwd}`;
        case 'status': return `status: ${raw.status}`;
        case 'hook_started': return `hook running: ${raw.hook_name}`;
        case 'hook_response': return `hook done: ${raw.hook_name} (exit ${raw.exit_code})`;
        case 'post_turn_summary': return raw.status_detail || '';
        default: return envelope.subtype || '';
      }
    case 'assistant':
      return truncate(textFromContent(raw.message?.content), 160);
    case 'user':
      return truncate(textFromContent(raw.message?.content), 160);
    case 'result':
      return `${raw.subtype} — "${truncate(raw.result || '', 80)}" (${raw.duration_ms}ms, $${(raw.total_cost_usd || 0).toFixed(4)})`;
    case 'rate_limit_event':
      return `rate limit: ${raw.rate_limit_info?.status || ''}`;
    case 'active_goal':
      return raw.value ? truncate(raw.value, 120) : '(cleared)';
    case 'engine':
      if (envelope.subtype === 'exit') return `process exited (code ${raw.code}, signal ${raw.signal})`;
      if (envelope.subtype === 'stderr') return truncate(raw.text, 160);
      return truncate(raw.text || '', 160);
    case 'queue-operation':
      return raw.operation || '';
    case 'attachment':
      return `attachment: ${raw.attachment?.type || ''}`;
    case 'ai-title':
      return truncate(raw.aiTitle || '', 120);
    case 'last-prompt':
      return truncate(raw.lastPrompt || '', 120);
    case 'mode':
      return truncate(JSON.stringify(raw), 120);
    default:
      return truncate(JSON.stringify(raw), 160);
  }
}

function badgeLabel(envelope) {
  return envelope.subtype ? `${envelope.type}:${envelope.subtype}` : envelope.type;
}

function renderSessionList() {
  const sessions = [...state.sessions.values()].sort((a, b) =>
    (b.lastEventAt || b.createdAt || '').localeCompare(a.lastEventAt || a.createdAt || '')
  );

  el.sessions.innerHTML = '';
  el.sessions.appendChild(buildSessionItem({ sessionId: ALL_SESSIONS, label: 'All sessions (live)' }));
  for (const s of sessions) el.sessions.appendChild(buildSessionItem(s));
}

function buildSessionItem(s) {
  const div = document.createElement('div');
  div.className = 'session-item' + (state.selectedSession === s.sessionId ? ' active' : '');

  const row = document.createElement('div');
  row.className = 'sid-row';
  if (s.isLive) {
    const dot = document.createElement('span');
    dot.className = 'live-dot';
    row.appendChild(dot);
  }
  const sid = document.createElement('span');
  sid.className = 'sid';
  sid.textContent = s.label || s.sessionId.slice(0, 12);
  row.appendChild(sid);
  div.appendChild(row);

  if (!s.label) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const suffix = s.mode === 'attached' ? ' · attached' : '';
    meta.textContent = `${s.eventCount ?? 0} events · ${s.cwd || ''}${suffix}`;
    div.appendChild(meta);
  }

  div.addEventListener('click', () => selectSession(s.sessionId));
  return div;
}

function updateComposerVisibility() {
  const s = state.sessions.get(state.selectedSession);
  const live = !!(s && s.isLive);
  el.composer.hidden = !live;
  if (!live) return;

  // Attached sessions are read-only: we're tailing someone else's
  // transcript file, not holding stdin, so there's nothing to send to.
  const attached = s.mode === 'attached';
  el.composerText.hidden = attached;
  el.composerSendBtn.hidden = attached;
  el.stopBtn.textContent = attached ? 'Detach' : 'Stop';
}

async function selectSession(sessionId) {
  state.selectedSession = sessionId;
  renderSessionList();
  el.timeline.innerHTML = '';
  updateComposerVisibility();

  if (sessionId === ALL_SESSIONS) {
    const empty = document.createElement('div');
    empty.id = 'empty-state';
    empty.textContent = 'Watching all sessions — showing new events as they arrive.';
    el.timeline.appendChild(empty);
    return;
  }

  const events = await window.viewerAPI.getSessionEvents(sessionId);
  for (const e of events) {
    if (SUPPRESSED_TYPES.has(e.type)) continue;
    appendEventCard(e);
  }
  el.timeline.scrollTop = el.timeline.scrollHeight;
}

function appendEventCard(envelope) {
  const emptyState = document.getElementById('empty-state');
  if (emptyState && state.selectedSession !== ALL_SESSIONS) emptyState.remove();

  const card = document.createElement('div');
  card.className = 'event-card' + (envelope.type === 'engine' ? ' engine-card' : '');

  const head = document.createElement('div');
  head.className = 'event-head';

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.style.background = BADGE_COLORS[envelope.type] || '#8b949e';
  badge.textContent = badgeLabel(envelope);
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
  payload.textContent = JSON.stringify(envelope.raw, null, 2);
  card.appendChild(payload);

  el.timeline.appendChild(card);
  el.timeline.scrollTop = el.timeline.scrollHeight;
  return { card, summary };
}

function isViewingSession(sessionId) {
  return state.selectedSession === ALL_SESSIONS || state.selectedSession === sessionId;
}

// Folds token-by-token stream_event deltas into one live-updating card per
// in-flight assistant turn, so the browser shows text arriving the way it
// would in a terminal, instead of one DOM node per token.
function handleStreamEvent(envelope) {
  const sessionId = envelope.sessionId;
  const event = envelope.raw.event || {};

  if (event.type === 'message_start') {
    if (!isViewingSession(sessionId)) return;
    const placeholder = {
      protocolVersion: envelope.protocolVersion,
      eventId: envelope.eventId,
      sessionId,
      receivedAt: envelope.receivedAt,
      type: 'assistant',
      subtype: null,
      raw: { message: { content: [{ type: 'text', text: '' }] } },
    };
    const { card, summary } = appendEventCard(placeholder);
    card.classList.add('streaming-card');
    state.streaming.set(sessionId, { card, summary, text: '' });
  } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    const s = state.streaming.get(sessionId);
    if (!s) return;
    s.text += event.delta.text;
    s.summary.textContent = truncate(s.text, 160);
  } else if (event.type === 'message_stop') {
    const s = state.streaming.get(sessionId);
    if (s) s.card.classList.remove('streaming-card');
  }
}

function finalizeAssistantMessage(envelope) {
  const sessionId = envelope.sessionId;
  const s = state.streaming.get(sessionId);
  if (s && isViewingSession(sessionId)) {
    s.summary.textContent = summarize(envelope);
    s.card.querySelector('.event-payload').textContent = JSON.stringify(envelope.raw, null, 2);
    s.card.classList.remove('streaming-card');
    state.streaming.delete(sessionId);
  } else if (isViewingSession(sessionId)) {
    appendEventCard(envelope);
  }
}

function touchSession(envelope) {
  const existing = state.sessions.get(envelope.sessionId);
  if (existing) {
    existing.eventCount = (existing.eventCount || 0) + 1;
    existing.lastEventAt = envelope.receivedAt;
    if (envelope.type === 'engine' && envelope.subtype === 'exit') existing.isLive = false;
  } else {
    state.sessions.set(envelope.sessionId, {
      sessionId: envelope.sessionId,
      eventCount: 1,
      createdAt: envelope.receivedAt,
      lastEventAt: envelope.receivedAt,
      isLive: true,
    });
  }
  renderSessionList();
  if (state.selectedSession === envelope.sessionId) updateComposerVisibility();
}

function handleLiveEvent(envelope) {
  touchSession(envelope);

  if (envelope.type === 'stream_event') {
    handleStreamEvent(envelope);
    return;
  }
  if (envelope.type === 'assistant') {
    finalizeAssistantMessage(envelope);
    return;
  }
  if (isViewingSession(envelope.sessionId)) appendEventCard(envelope);
}

async function loadInitialSessions() {
  const sessions = await window.viewerAPI.listSessions();
  for (const s of sessions) state.sessions.set(s.sessionId, s);
  renderSessionList();
}

function formatRelative(iso) {
  const totalSeconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s ago`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function loadDiscoverList() {
  const items = await window.viewerAPI.discoverSessions();
  el.discoverList.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'discover-empty';
    empty.textContent = 'No other Claude Code sessions found.';
    el.discoverList.appendChild(empty);
    return;
  }

  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'discover-item';

    const cwd = document.createElement('div');
    cwd.className = 'cwd';
    cwd.textContent = item.cwd;
    div.appendChild(cwd);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${item.sessionId.slice(0, 8)} · ${formatRelative(item.lastModified)}`;
    div.appendChild(meta);

    div.addEventListener('click', () => attachToDiscovered(item));
    el.discoverList.appendChild(div);
  }
}

async function attachToDiscovered(item) {
  const data = await window.viewerAPI.attachSession(item);
  state.sessions.set(data.sessionId, {
    sessionId: data.sessionId,
    cwd: item.cwd,
    eventCount: 0,
    createdAt: new Date().toISOString(),
    isLive: true,
    mode: 'attached',
  });
  await selectSession(data.sessionId);
  loadDiscoverList();
}

el.newSessionForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  el.newSessionError.textContent = '';
  const form = new FormData(el.newSessionForm);
  const cwd = form.get('cwd').trim();
  const prompt = form.get('prompt').trim();
  const model = form.get('model').trim();
  const permissionMode = form.get('permissionMode');

  const body = { cwd, prompt };
  if (model) body.model = model;
  if (permissionMode) body.permissionMode = permissionMode;

  const submitBtn = el.newSessionForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Launching…';
  try {
    const data = await window.viewerAPI.createSession(body);

    state.sessions.set(data.sessionId, {
      sessionId: data.sessionId,
      cwd,
      eventCount: 0,
      createdAt: new Date().toISOString(),
      isLive: true,
      mode: 'spawned',
    });
    el.newSessionForm.querySelector('[name="prompt"]').value = '';
    await selectSession(data.sessionId);
  } catch (err) {
    el.newSessionError.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Launch';
  }
});

document.getElementById('browse-btn').addEventListener('click', async () => {
  const dir = await window.viewerAPI.pickDirectory();
  if (dir) el.newSessionForm.querySelector('[name="cwd"]').value = dir;
});

el.composer.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = el.composer.querySelector('[name="text"]');
  const text = input.value.trim();
  if (!text || state.selectedSession === ALL_SESSIONS) return;
  input.value = '';
  await window.viewerAPI.sendMessage(state.selectedSession, text);
});

el.stopBtn.addEventListener('click', async () => {
  if (state.selectedSession === ALL_SESSIONS) return;
  const s = state.sessions.get(state.selectedSession);
  if (s && s.mode === 'attached') {
    await window.viewerAPI.detachSession(state.selectedSession);
  } else {
    await window.viewerAPI.stopSession(state.selectedSession);
  }
});

el.discoverRefreshBtn.addEventListener('click', loadDiscoverList);

loadInitialSessions();
loadDiscoverList();
renderSessionList();
window.viewerAPI.onEvent(handleLiveEvent);
