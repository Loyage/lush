const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lushDesktop', {
  chooseProject: () => ipcRenderer.invoke('lush:choose-project'),
  platform: process.platform,
});
