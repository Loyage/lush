const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preload: only local windows get the directory picker; no generic invoke or Node API.
const mode = process.argv.includes('--lush-desktop-mode=local') ? 'local' : 'remote';
contextBridge.exposeInMainWorld('lushDesktop', {
  ...(mode === 'local' ? { chooseProject: () => ipcRenderer.invoke('lush:choose-project') } : {}),
  notificationSettings: enabled => ipcRenderer.invoke('lush:notification-settings', enabled),
  notifyNotice: payload => ipcRenderer.invoke('lush:notice', payload),
  platform: process.platform,
  mode,
});
ipcRenderer.on('lush:notice-open', () => { window.location.hash = '#notices'; });
