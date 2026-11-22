'use strict';
// 런치 화면에는 상태 받기와, 오류로 멈췄을 때의 종료 요청만 열어 줍니다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gzSplash', {
  onState: (fn) => {
    ipcRenderer.on('gz:splash', (_e, state) => fn(state));
    ipcRenderer.send('gz:splash-ready');
  },
  quit: () => ipcRenderer.send('gz:splash-quit'), // 오류로 멈춘 화면에서만 받아들입니다
});
