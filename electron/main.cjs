const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');

// core/db.js and core/engine.js are ES modules (root package.json sets
// "type": "module"); this file stays CommonJS so Electron's preload/main
// loading never has to guess which module system applies, and pulls them
// in with a dynamic import instead.
let db;
let engine;

/** @type {Map<string, { engine: ReturnType<typeof engine.launchSession>, cwd: string }>} */
const liveSessions = new Map();
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
  engine = await import('../core/engine.js');

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const live of liveSessions.values()) live.engine.stop();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('sessions:list', () => {
  return db.listSessions().map((s) => ({ ...s, isLive: liveSessions.has(s.sessionId) }));
});

ipcMain.handle('sessions:events', (_event, sessionId) => db.listEventsForSession(sessionId));

ipcMain.handle('sessions:create', (_event, { cwd, prompt, model, permissionMode }) => {
  return new Promise((resolve, reject) => {
    let sessionId = null;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Timed out waiting for Claude Code to start'));
      }
    }, 20000);

    const eng = engine.launchSession({
      cwd,
      model,
      permissionMode,
      onMessage(msg) {
        if (!sessionId && msg.session_id) {
          sessionId = msg.session_id;
          liveSessions.set(sessionId, { engine: eng, cwd });
          db.createSession({ sessionId, cwd, model, permissionMode });
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ sessionId });
          }
        }
        if (sessionId) ingest(sessionId, msg);
      },
      onExit({ code, signal }) {
        if (sessionId) {
          db.endSession(sessionId);
          liveSessions.delete(sessionId);
          ingest(sessionId, { type: 'engine', subtype: 'exit', code, signal });
        } else if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Claude Code exited before starting a session (code ${code}, signal ${signal})`));
        }
      },
    });

    eng.send(prompt);
  });
});

ipcMain.handle('sessions:message', (_event, { sessionId, text }) => {
  const live = liveSessions.get(sessionId);
  if (!live) throw new Error('session is not live');
  live.engine.send(text);
  return { ok: true };
});

ipcMain.handle('sessions:stop', (_event, { sessionId }) => {
  const live = liveSessions.get(sessionId);
  if (!live) throw new Error('session is not live');
  live.engine.stop();
  return { ok: true };
});

ipcMain.handle('dialog:pickDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
