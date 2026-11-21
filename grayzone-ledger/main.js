'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { Store } = require('./src/store');
const { Service } = require('./src/service');
const { Updater } = require('./src/updater');

const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const SPLASH_RESULT_MS = 900; // 「최신 버전입니다」 같은 결과를 잠깐 보여 주는 시간

// 앱 데이터 폴더 이름(로그인·시트 연결이 저장된 곳)이라 바꾸지 않습니다. 화면에 보이는 이름은 DISPLAY_NAME.
const APP_NAME = 'GRAYZONE 장부';
const DISPLAY_NAME = 'GRAYZONE 매출 장부';
app.setName(APP_NAME);
if (process.env.GZ_USER_DATA) app.setPath('userData', process.env.GZ_USER_DATA); // 테스트용
if (process.platform === 'win32') app.setAppUserModelId('com.grayzone.ledger');

let win = null;
let splash = null;
let service = null;
let updater = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = win || splash;
    if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
  // 받아 둔 업데이트가 있으면 앱을 끌 때 설치합니다(다시 열지는 않음).
  app.on('before-quit', () => {
    if (updater && updater.state.status === 'ready') {
      try { updater.install({ relaunch: false }); } catch (e) { console.error(e); }
    }
  });
}

function start() {
  nativeTheme.themeSource = 'dark'; // 메뉴·파일 선택 창·스크롤바도 어둡게
  const store = new Store(app.getPath('userData'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  });
  updater = new Updater({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    execPath: process.execPath,
    workDir: path.join(app.getPath('userData'), 'updates'),
    pid: process.pid,
    extract,
    spawn,
    feed: !app.isPackaged ? process.env.GZ_UPDATE_FEED : undefined, // 테스트용 가짜 릴리스 주소(개발 실행에서만)
    onChange: (state) => {
      if (win && !win.isDestroyed()) win.webContents.send('gz:update', state);
      toSplash(state);
    },
  });
  app.setAboutPanelOptions({ applicationName: DISPLAY_NAME, applicationVersion: app.getVersion(), copyright: 'GRAYZONE' });
  service = new Service({
    store,
    updater,
    quit: () => setTimeout(() => app.quit(), 200),
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
  if (process.env.GZ_NO_UPDATE) { openMain(); return; }
  startupUpdate();
  setInterval(() => updater.check(), UPDATE_EVERY_MS);
}

// ---------- 앱을 열 때: 업데이트 확인 창 ----------

/**
 * 먼저 작은 「업데이트 확인」 창을 띄웁니다(GRAYZONE 매출 장부 고지 포함).
 * - 최신이거나 확인할 수 없으면 잠깐 결과를 보여 주고 장부를 엽니다.
 * - 새 버전이 있으면 받아서 설치하고 앱을 다시 시작합니다.
 * - 「업데이트 건너뛰고 열기」를 누르면 바로 장부를 엽니다(받던 업데이트는 뒤에서 계속, 끌 때 적용).
 */
async function startupUpdate() {
  let skipped = false;
  let installing = false;
  splash = new BrowserWindow({
    width: 460,
    height: 440,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    center: true,
    title: DISPLAY_NAME,
    backgroundColor: '#141413',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  splash.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  splash.webContents.on('will-navigate', (e) => e.preventDefault());
  splash.once('ready-to-show', () => splash.show());
  splash.on('closed', () => {
    splash = null;
    if (!win && !skipped && !installing) { skipped = true; openMain(); } // 창을 닫아도 장부는 엽니다
  });
  const ready = new Promise((resolve) => ipcMain.once('gz:splash-ready', resolve));
  ipcMain.on('gz:splash-skip', () => {
    if (skipped) return;
    skipped = true;
    openMain();
  });
  splash.loadFile(path.join(__dirname, 'app', 'splash.html'));
  await ready;
  toSplash(updater.state);

  const s = await updater.check({ download: true });
  if (skipped) return;
  if (s.status === 'ready') {
    toSplash({ ...s, stage: 'install' });
    await delay(SPLASH_RESULT_MS);
    if (skipped) return;
    try {
      updater.install({ relaunch: true });
      installing = true;
      app.quit();
    } catch (e) {
      toSplash({ ...updater.state, stage: 'install-error', error: e.message });
    }
    return;
  }
  await delay(SPLASH_RESULT_MS);
  if (!skipped) { skipped = true; openMain(); }
}

function toSplash(state) {
  if (splash && !splash.isDestroyed()) splash.webContents.send('gz:splash', state);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 장부 창을 열고, 준비되면 업데이트 확인 창을 닫습니다. */
function openMain() {
  if (win) return;
  createWindow(() => { if (splash && !splash.isDestroyed()) splash.destroy(); });
}

/** 업데이트 zip 풀기: Mac 은 ditto(서명·링크 보존), Windows 는 기본 tar(10 이상), 그 밖은 unzip */
function extract(zip, dest) {
  const [cmd, args] = process.platform === 'darwin' ? ['/usr/bin/ditto', ['-x', '-k', zip, dest]]
    : process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest]]
    : ['unzip', ['-q', zip, '-d', dest]];
  return new Promise((resolve, reject) => execFile(cmd, args, (e) => (e ? reject(new Error('업데이트 파일을 풀지 못했습니다: ' + e.message)) : resolve())));
}

function createWindow(onShown) {
  win = new BrowserWindow({
    width: 980,
    height: 880,
    minWidth: 380,
    minHeight: 560,
    title: DISPLAY_NAME,
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
  win.once('ready-to-show', () => { win.show(); if (onShown) onShown(); });
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
      label: DISPLAY_NAME,
      submenu: [
        { role: 'about', label: `${DISPLAY_NAME} 정보` },
        { label: '업데이트 확인…', click: () => send('update') },
        { type: 'separator' },
        { label: '설정…', accelerator: 'Cmd+,', click: () => send('settings') },
        { type: 'separator' },
        { role: 'hide', label: `${DISPLAY_NAME} 가리기` },
        { role: 'hideOthers', label: '기타 가리기' },
        { role: 'unhide', label: '모두 보기' },
        { type: 'separator' },
        { role: 'quit', label: `${DISPLAY_NAME} 종료` },
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
          { label: '업데이트 확인…', click: () => send('update') },
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
