'use strict';
// 화면에는 아래 아래 것만 열어 줍니다. 화면은 Node.js 나 파일에 직접 접근할 수 없습니다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gz', {
  call: (name, args) => ipcRenderer.invoke('gz:call', name, args),
  onMenu: (fn) => ipcRenderer.on('gz:menu', (_e, action) => fn(action)),
  loaded: () => ipcRenderer.send('gz:loaded'), // 첫 화면을 그렸음(런치 화면이 이때 넘어갑니다)
  onUpdate: (fn) => ipcRenderer.on('gz:update', (_e, state) => fn(state)),
});
