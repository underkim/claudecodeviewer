const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

// core/db.js, core/tail.js, core/discover.js are ES modules (root
// package.json sets "type": "module"); this file stays CommonJS so
// Electron's preload/main loading never has to guess which module system
// applies, and pulls them in with a dynamic import instead.
let db;
let tail;
let discover;

/** @type {Map<string, { tail: ReturnType<typeof tail.attachToTranscript>, cwd: string }>} */
const attachedSessions = new Map();
let mainWindow;

function broadcast(envelope) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('viewer:event', envelope);
  }
}

function ingest(sessionId, raw) {
  const envelope = {
    protocolVersion: '2',
    eventId: crypto.randomUUID(),
    sessionId,
    receivedAt: new Date().toISOString(),
    type: raw.type,
    subtype: raw.subtype ?? null,
    raw,
  };
  db.insertEvent(envelope);
  broadcast(envelope);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'Claude Code Viewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'viewer', 'index.html'));
}

app.whenReady().then(async () => {
  db = await import('../core/db.js');
  tail = await import('../core/tail.js');
  discover = await import('../core/discover.js');

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const attached of attachedSessions.values()) attached.tail.detach();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('sessions:list', () => {
  return db.listSessions().map((s) => ({ ...s, isLive: attachedSessions.has(s.sessionId) }));
});

ipcMain.handle('sessions:discover', () => {
  return discover.discoverSessions().filter((s) => !attachedSessions.has(s.sessionId));
});

ipcMain.handle('sessions:attach', (_event, { sessionId, transcriptPath, cwd }) => {
  if (attachedSessions.has(sessionId)) {
    throw new Error('already tracking this session');
  }

  db.createSession({ sessionId, cwd });

  const handle = tail.attachToTranscript(transcriptPath, {
    onMessage(msg) { ingest(sessionId, msg); },
    onError(err) { ingest(sessionId, { type: 'engine', subtype: 'stderr', text: String(err) }); },
  });
  attachedSessions.set(sessionId, { tail: handle, cwd });

  return { sessionId };
});

ipcMain.handle('sessions:detach', (_event, { sessionId }) => {
  const attached = attachedSessions.get(sessionId);
  if (!attached) throw new Error('session is not attached');
  attached.tail.detach();
  attachedSessions.delete(sessionId);
  db.endSession(sessionId);
  return { ok: true };
});

ipcMain.handle('sessions:events', (_event, sessionId) => db.listEventsForSession(sessionId));

function globalSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

ipcMain.handle('settings:read', () => {
  const settingsPath = globalSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return { path: settingsPath, contents: '{}\n', exists: false };
  }
  return { path: settingsPath, contents: fs.readFileSync(settingsPath, 'utf8'), exists: true };
});

ipcMain.handle('settings:write', (_event, contents) => {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Settings must be a JSON object');
  }

  const settingsPath = globalSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, contents, 'utf8');
  return { ok: true, path: settingsPath };
});
