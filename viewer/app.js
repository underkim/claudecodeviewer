const DASHBOARD = '__dashboard__';
const SETTINGS = '__settings__';
const PROJECT = '__project__';

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
  selectedProjectCwd: null,
  sessions: new Map(), // sessionId -> session summary row (+ isLive, activity)
  streaming: new Map(), // sessionId -> { card, textEl, text }
};

let projectRefreshTimer = null;

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
  projectPanel: document.getElementById('project-panel'),
  projectBackBtn: document.getElementById('project-back-btn'),
  projectTitle: document.getElementById('project-title'),
  projectCwdLabel: document.getElementById('project-cwd-label'),
  projectStats: document.getElementById('project-stats'),
  projectToolBreakdown: document.getElementById('project-tool-breakdown'),
  projectRoadmap: document.getElementById('project-roadmap'),
  projectSessions: document.getElementById('project-sessions'),
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

function toolResultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map((c) => c.text || '').join(' ');
  return '';
}

// Claude Code's own TaskCreate/TaskUpdate tool calls are effectively a
// project roadmap — reconstructing them from the transcript gives real
// progress tracking instead of inventing a separate one. The task's
// numeric id only appears in TaskCreate's *result* text ("Task #7
// created successfully: ..."), not in the tool_use input, so results
// have to be correlated back to their tool_use via tool_use_id.
function applyTaskResult(tasks, toolUse, resultBlock) {
  const text = toolResultText(resultBlock);
  if (toolUse.name === 'TaskCreate') {
    const m = text.match(/Task #(\S+) created successfully: (.+)/);
    if (m) tasks.set(m[1], { id: m[1], subject: m[2], status: 'pending' });
  } else if (toolUse.name === 'TaskUpdate') {
    const taskId = toolUse.input?.taskId != null ? String(toolUse.input.taskId) : null;
    if (!taskId) return;
    const existing = tasks.get(taskId);
    if (existing) {
      if (toolUse.input.status) existing.status = toolUse.input.status;
      if (toolUse.input.subject) existing.subject = toolUse.input.subject;
    } else {
      // The TaskCreate that made this id predates what we're looking at
      // (an older session outside this project's recorded history) —
      // still record the update so the task shows up.
      tasks.set(taskId, {
        id: taskId,
        subject: toolUse.input.subject || `Task #${taskId}`,
        status: toolUse.input.status || 'pending',
      });
    }
  }
}

// Reduces a project's full event history down to tool-usage counts,
// files touched, turn counts, and a task roadmap — the "stats" and
// "roadmap" the dashboard's project view shows.
function computeProjectStats(events) {
  const toolCounts = new Map();
  const filesTouched = new Set();
  const pendingToolUses = new Map(); // tool_use id -> { name, input }
  const tasks = new Map(); // task id -> { id, subject, status }
  let userTurns = 0;
  let assistantTurns = 0;

  for (const e of events) {
    const raw = e.raw || {};
    if (e.type === 'assistant') {
      assistantTurns++;
      const blocks = raw.message?.content || [];
      for (const b of blocks) {
        if (b.type !== 'tool_use') continue;
        toolCounts.set(b.name, (toolCounts.get(b.name) || 0) + 1);
        const filePath = b.input?.file_path || b.input?.path;
        if (filePath) filesTouched.add(filePath);
        pendingToolUses.set(b.id, b);
      }
    } else if (e.type === 'user') {
      userTurns++;
      const blocks = raw.message?.content || [];
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue;
        const toolUse = pendingToolUses.get(b.tool_use_id);
        if (toolUse && (toolUse.name === 'TaskCreate' || toolUse.name === 'TaskUpdate')) {
          applyTaskResult(tasks, toolUse, b);
        }
      }
    }
  }

  return { toolCounts, filesTouched, tasks, userTurns, assistantTurns };
}

function renderSessionList() {
  const sessions = [...state.sessions.values()].sort((a, b) =>
    (b.lastEventAt || b.createdAt || '').localeCompare(a.lastEventAt || a.createdAt || '')
  );

  el.sessions.innerHTML = '';
  el.sessions.appendChild(buildSessionItem({ sessionId: DASHBOARD, label: 'Dashboard' }));
  for (const s of sessions) el.sessions.appendChild(buildSessionItem(s));
}

function groupSessionsByProject() {
  const byCwd = new Map();
  for (const s of state.sessions.values()) {
    const key = s.cwd || '(unknown)';
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(s);
  }
  return byCwd;
}

