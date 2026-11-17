'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Store } = require('./src/store');
const { Service } = require('./src/service');

const APP_NAME = 'GRAYZONE 장부';
app.setName(APP_NAME);
if (process.env.GZ_USER_DATA) app.setPath('userData', process.env.GZ_USER_DATA); // 테스트용
if (process.platform === 'win32') app.setAppUserModelId('com.grayzone.ledger');

let win = null;
let service = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}

function start() {
  nativeTheme.themeSource = 'dark'; // 메뉴·파일 선택 창·스크롤바도 어둡게
  const store = new Store(app.getPath('userData'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  });
  service = new Service({
    store,
    openExternal: (url) => shell.openExternal(url),
    pickFile: async () => {
      const r = await dialog.showOpenDialog(win, {
        title: 'OAuth 클라이언트 파일 고르기',
        buttonLabel: '고르기',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePaths.length) return null;
      return fs.readFileSync(r.filePaths[0], 'utf8');
    },
    log: (e) => console.error(e),
  });
  ipcMain.handle('gz:call', (_e, name, args) => service.run(String(name), args));
  buildMenu();
  createWindow();
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 880,
    minWidth: 380,
    minHeight: 560,
    title: APP_NAME,
    backgroundColor: '#0d0d0d',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  // 화면 안의 링크(시트 열기 등)는 기본 브라우저로 엽니다. 앱 창은 다른 페이지로 이동하지 않습니다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
}

function send(action) {
  if (win) win.webContents.send('gz:menu', action);
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `${APP_NAME} 정보` },
        { type: 'separator' },
        { label: '설정…', accelerator: 'Cmd+,', click: () => send('settings') },
        { type: 'separator' },
        { role: 'hide', label: `${APP_NAME} 가리기` },
        { role: 'hideOthers', label: '기타 가리기' },
        { role: 'unhide', label: '모두 보기' },
        { type: 'separator' },
        { role: 'quit', label: `${APP_NAME} 종료` },
      ],
    }] : []),
    {
      label: '파일',
      submenu: [
        { label: '작업 등록', accelerator: 'CmdOrCtrl+N', click: () => send('add') },
        { label: '새로 고침', accelerator: 'CmdOrCtrl+R', click: () => send('refresh') },
        { label: '시트 열기', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('sheet') },
        ...(mac ? [] : [
          { type: 'separator' },
          { label: '설정…', accelerator: 'Ctrl+,', click: () => send('settings') },
          { type: 'separator' },
          { role: 'quit', label: '끝내기' },
        ]),
      ],
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' },
        { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '모두 선택' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '요약', accelerator: 'CmdOrCtrl+1', click: () => send('tab:home') },
        { label: '장부', accelerator: 'CmdOrCtrl+2', click: () => send('tab:ledger') },
        { label: '미수금', accelerator: 'CmdOrCtrl+3', click: () => send('tab:unpaid') },
        { type: 'separator' },
        { role: 'resetZoom', label: '실제 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
      ],
    },
    { role: 'windowMenu', label: '윈도우' },
  ]));
}
