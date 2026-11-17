'use strict';
// 화면에는 아래 두 가지만 열어 줍니다. 화면은 Node.js 나 파일에 직접 접근할 수 없습니다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gz', {
  call: (name, args) => ipcRenderer.invoke('gz:call', name, args),
  onMenu: (fn) => ipcRenderer.on('gz:menu', (_e, action) => fn(action)),
});
