'use strict';

// G-Copy desktop shell.
//
// The backup engine is a separate program (built from the Go code one
// folder up). This shell starts it, shows its interface in an app window,
// and adds what only a desktop app can do: the system folder dialog,
// dropped folders, Dock/taskbar progress and a notification at the end.

const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, powerSaveBlocker, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

let engine = null;        // child process
let engineOrigin = '';    // e.g. http://127.0.0.1:51234
let engineGone = null;    // resolves when the engine has exited
let win = null;
let busy = false;         // a backup is running
let closingOnPurpose = false;
let shuttingDown = false;
let quitting = false;     // the app is quitting (not just its window closing)
let schedulesOn = 0;      // enabled schedules: then closing the window keeps G-Copy running
let scheduleText = '';    // "다음 예약: …", for the menu bar
let tray = null;
let awake = -1;           // power save blocker id while a backup runs
let toldAboutBackground = false;

function enginePath() {
  if (process.env.GCOPY_ENGINE) return process.env.GCOPY_ENGINE;
  const name = process.platform === 'win32' ? 'gcopy-engine.exe' : 'gcopy-engine';
  return path.join(app.isPackaged ? process.resourcesPath : __dirname, 'engine', name);
}

// startEngine launches the engine and resolves with the address it prints.
function startEngine() {
  return new Promise((resolve, reject) => {
    const extra = (process.env.GCOPY_ENGINE_ARGS || '').split(' ').filter(Boolean);
    const child = spawn(enginePath(), ['-desktop', ...extra], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    engine = child;
    engineGone = new Promise((done) => child.once('exit', done));

    let out = '';
    let settled = false;
    const fail = (msg) => { if (!settled) { settled = true; reject(new Error(msg)); } };
    const timer = setTimeout(() => fail('엔진이 10초 안에 응답하지 않았습니다.'), 10000);

    child.stdout.on('data', (d) => {
      if (settled) return;
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/);
      if (m) { settled = true; clearTimeout(timer); resolve(m[0]); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.once('error', (e) => { clearTimeout(timer); fail('엔진을 시작할 수 없습니다: ' + e.message); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail('엔진이 시작하자마자 종료되었습니다 (코드 ' + code + ').\n' + out.trim().slice(-400));
      if (settled && !shuttingDown) engineDied(code);
    });
  });
}

// stopEngine closes the engine's stdin, which it takes as the signal to
// cancel any copy in flight, remove unfinished temporary files and exit.
async function stopEngine() {
  if (!engine || engine.exitCode !== null) return;
  try { engine.stdin.end(); } catch { /* already closed */ }
  const timeout = new Promise((r) => setTimeout(() => r('timeout'), 15000));
  if ((await Promise.race([engineGone, timeout])) === 'timeout') engine.kill();
}

function engineDied(code) {
  if (shuttingDown) return;
  dialog.showErrorBox('G-Copy', '백업 엔진이 예기치 않게 종료되었습니다 (코드 ' + code + ').\n앱을 다시 실행하세요. 검증을 마친 파일은 대상에 그대로 있습니다.');
  shuttingDown = true;
  app.quit();
}

function createWindow(url) {
  engineOrigin = new URL(url).origin;
  win = new BrowserWindow({
    width: 1120, height: 800, minWidth: 420, minHeight: 520,
    title: 'G-Copy',
    backgroundColor: '#151515', // same as the page, so there is no white flash while it loads
    autoHideMenuBar: true,
    // Opened at login: start in the menu bar, ready for the schedules.
    show: !(process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin),
    webPreferences: {
      backgroundThrottling: false, // keeps following scheduled runs while hidden
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  // The window shows the engine's pages and nothing else.
  win.webContents.on('will-navigate', (e, to) => { if (new URL(to).origin !== engineOrigin) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url: to }) => {
    if (/^https?:\/\//.test(to) && new URL(to).origin !== engineOrigin) shell.openExternal(to);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (quitting || closingOnPurpose) return;
    if (schedulesOn > 0) {
      // Schedules only run while G-Copy runs: keep it in the menu bar.
      e.preventDefault();
      win.hide();
      if (!toldAboutBackground && Notification.isSupported()) {
        toldAboutBackground = true;
        new Notification({ title: 'G-Copy는 메뉴 막대에서 계속 실행됩니다', body: busy ? '백업도 계속 진행합니다.' : '예약된 백업을 정해진 시각에 실행합니다.' }).show();
      }
      return;
    }
    if (!busy) return;
    e.preventDefault();
    if (askStopBackup()) { closingOnPurpose = true; win.close(); }
  });
  win.on('closed', () => { win = null; });

  win.loadURL(url);
}

// askStopBackup asks before a running backup is cut short; true = stop it.
function askStopBackup() {
  const box = {
    type: 'warning',
    buttons: ['계속 백업', '중단하고 종료'],
    defaultId: 0,
    cancelId: 0,
    message: '백업이 진행 중입니다',
    detail: '지금 종료하면 복사를 중단합니다. 검증을 마친 파일은 대상에 남고, 다음에 같은 백업을 실행하면 이어서 복사합니다.',
  };
  return (win ? dialog.showMessageBoxSync(win, box) : dialog.showMessageBoxSync(box)) === 1;
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// The menu bar icon: open, what is scheduled next, quit.
function updateTray() {
  try {
    if (!tray) {
      const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
      img.setTemplateImage(true);
      tray = new Tray(img);
      tray.on('click', () => tray.popUpContextMenu());
    }
    const status = busy ? '백업 진행 중' : scheduleText || '켜진 예약 없음';
    tray.setToolTip('G-Copy — ' + status);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'G-Copy 열기', click: showWindow },
      { type: 'separator' },
      { label: status, enabled: false },
      { type: 'separator' },
      { label: 'G-Copy 종료', click: () => app.quit() },
    ]));
  } catch { /* no menu bar on this system */ }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },   // copy and paste in the path field need this on macOS
    { role: 'windowMenu' },
  ]));
}

