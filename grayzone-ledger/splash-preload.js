'use strict';
// 업데이트 확인 창에는 상태 받기와 「건너뛰고 열기」만 열어 줍니다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gzSplash', {
  onState: (fn) => {
    ipcRenderer.on('gz:splash', (_e, state) => fn(state));
    ipcRenderer.send('gz:splash-ready');
  },
  skip: () => ipcRenderer.send('gz:splash-skip'),
});
