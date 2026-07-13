const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// The core/ modules are ES modules (root package.json sets "type":
// "module"); this file stays CommonJS so Electron's preload/main loading
// never has to guess which module system applies, and pulls them in with
// a dynamic import instead.
let discover;
let transcript;
let watch;

let mainWindow;
let watcher;

// A session counts as live if its transcript was written to recently.
// Liveness can't be read off a process table (the app never owns or even
// knows the claude processes), and a session that hasn't logged anything
// in this long is idle in every way that matters to a viewer.
const LIVE_WINDOW_MS = 5 * 60 * 1000;

function broadcast(envelope) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('viewer:event', envelope);
  }
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
  discover = await import('../core/discover.js');
  transcript = await import('../core/transcript.js');
  watch = await import('../core/watch.js');

  watcher = watch.watchProjects({
    onMessage(sessionId, raw, transcriptPath) {
      broadcast(transcript.wrapEnvelope(sessionId, raw, new Date().toISOString(), transcriptPath));
    },
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (watcher) watcher.close();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('sessions:list', () => {
  const now = Date.now();
  return discover.discoverSessions().map((s) => ({
    sessionId: s.sessionId,
    cwd: s.cwd,
    transcriptPath: s.transcriptPath,
    lastEventAt: s.lastModified,
    isLive: now - new Date(s.lastModified).getTime() < LIVE_WINDOW_MS,
  }));
});

// The renderer sends back a transcriptPath it previously got from
// sessions:list — but it's still renderer-supplied input, so refuse
// anything that resolves outside the projects directory.
function assertInsideProjectsDir(transcriptPath) {
  const resolved = path.resolve(transcriptPath);
  const root = path.resolve(discover.PROJECTS_DIR);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('transcript path is outside the Claude Code projects directory');
  }
  return resolved;
}

ipcMain.handle('sessions:events', (_event, transcriptPath) => {
  return transcript.readTranscriptEvents(assertInsideProjectsDir(transcriptPath));
});

ipcMain.handle('sessions:eventsForCwd', (_event, cwd) => {
  const events = [];
  for (const s of discover.discoverSessions()) {
    if (s.cwd !== cwd) continue;
    events.push(...transcript.readTranscriptEvents(s.transcriptPath));
  }
  events.sort((a, b) => (a.receivedAt || '').localeCompare(b.receivedAt || ''));
  return events;
});

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
