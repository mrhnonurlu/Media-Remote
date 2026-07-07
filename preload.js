const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConnectionInfo: () => ipcRenderer.invoke('get-connection-info'),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (enabled) => ipcRenderer.invoke('set-autostart', enabled)
});
