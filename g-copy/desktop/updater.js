'use strict';

// Self-update for G-Copy.
//
// The app is not signed by Apple, so Electron's built-in updater (which
// needs a Developer ID signature) cannot be used. Instead:
//
//   1. latest.json and latest.json.sig are fetched from the release feed.
//   2. The signature is checked against the public key built into the app
//      (update-key.pem). Without the matching private key nobody can make
//      G-Copy install anything.
//   3. If the version is newer, the zip for this Mac is downloaded and its
//      SHA-256 compared with the signed manifest, then unpacked and its
//      version checked again.
//   4. When G-Copy quits (or the user clicks "Restart to Update"), a small
//      helper waits for the app to exit, swaps the old app for the new one
//      (keeping the old one until the new one is in place) and, if asked,
//      starts it again.
//
// Files fetched by the app itself are not marked as downloaded from the
// internet, so the updated app opens without the Gatekeeper warning.

const { app, net } = require('electron');
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CHECK_EVERY = 6 * 60 * 60 * 1000;

// "0.10.2" > "0.9.9"
function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

class Updater {
  constructor({ feed, publicKeyPath, onChange, log }) {
    this.feed = String(feed || '').replace(/\/+$/, '');
    this.key = crypto.createPublicKey(fs.readFileSync(publicKeyPath));
    this.onChange = onChange || (() => {});
    this.log = log || (() => {});
    this.dir = path.join(app.getPath('userData'), 'updates');
    this.prefsPath = path.join(app.getPath('userData'), 'updater.json');
    this.prefs = { auto: true };
    try { Object.assign(this.prefs, JSON.parse(fs.readFileSync(this.prefsPath, 'utf8'))); } catch { /* defaults */ }
    this.state = { status: 'idle', current: app.getVersion() };
    this.ready = null;   // { version, notes, appPath } once an update is unpacked
    this.timer = null;
    this.busy = false;   // a check or download is in progress
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  // Where this app lives, and whether it can be replaced there.
  location() {
    const appPath = process.platform === 'darwin'
      ? path.resolve(process.execPath, '..', '..', '..')   // …/G-Copy.app
      : path.dirname(process.execPath);
    if (!app.isPackaged && !process.env.GCOPY_UPDATE_FEED) return { appPath, why: 'G-Copy is running from its source code.' };
    if (appPath.includes('/AppTranslocation/') || appPath.startsWith('/Volumes/')) {
      return { appPath, why: 'Move G-Copy to the Applications folder to enable updates.' };
    }
    try {
      fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
      fs.accessSync(appPath, fs.constants.W_OK);
    } catch {
      return { appPath, why: 'G-Copy cannot replace itself in ' + path.dirname(appPath) + ' (no permission).' };
    }
    return { appPath, why: '' };
  }

  // start keeps checking while the app runs. The first check is made by
  // the launch screen (launchCheck), so this one only repeats it later.
  start() {
    this.timer = setInterval(() => { if (this.prefs.auto) this.check(false); }, CHECK_EVERY);
  }

  // launchCheck is the check every start makes, on the launch screen. It
  // resolves as soon as it is known whether there is a newer version:
  //   { result: 'uptodate' | 'newer' | 'failed' | 'skipped', version?, message? }
  // A newer version then keeps downloading in the background (or, with
  // automatic updates switched off, is only announced).
  launchCheck() {
    return new Promise((resolve) => {
      this.decide = (outcome) => { this.decide = null; resolve(outcome); };
      this.check(false, { announceOnly: !this.prefs.auto }).then(() => { if (this.decide) this.decide({ result: 'failed', message: 'no answer' }); });
    });
  }

  setAuto(on) {
    this.prefs.auto = !!on;
    try { fs.writeFileSync(this.prefsPath, JSON.stringify(this.prefs)); } catch { /* not important */ }
  }

  async fetchText(url) {
    const res = await net.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error('The update server answered ' + res.status + ' for ' + path.basename(new URL(url).pathname));
    return res.text();
  }

  // check: look for a newer version and, if there is one, download it.
  // manual = the user asked; errors and "up to date" are then reported.
  async check(manual, { announceOnly = false } = {}) {
    if (this.busy || this.ready) return this.state;
    this.busy = true;
    const decided = (outcome) => { if (this.decide) this.decide(outcome); };
    try {
      const where = this.location();
      if (where.why) { this.set({ status: 'unavailable', message: where.why }); decided({ result: 'skipped', message: where.why }); return this.state; }
      this.set({ status: 'checking', message: '' });

      const [text, sig] = await Promise.all([this.fetchText(this.feed + '/latest.json'), this.fetchText(this.feed + '/latest.json.sig')]);
      const ok = crypto.verify(null, Buffer.from(text, 'utf8'), this.key, Buffer.from(sig.trim(), 'base64'));
      if (!ok) throw new Error('The update information is not signed by G-Copy. It was ignored.');
      const man = JSON.parse(text);
      if (!newer(man.version, app.getVersion())) { this.set({ status: 'uptodate', latest: man.version }); decided({ result: 'uptodate', version: man.version }); return this.state; }
      decided({ result: 'newer', version: man.version });
      if (announceOnly) { // automatic updates are off: say that there is one, download when asked
        this.set({ status: 'available', version: man.version, notes: String(man.notes || '') });
        return this.state;
      }

      const key = process.platform + '-' + process.arch;
      const file = man.files && man.files[key];
      if (!file || typeof file.url !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256 || '')) throw new Error('This update has no version for this Mac (' + key + ').');
      const u = new URL(file.url);
      const loopbackTest = process.env.GCOPY_UPDATE_FEED && u.protocol === 'http:' && u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !loopbackTest) throw new Error('The update download is not secure (https).');

      this.set({ status: 'downloading', version: man.version, notes: String(man.notes || ''), progress: 0 });
      await fsp.rm(this.dir, { recursive: true, force: true });
      await fsp.mkdir(this.dir, { recursive: true });
      const zip = path.join(this.dir, 'update.zip');
      await this.download(file, zip);

      const out = path.join(this.dir, 'unpacked');
      await fsp.mkdir(out);
      if (process.platform === 'darwin') await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
      else await run('unzip', ['-q', zip, '-d', out]);
      await fsp.rm(zip, { force: true });
      const top = (await fsp.readdir(out)).filter((n) => !n.startsWith('.'));
      if (top.length !== 1) throw new Error('The update archive is not laid out as expected.');
      const newApp = path.join(out, top[0]);
      const pkgPath = process.platform === 'darwin'
        ? path.join(newApp, 'Contents', 'Resources', 'app.asar', 'package.json')
        : path.join(newApp, 'resources', 'app.asar', 'package.json');
      const got = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version; // Electron reads inside the archive
      if (got !== man.version) throw new Error('The downloaded app is version ' + got + ', not ' + man.version + '.');

      this.ready = { version: man.version, notes: String(man.notes || ''), appPath: newApp };
      this.set({ status: 'ready', version: man.version, notes: this.ready.notes, progress: 1 });
      this.log('update ready: ' + man.version);
    } catch (e) {
      this.log('update check failed: ' + e.message);
      decided({ result: 'failed', message: e.message });
      await fsp.rm(this.dir, { recursive: true, force: true }).catch(() => {});
      this.set({ status: manual ? 'error' : 'idle', message: e.message });
    } finally {
      this.busy = false;
    }
    return this.state;
  }

  async download(file, dest) {
    const res = await net.fetch(file.url, { cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error('The download failed (' + res.status + ').');
    const total = Number(file.size) || Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const fh = await fsp.open(dest, 'w');
    let got = 0, shown = 0;
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        await fh.write(chunk);
        got += chunk.length;
        if (total && got / total - shown >= 0.02) { shown = got / total; this.set({ progress: shown }); }
      }
    } finally {
      await fh.close();
    }
    if (file.size && got !== Number(file.size)) throw new Error('The download is incomplete.');
    if (hash.digest('hex') !== file.sha256) throw new Error('The download does not match its checksum. It was discarded.');
  }

  // install: start the helper that swaps the app once this process exits.
  // Called while quitting; relaunch = open the new version afterwards.
  install(relaunch) {
    if (!this.ready) return false;
    const { appPath, why } = this.location();
    if (why) return false;
    const script = path.join(this.dir, 'swap.sh');
    fs.writeFileSync(script, [
      '#!/bin/sh',
      '# Waits for G-Copy to quit, then puts the new version in place of the old one.',
      'PID="$1"; OLD="$2"; NEW="$3"; RELAUNCH="$4"',
      'while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done',
      'BACKUP="$OLD.previous"',
      'rm -rf "$BACKUP"',
      'mv "$OLD" "$BACKUP" || exit 1',
      'if mv "$NEW" "$OLD"; then',
      '  rm -rf "$BACKUP"',
      '  [ "$(uname)" = Darwin ] && xattr -dr com.apple.quarantine "$OLD" 2>/dev/null',
      'else',
      '  mv "$BACKUP" "$OLD"   # put the old version back',
      'fi',
      'if [ "$RELAUNCH" = 1 ]; then',
      '  if [ "$(uname)" = Darwin ]; then open "$OLD"; else "$OLD/G-Copy" $GCOPY_RELAUNCH_ARGS >/dev/null 2>&1 & fi',
      'fi',
      '',
    ].join('\n'), { mode: 0o755 });
    const child = spawn('/bin/sh', [script, String(process.pid), appPath, this.ready.appPath, relaunch ? '1' : '0'], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    child.unref();
    this.log('update helper started for ' + this.ready.version);
    return true;
  }
}

module.exports = { Updater, newer };