function renderDashboard() {
  const projects = groupSessionsByProject();
  el.dashboard.innerHTML = '';

  if (projects.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'dashboard-empty';
    empty.textContent = 'No sessions yet — attach to a running session from the sidebar.';
    el.dashboard.appendChild(empty);
    return;
  }

  const lastActive = (sessions) =>
    sessions.reduce((max, s) => {
      const t = s.lastEventAt || s.createdAt || '';
      return t > max ? t : max;
    }, '');

  const entries = [...projects.entries()].sort((a, b) => lastActive(b[1]).localeCompare(lastActive(a[1])));
  for (const [cwd, sessions] of entries) el.dashboard.appendChild(buildProjectSummaryCard(cwd, sessions));
}

function buildProjectSummaryCard(cwd, sessions) {
  const card = document.createElement('div');
  card.className = 'project-card';

  const head = document.createElement('div');
  head.className = 'project-card-head';
  const liveCount = sessions.filter((s) => s.isLive).length;
  if (liveCount > 0) {
    const dot = document.createElement('span');
    dot.className = 'live-dot';
    head.appendChild(dot);
  }
  const name = document.createElement('span');
  name.className = 'project-name';
  name.textContent = projectNameFromCwd(cwd) || cwd;
  head.appendChild(name);
  card.appendChild(head);

  const cwdEl = document.createElement('div');
  cwdEl.className = 'project-cwd';
  cwdEl.title = cwd;
  cwdEl.textContent = cwd;
  card.appendChild(cwdEl);

  const busySession = sessions.find((s) => s.isLive && s.activity?.busy);
  const activityEl = document.createElement('div');
  activityEl.className =
    'project-activity ' + (busySession ? 'state-busy' : liveCount > 0 ? 'state-idle' : 'state-ended');
  activityEl.textContent = busySession
    ? busySession.activity.label
    : liveCount > 0
      ? `${liveCount} session${liveCount > 1 ? 's' : ''} active`
      : 'Ended';
  card.appendChild(activityEl);

  const lastEventAt = sessions.reduce((max, s) => {
    const t = s.lastEventAt || s.createdAt || '';
    return t > max ? t : max;
  }, '');
  const totalEvents = sessions.reduce((sum, s) => sum + (s.eventCount || 0), 0);

  const footer = document.createElement('div');
  footer.className = 'project-footer';
  footer.textContent = `${formatRelative(lastEventAt)} · ${sessions.length} session${sessions.length > 1 ? 's' : ''} · ${totalEvents} events`;
  card.appendChild(footer);

  card.addEventListener('click', () => showProject(cwd));
  return card;
}

async function showProject(cwd) {
  state.selectedSession = PROJECT;
  state.selectedProjectCwd = cwd;
  renderSessionList();

  el.dashboard.hidden = true;
  el.settingsPanel.hidden = true;
  el.detailHeader.hidden = true;
  el.timeline.hidden = true;
  el.composer.hidden = true;
  el.projectPanel.hidden = false;

  await renderProjectPanel(cwd);
}

async function renderProjectPanel(cwd) {
  const sessions = [...state.sessions.values()].filter((s) => (s.cwd || '(unknown)') === cwd);
  el.projectTitle.textContent = projectNameFromCwd(cwd) || cwd;
  el.projectCwdLabel.textContent = cwd;

  const events = await window.viewerAPI.getEventsForProject(cwd);
  const stats = computeProjectStats(events);

  renderStatTiles(sessions, stats);
  renderRoadmap(stats.tasks);
  renderProjectSessionList(sessions);
}

function renderStatTiles(sessions, stats) {
  el.projectStats.innerHTML = '';
  const liveCount = sessions.filter((s) => s.isLive).length;
  const totalToolCalls = [...stats.toolCounts.values()].reduce((a, b) => a + b, 0);

  const tiles = [
    { label: 'Sessions', value: liveCount > 0 ? `${sessions.length} (${liveCount} live)` : `${sessions.length}` },
    { label: 'Tool calls', value: totalToolCalls },
    { label: 'Files touched', value: stats.filesTouched.size },
    { label: 'Turns', value: stats.userTurns + stats.assistantTurns },
  ];
  for (const t of tiles) {
    const tile = document.createElement('div');
    tile.className = 'stat-tile';
    const value = document.createElement('div');
    value.className = 'stat-value';
    value.textContent = t.value;
    const label = document.createElement('div');
    label.className = 'stat-label';
    label.textContent = t.label;
    tile.appendChild(value);
    tile.appendChild(label);
    el.projectStats.appendChild(tile);
  }

  el.projectToolBreakdown.innerHTML = '';
  const sortedTools = [...stats.toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [name, count] of sortedTools) {
    const chip = document.createElement('span');
    chip.className = 'tool-chip';
    chip.textContent = `${name} × ${count}`;
    el.projectToolBreakdown.appendChild(chip);
  }
}