// Only pages served by our own engine may call into the shell.
function trusted(event) {
  try { return new URL(event.senderFrame.url).origin === engineOrigin; } catch { return false; }
}

ipcMain.handle('pick-folder', async (event, kind, startAt) => {
  if (!trusted(event) || !win) return null;
  const res = await dialog.showOpenDialog(win, {
    title: kind === 'src' ? '원본 선택' : '대상 선택',
    buttonLabel: '선택',
    defaultPath: typeof startAt === 'string' && startAt ? startAt : undefined,
    properties: kind === 'dst' ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

ipcMain.on('progress', (event, fraction, running) => {
  if (!trusted(event) || !win) return;
  const was = busy;
  busy = !!running;
  const f = Number(fraction);
  win.setProgressBar(Number.isFinite(f) ? f : -1); // -1 removes the bar, above 1 means "working"
  // Keep the Mac from sleeping in the middle of a backup (the screen may still turn off).
  if (busy && awake < 0) awake = powerSaveBlocker.start('prevent-app-suspension');
  if (!busy && awake >= 0) { powerSaveBlocker.stop(awake); awake = -1; }
  if (was !== busy) updateTray();
});

ipcMain.on('schedules', (event, count, text) => {
  if (!trusted(event)) return;
  schedulesOn = Math.max(0, Number(count) || 0);
  scheduleText = String(text || '').slice(0, 120);
  updateTray();
});

ipcMain.handle('login-item', (event, value) => {
  if (!trusted(event)) return false;
  if (typeof value === 'boolean') app.setLoginItemSettings({ openAtLogin: value });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.on('notify', (event, title, body) => {
  if (!trusted(event) || !win || win.isFocused()) return;
  if (Notification.isSupported()) {
    const n = new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 300) });
    n.on('click', showWindow);
    n.show();
  }
  if (process.platform === 'win32') win.flashFrame(true);
});

// ── app lifecycle ────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit(); // already running: its window is brought forward below
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow); // Dock icon clicked while the window is hidden

  app.whenReady().then(async () => {
    buildMenu();
    updateTray();
    try {
      createWindow(await startEngine());
    } catch (e) {
      dialog.showErrorBox('G-Copy를 시작할 수 없습니다', e.message);
      shuttingDown = true;
      app.quit();
    }
  });

  // Without schedules, closing the window ends the app; with them it only hides.
  app.on('window-all-closed', () => app.quit());

  // Cmd+Q, the menu bar's 종료, logging out: ask before cutting a backup short.
  app.on('before-quit', (e) => {
    if (shuttingDown || closingOnPurpose) { quitting = true; return; }
    if (busy && !askStopBackup()) { e.preventDefault(); return; }
    quitting = true;
  });

  app.on('will-quit', (e) => {
    if (!engine || engine.exitCode !== null) return;
    e.preventDefault(); // wait for the engine to clean up, then quit for real
    shuttingDown = true;
    stopEngine().finally(() => app.quit());
  });
}
