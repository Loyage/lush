const { contextBridge, ipcRenderer } = require('electron');

// Only the packaged connection page receives this preload; runtime also validates every sender.
contextBridge.exposeInMainWorld('lushConnections', {
  localSupported: process.platform !== 'win32',
  list: () => ipcRenderer.invoke('lush:connections-list'),
  openLocal: () => ipcRenderer.invoke('lush:open-local'),
  openRemote: url => ipcRenderer.invoke('lush:open-remote', url),
  remove: url => ipcRenderer.invoke('lush:connections-remove', url),
});
