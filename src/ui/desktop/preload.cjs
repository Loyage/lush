const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lushDesktop', {
  chooseProject: () => ipcRenderer.invoke('lush:choose-project'),
  notificationSettings: enabled => ipcRenderer.invoke('lush:notification-settings', enabled),
  notifyNotice: payload => ipcRenderer.invoke('lush:notice', payload),
  platform: process.platform,
});
ipcRenderer.on('lush:notice-open', () => { window.location.hash = '#notices'; });