function renderRoadmap(tasksMap) {
  el.projectRoadmap.innerHTML = '';
  const tasks = [...tasksMap.values()];

  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'roadmap-empty';
    empty.textContent = 'No task roadmap detected yet for this project.';
    el.projectRoadmap.appendChild(empty);
    return;
  }

  const completed = tasks.filter((t) => t.status === 'completed').length;
  const pct = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;

  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = `${pct}%`;
  bar.appendChild(fill);
  el.projectRoadmap.appendChild(bar);

  const summary = document.createElement('div');
  summary.className = 'roadmap-summary';
  summary.textContent = `${completed} / ${tasks.length} tasks completed`;
  el.projectRoadmap.appendChild(summary);

  const order = { in_progress: 0, pending: 1, completed: 2 };
  tasks.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || Number(a.id) - Number(b.id));

  const list = document.createElement('div');
  list.className = 'roadmap-list';
  for (const t of tasks) {
    const item = document.createElement('div');
    item.className = `roadmap-item status-${t.status}`;
    const badge = document.createElement('span');
    badge.className = 'roadmap-status';
    badge.textContent = t.status;
    const subject = document.createElement('span');
    subject.className = 'roadmap-subject';
    subject.textContent = t.subject;
    item.appendChild(badge);
    item.appendChild(subject);
    list.appendChild(item);
  }
  el.projectRoadmap.appendChild(list);
}

function renderProjectSessionList(sessions) {
  el.projectSessions.innerHTML = '';
  const sorted = [...sessions].sort((a, b) =>
    (b.lastEventAt || b.createdAt || '').localeCompare(a.lastEventAt || a.createdAt || '')
  );
  for (const s of sorted) {
    const row = document.createElement('div');
    row.className = 'project-session-row';
    if (s.isLive) {
      const dot = document.createElement('span');
      dot.className = 'live-dot';
      row.appendChild(dot);
    }
    const label = document.createElement('span');
    label.className = 'project-session-label';
    label.textContent = s.sessionId.slice(0, 12);
    row.appendChild(label);
    const activity = document.createElement('span');
    activity.className = 'project-session-activity';
    activity.textContent = s.activity?.label || (s.isLive ? 'Active' : 'Ended');
    row.appendChild(activity);
    row.addEventListener('click', () => selectSession(s.sessionId));
    el.projectSessions.appendChild(row);
  }
}

// Live events can arrive rapidly during a tool-heavy turn; debounce
// re-fetching + recomputing a project's full stats so it doesn't refetch
// on every single message.
function scheduleProjectPanelRefresh(cwd) {
  if (projectRefreshTimer) clearTimeout(projectRefreshTimer);
  projectRefreshTimer = setTimeout(() => {
    if (state.selectedSession === PROJECT && state.selectedProjectCwd === cwd) renderProjectPanel(cwd);
  }, 400);
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
    el.projectPanel.hidden = true;
    el.settingsPanel.hidden = true;
    el.detailHeader.hidden = true;
    el.timeline.hidden = true;
    el.composer.hidden = true;
    renderDashboard();
    return;
  }

  if (sessionId === SETTINGS) {
    el.dashboard.hidden = true;
    el.projectPanel.hidden = true;
    el.settingsPanel.hidden = false;
    el.detailHeader.hidden = true;
    el.timeline.hidden = true;
    el.composer.hidden = true;
    await loadSettingsPanel();
    return;
  }

  el.dashboard.hidden = true;
  el.projectPanel.hidden = true;
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

  const sessionCwd = state.sessions.get(envelope.sessionId)?.cwd;
  if (sessionCwd) scheduleProjectPanelRefresh(sessionCwd);
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
  if (state.selectedSession === DASHBOARD || state.selectedSession === SETTINGS || state.selectedSession === PROJECT) return;
  await window.viewerAPI.detachSession(state.selectedSession);
});

el.discoverRefreshBtn.addEventListener('click', loadDiscoverList);
el.backToDashboardBtn.addEventListener('click', () => selectSession(DASHBOARD));
el.projectBackBtn.addEventListener('click', () => selectSession(DASHBOARD));
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
