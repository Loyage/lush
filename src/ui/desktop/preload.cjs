const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preload: only local windows get the directory picker; no generic invoke or Node API.
const mode = process.argv.includes('--lush-desktop-mode=local') ? 'local' : 'remote';
contextBridge.exposeInMainWorld('lushDesktop', {
  ...(mode === 'local' ? { chooseProject: () => ipcRenderer.invoke('lush:choose-project') } : {}),
  notificationSettings: enabled => ipcRenderer.invoke('lush:notification-settings', enabled),
  noticePreferences: value => ipcRenderer.invoke('lush:notice-preferences', value),
  notifyNotice: payload => ipcRenderer.invoke('lush:notice', payload),
  platform: process.platform,
  mode,
});
ipcRenderer.on('lush:notice-open', (_event, target) => {
  if (!target) { window.location.hash = '#notices'; return; }
  if (![target.notice_id, target.task_id].every(value => Number.isSafeInteger(value) && value > 0)
    || typeof target.pathname !== 'string' || !/^(\/|\/p\/[a-f0-9]{16}\/?)$/.test(target.pathname)) return;
  const hash = `#notice-${target.notice_id}`;
  if (window.location.pathname === target.pathname) window.location.hash = hash;
  else window.location.href = `${target.pathname}${hash}`;
});
