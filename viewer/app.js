const DASHBOARD = '__dashboard__';
const SETTINGS = '__settings__';

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
  selectedSession: DASHBOARD,
  sessions: new Map(), // sessionId -> session summary row (+ isLive, activity)
  streaming: new Map(), // sessionId -> { card, textEl, text }
};

const el = {
  sessions: document.getElementById('sessions'),
  dashboard: document.getElementById('dashboard'),
  detailHeader: document.getElementById('detail-header'),
  detailTitle: document.getElementById('detail-title'),
  backToDashboardBtn: document.getElementById('back-to-dashboard'),
  timeline: document.getElementById('timeline'),
  composer: document.getElementById('composer'),
  detachBtn: document.getElementById('detach-btn'),
  discoverList: document.getElementById('discover-list'),
  discoverRefreshBtn: document.getElementById('discover-refresh-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  settingsPanel: document.getElementById('settings-panel'),
  settingsPath: document.getElementById('settings-path'),
  settingsEditor: document.getElementById('settings-editor'),
  settingsReloadBtn: document.getElementById('settings-reload-btn'),
  settingsSaveBtn: document.getElementById('settings-save-btn'),
  settingsStatus: document.getElementById('settings-status'),
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

// Reduces the raw protocol stream down to one human status line per
// session, for the dashboard's at-a-glance view. Returns null for
// message types that aren't a meaningful "what's happening now" signal
// (rate limits, goal state, …) so the previous label just stays put.
function deriveActivity(envelope) {
  const raw = envelope.raw || {};
  switch (envelope.type) {
    case 'assistant': {
      const blocks = raw.message?.content || [];
      const toolUse = blocks.find((b) => b.type === 'tool_use');
      if (toolUse) return { label: `Running ${toolUse.name}`, busy: true };
      const text = textFromContent(blocks);
      return { label: text ? truncate(text, 70) : 'Responding', busy: false };
    }
    case 'user':
      return { label: 'Processing tool result…', busy: true };
    case 'stream_event': {
      const et = raw.event?.type;
      if (et === 'message_start') return { label: 'Thinking…', busy: true };
      if (et === 'content_block_delta') return { label: 'Responding…', busy: true };
      return null;
    }
    case 'system':
      if (envelope.subtype === 'status') {
        return { label: raw.status === 'requesting' ? 'Waiting for response…' : 'Working…', busy: true };
      }
      if (envelope.subtype === 'hook_started') return { label: `Hook: ${raw.hook_name}`, busy: true };
      return null;
    case 'result':
      return { label: 'Idle — turn complete', busy: false };
    case 'queue-operation':
      return { label: raw.operation === 'enqueue' ? 'Queued…' : 'Processing…', busy: true };
    case 'engine':
      return envelope.subtype === 'exit' ? { label: 'Session ended', busy: false } : null;
    default:
      return null;
  }
}

function projectNameFromCwd(cwd) {
  if (!cwd) return null;
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

function renderSessionList() {
  const sessions = [...state.sessions.values()].sort((a, b) =>
    (b.lastEventAt || b.createdAt || '').localeCompare(a.lastEventAt || a.createdAt || '')
  );

  el.sessions.innerHTML = '';
  el.sessions.appendChild(buildSessionItem({ sessionId: DASHBOARD, label: 'Dashboard' }));
  for (const s of sessions) el.sessions.appendChild(buildSessionItem(s));
}

function renderDashboard() {
  const sessions = [...state.sessions.values()].sort((a, b) =>
    (b.lastEventAt || b.createdAt || '').localeCompare(a.lastEventAt || a.createdAt || '')
  );

  el.dashboard.innerHTML = '';

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dashboard-empty';
    empty.textContent = 'No sessions yet — launch one or attach to a running session from the sidebar.';
    el.dashboard.appendChild(empty);
    return;
  }

  for (const s of sessions) el.dashboard.appendChild(buildProjectCard(s));
}

function buildProjectCard(s) {
  const card = document.createElement('div');
  card.className = 'project-card';

  const head = document.createElement('div');
  head.className = 'project-card-head';
  if (s.isLive) {
    const dot = document.createElement('span');
    dot.className = 'live-dot';
    head.appendChild(dot);
  }
  const name = document.createElement('span');
  name.className = 'project-name';
  name.textContent = projectNameFromCwd(s.cwd) || s.sessionId.slice(0, 8);
  head.appendChild(name);
  card.appendChild(head);

  const cwd = document.createElement('div');
  cwd.className = 'project-cwd';
  cwd.title = s.cwd || '';
  cwd.textContent = s.cwd || '';
  card.appendChild(cwd);

  const activity = document.createElement('div');
  const busy = s.isLive && s.activity?.busy;
  activity.className = 'project-activity ' + (!s.isLive ? 'state-ended' : busy ? 'state-busy' : 'state-idle');
  activity.textContent = s.activity?.label || (s.isLive ? 'Active' : 'Ended');
  card.appendChild(activity);

  const footer = document.createElement('div');
  footer.className = 'project-footer';
  footer.textContent = `${formatRelative(s.lastEventAt || s.createdAt)} · ${s.eventCount ?? 0} events`;
  card.appendChild(footer);

  card.addEventListener('click', () => selectSession(s.sessionId));
  return card;
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
    meta.textContent = `${s.eventCount ?? 0} events · ${s.cwd || ''}`;
    div.appendChild(meta);
  }

  div.addEventListener('click', () => selectSession(s.sessionId));
  return div;
}

// Every session this app tracks is attached (read-only), never spawned —
// it never gives Claude Code any instructions, only watches. Composer
// visibility is just "is this session still live to watch".
function updateComposerVisibility() {
  const s = state.sessions.get(state.selectedSession);
  el.composer.hidden = !(s && s.isLive);
}

async function selectSession(sessionId) {
  state.selectedSession = sessionId;
  renderSessionList();

  if (sessionId === DASHBOARD) {
    el.dashboard.hidden = false;
    el.settingsPanel.hidden = true;
    el.detailHeader.hidden = true;
    el.timeline.hidden = true;
    el.composer.hidden = true;
    renderDashboard();
    return;
  }

  if (sessionId === SETTINGS) {
    el.dashboard.hidden = true;
    el.settingsPanel.hidden = false;
    el.detailHeader.hidden = true;
    el.timeline.hidden = true;
    el.composer.hidden = true;
    await loadSettingsPanel();
    return;
  }

  el.dashboard.hidden = true;
  el.settingsPanel.hidden = true;
  el.detailHeader.hidden = false;
  el.timeline.hidden = false;
  el.detailTitle.textContent = projectNameFromCwd(state.sessions.get(sessionId)?.cwd) || sessionId.slice(0, 12);
  el.timeline.innerHTML = '';
  updateComposerVisibility();

  const events = await window.viewerAPI.getSessionEvents(sessionId);
  for (const e of events) {
    if (SUPPRESSED_TYPES.has(e.type)) continue;
    appendEventCard(e);
  }
  el.timeline.scrollTop = el.timeline.scrollHeight;
}

async function loadSettingsPanel() {
  el.settingsStatus.textContent = '';
  el.settingsStatus.className = '';
  const { path: settingsPath, contents } = await window.viewerAPI.readSettings();
  el.settingsPath.textContent = settingsPath;
  el.settingsEditor.value = contents;
}

function appendEventCard(envelope) {
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
  return state.selectedSession === sessionId;
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
  const activity = deriveActivity(envelope);
  const existing = state.sessions.get(envelope.sessionId);
  if (existing) {
    existing.eventCount = (existing.eventCount || 0) + 1;
    existing.lastEventAt = envelope.receivedAt;
    if (envelope.type === 'engine' && envelope.subtype === 'exit') existing.isLive = false;
    if (activity) existing.activity = activity;
    // Normally set explicitly by the create/attach handlers before this
    // ever runs — but their IPC response and this live push aren't
    // strictly ordered, so backfill cwd if this session's first-seen
    // event beat that response here.
    if (!existing.cwd && envelope.raw?.cwd) existing.cwd = envelope.raw.cwd;
  } else {
    state.sessions.set(envelope.sessionId, {
      sessionId: envelope.sessionId,
      cwd: envelope.raw?.cwd,
      eventCount: 1,
      createdAt: envelope.receivedAt,
      lastEventAt: envelope.receivedAt,
      isLive: true,
      activity: activity || { label: 'Watching…', busy: false },
    });
  }
  renderSessionList();
  if (state.selectedSession === DASHBOARD) renderDashboard();
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
    activity: { label: 'Watching…', busy: false },
  });
  await selectSession(data.sessionId);
  loadDiscoverList();
}

el.detachBtn.addEventListener('click', async () => {
  if (state.selectedSession === DASHBOARD || state.selectedSession === SETTINGS) return;
  await window.viewerAPI.detachSession(state.selectedSession);
});

el.discoverRefreshBtn.addEventListener('click', loadDiscoverList);
el.backToDashboardBtn.addEventListener('click', () => selectSession(DASHBOARD));
el.settingsBtn.addEventListener('click', () => selectSession(SETTINGS));

el.settingsReloadBtn.addEventListener('click', loadSettingsPanel);

el.settingsSaveBtn.addEventListener('click', async () => {
  el.settingsStatus.textContent = 'Saving…';
  el.settingsStatus.className = '';
  try {
    await window.viewerAPI.writeSettings(el.settingsEditor.value);
    el.settingsStatus.textContent = 'Saved.';
    el.settingsStatus.className = 'status-ok';
  } catch (err) {
    el.settingsStatus.textContent = err.message;
    el.settingsStatus.className = 'status-error';
  }
});

(async () => {
  await loadInitialSessions();
  await selectSession(DASHBOARD);
})();
loadDiscoverList();
window.viewerAPI.onEvent(handleLiveEvent);
