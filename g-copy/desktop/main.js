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
const http = require('node:http');
const { Updater } = require('./updater');
const { Launch } = require('./launch');
const pkg = require('./package.json');

let engine = null;        // child process
let engineOrigin = '';    // e.g. http://127.0.0.1:51234
let engineGone = null;    // resolves when the engine has exited
let win = null;
let busy = false;         // a backup is running
let closingOnPurpose = false;
let shuttingDown = false;
let quitting = false;     // the app is quitting (not just its window closing)
let schedulesOn = 0;      // enabled schedules: then closing the window keeps G-Copy running
let scheduleText = '';    // "Next: …", for the menu bar
let tray = null;
let awake = -1;           // power save blocker id while a backup runs
let toldAboutBackground = false;
let updater = null;
let relaunchAfterUpdate = false; // "Restart to Update" was clicked
let swapStarted = false;
let launching = true;      // the launch screen is still up

function enginePath() {
  if (process.env.GCOPY_ENGINE) return process.env.GCOPY_ENGINE;
  const name = process.platform === 'win32' ? 'gcopy-engine.exe' : 'gcopy-engine';
  return path.join(app.isPackaged ? process.resourcesPath : __dirname, 'engine', name);
}

// startEngine launches the engine and resolves with the address it prints.
function startEngine(onSpawn) {
  return new Promise((resolve, reject) => {
    const extra = (process.env.GCOPY_ENGINE_ARGS || '').split(' ').filter(Boolean);
    const child = spawn(enginePath(), ['-desktop', ...extra], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    engine = child;
    if (onSpawn) child.once('spawn', onSpawn);
    engineGone = new Promise((done) => child.once('exit', done));

    let out = '';
    let settled = false;
    const fail = (msg) => { if (!settled) { settled = true; reject(new Error(msg)); } };
    const timer = setTimeout(() => fail('The backup engine did not respond within 10 seconds.'), 10000);

    child.stdout.on('data', (d) => {
      if (settled) return;
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/);
      if (m) { settled = true; clearTimeout(timer); resolve(m[0]); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.once('error', (e) => {
      clearTimeout(timer);
      if (engine === child && child.pid === undefined) engine = null; // it never ran: nothing to wait for when quitting
      fail('Cannot start the backup engine: ' + e.message);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const wasUp = settled; // it had started: this is a crash, not a failed start
      fail('The backup engine exited right after starting (code ' + code + '). ' + out.trim().slice(-300));
      if (wasUp && !shuttingDown) engineDied(code);
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
  dialog.showErrorBox('G-Copy', 'The backup engine stopped unexpectedly (code ' + code + ').\nPlease open G-Copy again. Files that were already verified are safe on the destination.');
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
    show: false, // shown when the launch screen is done
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
        new Notification({ title: 'G-Copy keeps running in the menu bar', body: busy ? 'The backup continues.' : 'Scheduled backups will run on time.' }).show();
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
    buttons: ['Keep Backing Up', 'Stop and Quit'],
    defaultId: 0,
    cancelId: 0,
    message: 'A backup is in progress',
    detail: 'Quitting now stops the copy. Files already verified stay on the destination, and running the same backup again continues where it left off.',
  };
  return (win ? dialog.showMessageBoxSync(win, box) : dialog.showMessageBoxSync(box)) === 1;
}

function showWindow() {
  if (!win || launching) return;
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
    const status = busy ? 'Backup in progress' : scheduleText || 'No active schedules';
    tray.setToolTip('G-Copy — ' + status);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open G-Copy', click: showWindow },
      { type: 'separator' },
      { label: status, enabled: false },
      { type: 'separator' },
      { label: 'Quit G-Copy', click: () => app.quit() },
    ]));
  } catch { /* no menu bar on this system */ }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const updates = [
    { label: 'Check for Updates…', enabled: !!updater, click: () => checkForUpdates() },
    { label: 'Check for Updates Automatically', type: 'checkbox', checked: !updater || updater.prefs.auto, enabled: !!updater, click: (item) => updater && updater.setAuto(item.checked) },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, ...updates, { type: 'separator' },
        { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
    }] : []),
    { role: 'editMenu' },   // copy and paste in the path field need this on macOS
    { role: 'windowMenu' },
    ...(isMac ? [] : [{ label: 'Help', submenu: updates }]),
  ]));
}

