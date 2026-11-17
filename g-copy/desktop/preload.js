'use strict';

// The few things the interface may ask of the desktop shell. The page gets
// no other access to the system.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('gcopyNative', {
  platform: process.platform,

  // Opens the system folder dialog; resolves with a path, or null if cancelled.
  pickFolder: (kind, startAt) => ipcRenderer.invoke('pick-folder', kind, startAt),

  // The real path of a file or folder dropped onto the window.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },

  // fraction 0..1 shows a bar in the Dock/taskbar, above 1 "working", -1 none.
  setProgress: (fraction, running) => ipcRenderer.send('progress', fraction, running),

  // A system notification, shown only when the window is in the background.
  notify: (title, body) => ipcRenderer.send('notify', title, body),

  // How many schedules are on, and what runs next (for the menu bar).
  setScheduleInfo: (count, text) => ipcRenderer.send('schedules', count, text),

  // Start G-Copy at login (so schedules run after a restart).
  getLoginItem: () => ipcRenderer.invoke('login-item'),
  setLoginItem: (on) => ipcRenderer.invoke('login-item', !!on),
});
