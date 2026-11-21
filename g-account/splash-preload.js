'use strict';
// 런치 화면에는 상태 받기만 열어 줍니다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gzSplash', {
  onState: (fn) => {
    ipcRenderer.on('gz:splash', (_e, state) => fn(state));
    ipcRenderer.send('gz:splash-ready');
  },
});