// ── updates ──────────────────────────────────────────────────────────────

function sendUpdate(state) {
  if (win && !win.isDestroyed()) win.webContents.send('update', state);
}

async function checkForUpdates() {
  if (!updater) return;
  const s = await updater.check(true);
  const box = (o) => (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o));
  if (s.status === 'uptodate') box({ type: 'info', message: 'G-Copy is up to date', detail: 'Version ' + app.getVersion() + ' is the latest.' });
  else if (s.status === 'error' || s.status === 'unavailable') box({ type: 'warning', message: 'Could not check for updates', detail: s.message });
  else if (s.status === 'ready') showWindow(); // the window shows the update and its notes
}

function startUpdater() {
  try {
    updater = new Updater({
      feed: process.env.GCOPY_UPDATE_FEED || pkg.updateFeed,
      publicKeyPath: path.join(__dirname, 'update-key.pem'),
      onChange: sendUpdate,
      log: (m) => console.log('[update] ' + m),
    });
  } catch (e) {
    console.log('[update] disabled: ' + e.message);
    return;
  }
  buildMenu();
  updater.start();
}

// Only pages served by our own engine may call into the shell.
function trusted(event) {
  try { return new URL(event.senderFrame.url).origin === engineOrigin; } catch { return false; }
}

ipcMain.handle('pick-folder', async (event, kind, startAt) => {
  if (!trusted(event) || !win) return null;
  const res = await dialog.showOpenDialog(win, {
    title: kind === 'src' ? 'Choose Source' : 'Choose Destination',
    buttonLabel: 'Choose',
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

ipcMain.handle('update', async (event, action) => {
  if (!trusted(event) || !updater) return { status: 'unavailable', message: 'Updates are not available in this build.' };
  if (action === 'check') return updater.check(true);
  if (action === 'install') {
    if (busy) return { ...updater.state, message: 'Wait until the backup has finished.' };
    if (!updater.ready) return updater.state;
    relaunchAfterUpdate = true;
    setTimeout(() => app.quit(), 50);
    return { ...updater.state, status: 'installing' };
  }
  return updater.state;
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

// ── launch ───────────────────────────────────────────────────────────────

// pingEngine resolves when the engine answers an HTTP request (any answer).
function pingEngine(origin) {
  return new Promise((resolve, reject) => {
    const req = http.get(origin + '/', (res) => { res.resume(); resolve(); });
    req.setTimeout(5000, () => req.destroy(new Error('no answer within 5 seconds')));
    req.on('error', (e) => reject(new Error('The backup engine does not answer: ' + e.message)));
  });
}

// launchProblem says in one short line what stopped the start-up and what
// to do. The technical text goes to the log only.
function launchProblem(e) {
  const m = String(e && e.message || e);
  if (/ENOENT/.test(m)) return 'The backup engine is missing. Reinstall G-Copy.';
  if (/EACCES|EPERM/.test(m)) return 'The backup engine is not allowed to run. Reinstall G-Copy.';
  if (/did not respond|does not answer|no answer/.test(m)) return 'The backup engine did not respond. Open G-Copy again.';
  if (/exited right after starting/.test(m)) return 'The backup engine stopped while starting. Open G-Copy again.';
  if (/interface could not be loaded/.test(m)) return 'The G-Copy window could not be loaded. Open G-Copy again.';
  return 'G-Copy could not start. Open it again, or reinstall it.';
}

// launch starts everything, one step per cell of the launch screen's wedge.
async function launch() {
  // Opened at login: G-Copy starts quietly in the menu bar, without windows.
  const quiet = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
  const screen = new Launch();
  const noop = () => {};
  // The build's own check (CI): start for real, save a picture of the launch screen, quit.
  const selfTest = process.env.GCOPY_SELFTEST_SHOT || '';
  const ui = quiet ? { doing: (t) => console.log('[launch] ' + t), done: noop, failed: noop, finish: async () => {} } : screen;
  try {
    if (!quiet) await screen.open();
    ui.doing('Starting G-Copy');
    ui.done(1);                                   // 1 the app itself is up

    ui.doing('Building the menus');
    buildMenu();
    updateTray();
    ui.done(2);                                   // 2 menus and menu bar icon

    ui.doing('Starting the backup engine');
    const started = startEngine(() => { ui.done(3); ui.doing('Waiting for the backup engine'); }); // 3 engine process runs
    const url = await started;
    ui.done(4);                                   // 4 engine printed its address

    ui.doing('Checking the backup engine');
    await pingEngine(new URL(url).origin);
    ui.done(5);                                   // 5 engine answers requests

    ui.doing('Creating the main window');
    createWindow(url);
    const wc = win.webContents;
    const once = (emitter, event) => new Promise((r) => emitter.once(event, r));
    const loadFailed = new Promise((_, reject) => wc.once('did-fail-load', (_e, code, desc, _u, isMain) => {
      if (isMain) reject(new Error('The interface could not be loaded: ' + desc + ' (' + code + ')'));
    }));
    const [navigated, domReady, loaded, drawn] = [once(wc, 'did-navigate'), once(wc, 'dom-ready'), once(wc, 'did-finish-load'), once(win, 'ready-to-show')];
    ui.done(6);                                   // 6 main window exists

    ui.doing('Loading the interface');
    await Promise.race([navigated, loadFailed]);
    ui.done(7);                                   // 7 engine served the page
    await Promise.race([domReady, loadFailed]);
    ui.done(8);                                   // 8 page is built
    ui.doing('Loading scripts and styles');
    await Promise.race([loaded, loadFailed]);
    ui.done(9);                                   // 9 everything on the page loaded
    ui.doing('Drawing the main window');
    await drawn;
    ui.done(10);                                  // 10 first frame is ready

    ui.doing('Starting update checks');
    startUpdater();
    ui.done(11);                                  // 11 updater runs
    ui.doing('Ready');

    if (selfTest) await screen.capture(selfTest);
    await ui.finish();
    launching = false;
    if (!quiet && win) win.show();
    if (selfTest) { console.log('[launch] self-test passed'); app.quit(); }
  } catch (e) {
    console.log('[launch] ' + e.message);
    if (quiet || !screen.win) {
      dialog.showErrorBox('G-Copy could not start', e.message);
      shuttingDown = true;
      app.quit();
      return;
    }
    screen.failed(launchProblem(e)); // stays on screen until a click or a key closes G-Copy
    if (selfTest) { await screen.capture(selfTest); app.exit(1); }
  }
}

// ── app lifecycle ────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit(); // already running: its window is brought forward below
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow); // Dock icon clicked while the window is hidden

  app.whenReady().then(launch);

  // Without schedules, closing the window ends the app; with them it only hides.
  app.on('window-all-closed', () => app.quit());

  // Cmd+Q, the menu bar's Quit, logging out: ask before cutting a backup short.
  app.on('before-quit', (e) => {
    if (shuttingDown || closingOnPurpose) { quitting = true; return; }
    if (busy && !askStopBackup()) { e.preventDefault(); return; }
    quitting = true;
  });

  app.on('will-quit', (e) => {
    if (engine && engine.exitCode === null) {
      e.preventDefault(); // wait for the engine to clean up, then quit for real
      shuttingDown = true;
      stopEngine().finally(() => app.quit());
      return;
    }
    // A downloaded update is put in place as G-Copy quits.
    if (updater && updater.ready && !swapStarted) swapStarted = updater.install(relaunchAfterUpdate);
  });
}
