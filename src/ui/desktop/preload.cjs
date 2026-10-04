const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preload: gateway pages are remote-like even when served by the local entry Host.
// Only an explicitly local workspace gets directory and native UI-preference capabilities.
const mode = process.argv.includes('--lush-desktop-mode=local') ? 'local'
  : process.argv.includes('--lush-desktop-mode=gateway') ? 'gateway' : 'remote';
contextBridge.exposeInMainWorld('lushDesktop', {
  // Any owned workspace may open the packaged management shell, but receives no SSH or command IPC.
  openConnections: () => ipcRenderer.invoke('lush:open-connections'),
  ...(mode === 'local' ? {
    chooseProject: () => ipcRenderer.invoke('lush:choose-project'),
    readPreferences: () => ipcRenderer.invoke('lush:ui-preferences'),
    writePreference: (name, value) => ipcRenderer.invoke('lush:ui-preferences', { name, value }),
    resetPreferences: () => ipcRenderer.invoke('lush:ui-preferences', { reset: true }),
    onPreferencesChanged: callback => {
      if (typeof callback !== 'function') throw new Error('invalid preference listener');
      const handler = (_event, snapshot) => callback(snapshot);
      ipcRenderer.on('lush:ui-preferences-changed', handler);
      return () => ipcRenderer.removeListener('lush:ui-preferences-changed', handler);
    },
  } : {}),
  notificationSettings: enabled => ipcRenderer.invoke('lush:notification-settings', enabled),
  noticePreferences: value => ipcRenderer.invoke('lush:notice-preferences', value),
  notifyNotice: payload => ipcRenderer.invoke('lush:notice', payload),
  platform: process.platform,
  mode,
});
ipcRenderer.on('lush:notice-open', (_event, target) => {
  if (!target) { window.location.hash = '#notices'; return; }
  const environment = '(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})';
  const safePath = new RegExp(`^(?:/|/p/[a-f0-9]{16}/?|/e/${environment}/?|/e/${environment}/p/[a-f0-9]{16}/?)$`);
  if (![target.notice_id, target.task_id].every(value => Number.isSafeInteger(value) && value > 0)
    || typeof target.pathname !== 'string' || !safePath.test(target.pathname)) return;
  const hash = `#notice-${target.notice_id}`;
  if (window.location.pathname === target.pathname) window.location.hash = hash;
  else window.location.href = `${target.pathname}${hash}`;
});
