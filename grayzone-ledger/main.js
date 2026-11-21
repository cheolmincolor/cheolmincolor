'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { Store } = require('./src/store');
const { Service } = require('./src/service');
const { Updater } = require('./src/updater');

const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;

// 앱 데이터 폴더 이름(로그인·시트 연결이 저장된 곳)이라 바꾸지 않습니다. 화면에 보이는 이름은 DISPLAY_NAME.
const APP_NAME = 'GRAYZONE 장부';
const DISPLAY_NAME = 'G-Account';
app.setName(APP_NAME);
if (process.env.GZ_USER_DATA) app.setPath('userData', process.env.GZ_USER_DATA); // 테스트용
if (process.platform === 'win32') app.setAppUserModelId('com.grayzone.ledger');

// 안전망: 업데이트를 받다가 네트워크 라이브러리 안에서 오류가 나도 앱이 죽거나 오류 창이 뜨지 않게 합니다.
process.on('uncaughtException', (e) => {
  console.error(e);
  if (updater && /checking|available|downloading/.test(updater.state.status)) {
    updater.abort('업데이트를 받다가 연결이 끊겼습니다. 다음에 다시 받습니다.');
  }
});

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
      if (launchProgress) launchProgress(state);
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
  launch();
  setInterval(() => updater.check(), UPDATE_EVERY_MS);
}

// ---------- 앱을 열 때: GRAYZONE 런치 화면 ----------

const MIN_LAUNCH_MS = 1000; // 로딩이 아주 빨라도 최소 1초는 보여 줍니다(규격)
const NOTE_MS = 1200;       // 넘어가도 되는 문제(업데이트 확인 실패)를 읽을 수 있게 잠깐 멈추는 시간

/**
 * 런치 화면(640×400, GRAYZONE 공통 규격)을 띄우고 실제 초기화 단계를 차례로 진행합니다.
 * 웨지 11칸은 단계에 연결되어 있습니다:
 *   1칸 설정 읽기 · 3칸 업데이트 확인 · 8칸 새 버전 받기(받는 만큼) · 10칸 장부 창 준비 · 11칸 장부 읽기
 * 새 버전을 받았으면 설치하고 앱을 다시 시작합니다.
 * 앱을 쓸 수 없는 오류는 무엇이 실패했는지 적고 멈춥니다. 업데이트 확인·설치 실패는 한 줄로 알리고 계속합니다.
 */
async function launch() {
  const t0 = Date.now();
  let done = false;
  let state = { version: app.getVersion(), filled: 0, text: '시작하는 중…' };
  global.gzLaunchLog = []; // 보여 준 단계 기록(테스트가 읽습니다)
  const show = (patch) => { state = { ...state, ...patch }; global.gzLaunchLog.push({ filled: state.filled, text: state.text }); toSplash(state); };
  const stop = (what, e) => { done = 'failed'; console.error(e); show({ text: `${what} 실패: ${e && e.message ? e.message : e}` }); };

  splash = new BrowserWindow({
    width: 640,
    height: 400,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    center: true,
    title: DISPLAY_NAME,
    backgroundColor: '#121212',
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
  splash.on('closed', () => { splash = null; if (done !== true) app.quit(); }); // 끝나기 전에 닫으면 앱을 끝냅니다
  const ready = new Promise((resolve) => ipcMain.once('gz:splash-ready', resolve));
  splash.loadFile(path.join(__dirname, 'app', 'splash.html'));
  await ready;
  show({});

  // 1. 설정 읽기
  show({ text: '설정을 읽는 중…' });
  const st = await service.run('status');
  if (st.err) return stop('설정 읽기', new Error(st.err));
  show({ filled: 1 });

  // 2. 업데이트 확인 → 3. 새 버전 받기
  show({ text: '업데이트를 확인하는 중…' });
  launchProgress = (u) => {
    if (u.status === 'available') show({ filled: 3, text: `새 버전 ${u.latest}을 받을 준비를 하는 중…` });
    if (u.status === 'downloading') show({ filled: 3 + Math.floor((u.progress || 0) / 20), text: `새 버전 ${u.latest}을 받는 중… ${u.progress || 0}%` });
  };
  const u = await updater.check({ download: true });
  launchProgress = null;
  if (u.status === 'ready') {
    show({ filled: 8, text: `새 버전 ${u.latest}을 설치하고 다시 시작하는 중…` });
    try {
      updater.install({ relaunch: true });
      done = true;
      setTimeout(() => app.quit(), Math.max(0, MIN_LAUNCH_MS - (Date.now() - t0)));
      return;
    } catch (e) {
      show({ text: '업데이트 설치 실패(계속 진행): ' + e.message });
      await delay(NOTE_MS);
    }
  } else if (u.status === 'error' || u.status === 'unsupported') {
    show({ filled: 8, text: (u.status === 'error' ? '업데이트 확인 실패(계속 진행): ' : '업데이트 건너뜀: ') + (u.error || '') });
    await delay(NOTE_MS);
  } else {
    show({ filled: 8, text: '최신 버전입니다.' });
  }

  // 4. 장부 창 준비 → 5. 장부 읽기 (장부 창이 첫 화면을 그리면 끝)
  show({ text: '장부 창을 준비하는 중…' });
  const loaded = new Promise((resolve) => ipcMain.once('gz:loaded', resolve));
  const pageReady = new Promise((resolve, reject) => {
    createWindow({ hidden: true });
    win.webContents.once('did-finish-load', resolve);
    win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(desc || String(code))));
  });
  try { await pageReady; } catch (e) { return stop('장부 창 준비', e); }
  show({ filled: 10, text: '장부를 읽는 중…' });
  await loaded;
  show({ filled: 11, text: '준비 완료' });

  await delay(Math.max(0, MIN_LAUNCH_MS - (Date.now() - t0)));
  done = true;
  if (win && !win.isDestroyed()) win.show();
  if (splash && !splash.isDestroyed()) splash.destroy();
}

let launchProgress = null;

function toSplash(state) {
  if (splash && !splash.isDestroyed()) splash.webContents.send('gz:splash', state);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function openMain() {
  if (win) return;
  createWindow();
}

/** 업데이트 zip 풀기: Mac 은 ditto(서명·링크 보존), Windows 는 기본 tar(10 이상), 그 밖은 unzip */
function extract(zip, dest) {
  const [cmd, args] = process.platform === 'darwin' ? ['/usr/bin/ditto', ['-x', '-k', zip, dest]]
    : process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest]]
    : ['unzip', ['-q', zip, '-d', dest]];
  return new Promise((resolve, reject) => execFile(cmd, args, (e) => (e ? reject(new Error('업데이트 파일을 풀지 못했습니다: ' + e.message)) : resolve())));
}

function createWindow(opts = {}) {
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
  if (!opts.hidden) win.once('ready-to-show', () => win.show());
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
