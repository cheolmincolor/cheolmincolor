'use strict';

// The GRAYZONE launch screen (same in every GRAYZONE app): a fixed
// 640×400 window whose 11-step grey wedge is the loading indicator. Each
// cell stands for one real start-up step of this app; nothing is timed.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const ZONE = 3;          // G-Copy's zone in the GRAYZONE family (III)
const STEPS = 11;        // one wedge cell each
const MIN_SHOWN_MS = 1000;

class Launch {
  constructor() { this.win = null; this.state = {}; this.shownAt = 0; this.pageReady = false; }

  // open shows the launch screen and resolves once it is drawn.
  open() {
    this.state = {
      name: app.getName(),
      version: app.getVersion(), // the bundle's version, never typed in here
      icon: 'build/icon.png',    // the image the Dock icon (icon.icns) is made from
      zone: ZONE, done: 0, status: '',
    };
    this.win = new BrowserWindow({
      width: 640, height: 400, useContentSize: true, center: true,
      frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      backgroundColor: '#121212', show: false, title: app.getName(),
      webPreferences: { preload: path.join(__dirname, 'splash-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const w = this.win;
    w.on('closed', () => { if (this.win === w) this.win = null; });
    return new Promise((resolve) => {
      const onReady = (e) => {
        if (!this.win || e.sender !== this.win.webContents) return;
        ipcMain.off('splash-ready', onReady);
        this.pageReady = true;
        this.push();
        this.win.show();
        this.shownAt = Date.now();
        resolve();
      };
      ipcMain.on('splash-ready', onReady);
      w.webContents.once('did-fail-load', () => resolve()); // never hold the app up for its launch screen
      w.loadFile(path.join(__dirname, 'splash.html'));
    });
  }

  push() { if (this.win && !this.win.isDestroyed() && this.pageReady) this.win.webContents.send('splash', this.state); }

  // doing says what is being done right now.
  doing(text) { this.state.status = text; console.log('[launch] ' + this.state.done + '/' + STEPS + ' ' + text); this.push(); }

  // done marks start-up step n (1…11) as finished.
  done(n) { this.state.done = Math.max(this.state.done, n); this.push(); }

  // failed says what went wrong and leaves the screen up. A click or a
  // key then closes the app: the screen has no buttons of its own.
  failed(what) {
    this.state.status = String(what).split('\n')[0].slice(0, 80) + ' Click to close.';
    this.state.failed = true;
    console.log('[launch] failed: ' + what);
    this.push();
    if (!this.win || this.win.isDestroyed()) return;
    const wc = this.win.webContents;
    const onClose = (e) => { if (e.sender === wc && this.state.failed) { ipcMain.off('splash-close', onClose); app.quit(); } };
    ipcMain.on('splash-close', onClose);
  }

  // capture saves a picture of the screen as it is now (the build's self-test).
  async capture(file) {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      await new Promise((r) => setTimeout(r, 150)); // let the last state be drawn
      require('node:fs').writeFileSync(file, (await this.win.webContents.capturePage()).toPNG());
    } catch (e) { console.log('[launch] no picture: ' + e.message); }
  }

  // finish closes the screen, but not before it has been up for a second.
  async finish() {
    if (!this.win) return;
    const left = MIN_SHOWN_MS - (Date.now() - this.shownAt);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    console.log('[launch] shown for ' + (Date.now() - this.shownAt) + ' ms');
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }
}

module.exports = { Launch, STEPS };
