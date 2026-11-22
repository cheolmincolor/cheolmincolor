'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('splash', {
  onState: (fn) => {
    ipcRenderer.on('splash', (_e, state) => fn(state));
    ipcRenderer.send('splash-ready');
  },
  close: () => ipcRenderer.send('splash-close'), // only acted on after a failed start

});
