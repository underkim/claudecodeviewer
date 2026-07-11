const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viewerAPI', {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSessionEvents: (sessionId) => ipcRenderer.invoke('sessions:events', sessionId),
  discoverSessions: () => ipcRenderer.invoke('sessions:discover'),
  attachSession: (params) => ipcRenderer.invoke('sessions:attach', params),
  detachSession: (sessionId) => ipcRenderer.invoke('sessions:detach', { sessionId }),
  readSettings: () => ipcRenderer.invoke('settings:read'),
  writeSettings: (contents) => ipcRenderer.invoke('settings:write', contents),
  onEvent(callback) {
    const listener = (_event, envelope) => callback(envelope);
    ipcRenderer.on('viewer:event', listener);
    return () => ipcRenderer.removeListener('viewer:event', listener);
  },
});
