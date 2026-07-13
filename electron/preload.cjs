const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viewerAPI', {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSessionEvents: (transcriptPath) => ipcRenderer.invoke('sessions:events', transcriptPath),
  getEventsForProject: (cwd) => ipcRenderer.invoke('sessions:eventsForCwd', cwd),
  readSettings: () => ipcRenderer.invoke('settings:read'),
  writeSettings: (contents) => ipcRenderer.invoke('settings:write', contents),
  onEvent(callback) {
    const listener = (_event, envelope) => callback(envelope);
    ipcRenderer.on('viewer:event', listener);
    return () => ipcRenderer.removeListener('viewer:event', listener);
  },
});
