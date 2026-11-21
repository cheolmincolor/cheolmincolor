'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('splash', {
  onState: (fn) => {
    ipcRenderer.on('splash', (_e, state) => fn(state));
    ipcRenderer.send('splash-ready');
  },
});
