const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viewerAPI', {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSessionEvents: (sessionId) => ipcRenderer.invoke('sessions:events', sessionId),
  createSession: (params) => ipcRenderer.invoke('sessions:create', params),
  sendMessage: (sessionId, text) => ipcRenderer.invoke('sessions:message', { sessionId, text }),
  stopSession: (sessionId) => ipcRenderer.invoke('sessions:stop', { sessionId }),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  onEvent(callback) {
    const listener = (_event, envelope) => callback(envelope);
    ipcRenderer.on('viewer:event', listener);
    return () => ipcRenderer.removeListener('viewer:event', listener);
  },
});
