'use strict';
/**
 * 자동 업데이트.
 *
 * 1. 앱을 켤 때(그리고 6시간마다) GitHub 릴리스에서 「g-account-v1.10.0」(1.9.0 까지는 「ledger-v1.2.3」) 꼴의 새 버전이 있는지 봅니다.
 * 2. 있으면 이 컴퓨터용 zip 을 뒤에서 내려받고, 릴리스에 함께 올린 latest.json 의 SHA-256 과 맞는지 확인한 뒤 풉니다.
 * 3. 「지금 다시 시작」을 누르거나 앱을 끌 때, 작은 스크립트가 앱이 끝나기를 기다렸다가 새 앱으로 바꿉니다.
 *
 * Apple 개발자 서명이 없는 앱이라 Electron 기본 업데이트(Squirrel)는 쓸 수 없어 직접 바꿔 넣습니다.
 * 앱이 직접 내려받은 파일에는 「인터넷에서 받은 파일」 표시가 붙지 않아, 바꾼 뒤 Mac 의 확인 창도 다시 뜨지 않습니다.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'cheolmincolor/cheolmincolor';
const TAG_PREFIX = 'g-account-v';            // 1.10.0 부터의 릴리스 태그
const OLD_TAG_PREFIX = 'ledger-v';          // 1.9.0 까지의 태그(이미 올라간 릴리스)
const tagVersion = (tag) => { const t = String(tag); const p = [TAG_PREFIX, OLD_TAG_PREFIX].find((x) => t.startsWith(x)); return p ? t.slice(p.length) : null; };
// 늘 최신 버전의 latest.json 을 담아 두는 릴리스. 같은 저장소에 다른 앱 릴리스가 많아도 바로 찾습니다.
const FEED_TAG = 'ledger-updates';
// Windows 실행 파일 이름: 새 이름과, 이름을 바꾸기 전(1.4.0 까지)의 이름
const WIN_EXES = ['G-Account.exe', 'GRAYZONE Ledger.exe'];
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

/** '1.10.0' > '1.9.2' */
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

const isVersion = (v) => /^\d+\.\d+\.\d+$/.test(v);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;  // sh 작은따옴표
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;     // PowerShell 작은따옴표

class Updater {
  /**
   * @param {object} o
   * @param {string} o.version     지금 버전
   * @param {string} o.platform    process.platform
   * @param {string} o.arch        process.arch
   * @param {boolean} o.packaged   패키징된 앱인지(개발 실행이면 확인만 하고 설치는 안 함)
   * @param {string} o.execPath    process.execPath
   * @param {string} o.workDir     내려받을 폴더
   * @param {number} o.pid         지금 앱의 프로세스 번호
   * @param {(zip: string, dest: string) => Promise<void>} o.extract
   * @param {(cmd: string, args: string[], opts: object) => { unref(): void }} o.spawn
   * @param {typeof fetch} [o.fetch]
   * @param {(state: object) => void} [o.onChange]
   * @param {string} [o.relaunchCmd]  Mac 에서 새 앱을 여는 명령(테스트에서 바꿈)
   * @param {string} [o.feed]  릴리스를 받을 주소(테스트용, 개발 실행에서만). 기본은 GitHub
   * @param {number} [o.timeoutMs]  업데이트 정보 요청의 시간 제한(기본 15초)
   * @param {number} [o.stallMs]  내려받는 중 이만큼 아무것도 안 오면 포기(기본 60초)
   */
  constructor(o) {
    this.o = o;
    this.fetch = o.fetch || fetch;
    const feed = o.feed ? o.feed.replace(/\/$/, '') : '';
    this.api = feed ? feed + '/releases' : `https://api.github.com/repos/${REPO}/releases?per_page=100`;
    this.downloadPrefix = feed ? feed + '/download/' : DOWNLOAD_PREFIX;
    this.latestUrl = this.downloadPrefix + FEED_TAG + '/latest.json';
    this.timeoutMs = o.timeoutMs || 15000;
    this.stallMs = o.stallMs || 60000;
    this.controller = null;
    this.state = { status: 'idle', current: o.version, latest: '', notes: '', progress: 0, error: '' };
    this.prepared = null;
    this.busy = null;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    if (this.o.onChange) this.o.onChange(this.state);
  }

  key() { return `${this.o.platform}-${this.o.arch}`; }

  async getJson(url) {
    const res = await this.fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'G-Account-App' },
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((e) => { throw new Error(e && e.name === 'TimeoutError' ? '응답이 없습니다(시간 초과).' : '인터넷에 연결하지 못했습니다.'); });
    if (!res.ok) throw Object.assign(new Error(`업데이트 정보를 받지 못했습니다 (${res.status})`), { status: res.status });
    return res.json();
  }

  /**
   * 가장 새 버전: { version, manifest, zipUrl(file) }.
   * 1) 고정 주소(ledger-updates/latest.json) 2) 없으면 릴리스 목록에서 g-account-v*·ledger-v* 를 찾습니다(1.1.0 때 방식).
   */
  async findLatest() {
    try {
      const m = await this.getJson(this.latestUrl);
      if (m && isVersion(m.version) && m.files) return { version: m.version, manifest: m, zipUrl: (file) => file.url };
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const releases = await this.getJson(this.api);
    const best = releases
      .filter((r) => !r.draft && !r.prerelease && tagVersion(r.tag_name) !== null)
      .map((r) => ({ r, v: tagVersion(r.tag_name) }))
      .filter((x) => isVersion(x.v))
      .sort((a, b) => (newer(a.v, b.v) ? -1 : newer(b.v, a.v) ? 1 : 0))[0];
    if (!best) return null;
    const asset = (name) => (best.r.assets || []).find((a) => a.name === name);
    const manifestAsset = asset('latest.json');
    if (!manifestAsset) throw new Error('릴리스에 latest.json 이 없습니다.');
    const manifest = newer(best.v, this.o.version) ? await this.getJson(manifestAsset.browser_download_url) : { version: best.v };
    return { version: best.v, manifest, zipUrl: (file) => { const a = asset(file.name); return a && a.browser_download_url; } };
  }

  /** 새 버전이 있는지 봅니다. download=true 면 이어서 내려받습니다. 같은 일이 진행 중이면 그 결과를 기다립니다. */
  check({ download = true } = {}) {
    if (this.busy) return this.busy;
    if (this.state.status === 'ready') return Promise.resolve(this.state);
    this.busy = this.run(download).finally(() => { this.busy = null; });
    return this.busy;
  }

  /** 진행 중인 확인·내려받기를 멈춥니다(다음 확인 때 다시 받습니다). */
  abort(message) {
    if (this.controller) this.controller.abort(new Error(message || '업데이트를 멈췄습니다.'));
  }

  async run(download) {
    this.set({ status: 'checking', error: '' });
    this.controller = new AbortController();
    try {
      const found = await this.findLatest();
      if (!found || !newer(found.version, this.o.version)) {
        this.set({ status: 'none', latest: found ? found.version : this.o.version, checkedAt: Date.now() });
        return this.state;
      }
      const { manifest } = found;
      if (manifest.version !== found.version) throw new Error('릴리스 정보의 버전이 맞지 않습니다.');
      const file = manifest.files && manifest.files[this.key()];
      this.set({ status: 'available', latest: found.version, notes: String(manifest.notes || ''), checkedAt: Date.now() });
      if (!file) { this.set({ status: 'unsupported', error: '이 컴퓨터용 파일이 이번 버전에 없습니다.' }); return this.state; }
      if (!this.o.packaged) { this.set({ status: 'unsupported', error: '개발 실행에서는 업데이트를 설치하지 않습니다.' }); return this.state; }
      const t = this.target(); // 바꿔 넣을 수 없는 곳이면 받지도 않습니다.
      if (t.error) { this.set({ status: 'unsupported', error: t.error }); return this.state; }
      const zipUrl = found.zipUrl(file);
      if (!zipUrl) throw new Error('릴리스에 ' + file.name + ' 이 없습니다.');
      if (download) await this.download(found.version, zipUrl, file);
      return this.state;
    } catch (e) {
      const reason = this.controller && this.controller.signal.aborted ? this.controller.signal.reason : null;
      this.set({ status: 'error', error: (reason && reason.message) || e.message });
      return this.state;
    } finally {
      this.controller = null;
    }
  }

  /** 내려받기 → SHA-256 확인 → 풀기 → 새 앱 위치 확인 */
  async download(version, url, file) {
    if (!url.startsWith(this.downloadPrefix)) throw new Error('알 수 없는 주소의 업데이트 파일입니다.');
    const dir = path.join(this.o.workDir, version);
    fs.rmSync(this.o.workDir, { recursive: true, force: true }); // 예전에 받아 둔 것 정리
    fs.mkdirSync(dir, { recursive: true });
    this.set({ status: 'downloading', progress: 0 });

    const ctl = this.controller || new AbortController();
    const res = await this.fetch(url, { headers: { 'User-Agent': 'G-Account-App' }, signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error(`업데이트 파일을 받지 못했습니다 (${res.status})`);
    const zip = path.join(dir, file.name);
    // 받은 조각을 곧바로(동기로) 씁니다. 쓰기를 기다리느라 받기를 멈추면 Node 의 fetch(undici)가
    // 연결이 끝날 때 「assert(!this.paused)」로 죽는 문제가 있어, 받기를 멈추지 않습니다.
    const fd = fs.openSync(zip, 'w');
    const hash = crypto.createHash('sha256');
    let got = 0;
    let lastPct = -1;
    let stall = null;
    const watch = () => {
      clearTimeout(stall);
      stall = setTimeout(() => ctl.abort(new Error('업데이트 파일이 한동안 오지 않아 멈췄습니다. 다음에 다시 받습니다.')), this.stallMs);
    };
    const aborted = new Promise((_, reject) => ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true }));
    aborted.catch(() => {});
    try {
      watch();
      const it = res.body[Symbol.asyncIterator]();
      for (;;) {
        // 멈춤·취소가 되면 기다리던 조각을 더 기다리지 않습니다(연결이 망가져 끝나지 않는 경우까지).
        const { value: chunk, done } = await Promise.race([it.next(), aborted]);
        if (done) break;
        watch();
        const buf = Buffer.from(chunk);
        hash.update(buf);
        got += buf.length;
        fs.writeSync(fd, buf);
        const pct = file.size ? Math.min(99, Math.floor((got / file.size) * 100)) : 0;
        if (pct !== lastPct) { lastPct = pct; this.set({ progress: pct }); }
      }
    } finally {
      clearTimeout(stall);
      fs.closeSync(fd);
    }
    if (file.size && got !== file.size) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error('업데이트 파일을 끝까지 받지 못했습니다. 다음에 다시 받습니다.');
    }
    if (hash.digest('hex') !== file.sha256) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error('받은 파일이 손상되었습니다(SHA-256 불일치). 다음에 다시 받습니다.');
    }

    const x = path.join(dir, 'x');
    fs.mkdirSync(x);
    await this.o.extract(zip, x);
    fs.rmSync(zip, { force: true });
    const app = this.findApp(x);
    if (!app) throw new Error('받은 파일에서 앱을 찾지 못했습니다.');
    this.prepared = { version, app };
    this.set({ status: 'ready', progress: 100 });
  }

  /** 풀어 놓은 폴더에서 새 앱(Mac: …app 폴더, Windows: exe 가 든 폴더)을 찾습니다. 한두 단계 아래까지 봅니다. */
  findApp(root) {
    const mac = this.o.platform === 'darwin';
    const look = (dir, depth) => {
      if (mac && dir.endsWith('.app') && fs.existsSync(path.join(dir, 'Contents', 'MacOS'))) return dir;
      if (!mac && WIN_EXES.some((x) => fs.existsSync(path.join(dir, x)))) return dir;
      if (depth === 0) return null;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { const f = look(path.join(dir, e.name), depth - 1); if (f) return f; }
      }
      return null;
    };
    return look(root, 2);
  }

  /** 지금 앱이 놓인 곳. 바꿔 넣을 수 없으면 이유와 함께 null. */
  target() {
    const { platform, execPath } = this.o;
    if (platform === 'darwin') {
      const bundle = path.resolve(execPath, '..', '..', '..');
      if (!bundle.endsWith('.app')) return { error: '앱 위치를 알 수 없습니다.' };
      if (bundle.includes('/AppTranslocation/')) return { error: '앱을 「응용 프로그램」 폴더로 옮긴 뒤 다시 열면 업데이트할 수 있습니다.' };
      try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); } catch { return { error: `「${path.dirname(bundle)}」에 쓸 권한이 없어 바꿔 넣을 수 없습니다.` }; }
      return { path: bundle };
    }
    if (platform === 'win32') {
      const dir = path.dirname(execPath);
      try {
        const probe = path.join(dir, '.gz-update-check');
        fs.writeFileSync(probe, '');
        fs.rmSync(probe);
      } catch { return { error: `「${dir}」에 쓸 권한이 없어 바꿔 넣을 수 없습니다. 앱 폴더를 문서 폴더 등으로 옮겨 주세요.` }; }
      return { path: dir };
    }
    return { error: '이 운영체제는 자동 업데이트를 지원하지 않습니다.' };
  }

  /** 바꿔 넣는 스크립트 내용 */
  script(targetPath, relaunch) {
    const { platform, pid } = this.o;
    const src = this.prepared.app;
    if (platform === 'darwin') {
      const open = this.o.relaunchCmd || 'open';
      return [
        '#!/bin/sh',
        '# G-Account 업데이트: 앱이 끝나기를 기다렸다가 새 앱으로 바꿉니다.',
        `while kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.5; done`,
        `APP=${shq(targetPath)}`,
        `NEW=${shq(src)}`,
        'OLD="$APP.old-update"',
        'rm -rf "$OLD"',
        'if mv "$APP" "$OLD" && mv "$NEW" "$APP"; then',
        '  rm -rf "$OLD"',
        'else',
        '  [ -d "$OLD" ] && [ ! -d "$APP" ] && mv "$OLD" "$APP"',
        'fi',
        relaunch ? `${open} "$APP"` : ':',
        '',
      ].join('\n');
    }
    // Windows: 실행 중인 파일은 덮어쓸 수 없어 앱이 끝난 뒤 복사합니다. 한글 경로 때문에 PowerShell(UTF-8 BOM)로 씁니다.
    return '﻿' + [
      '# G-Account 업데이트: 앱이 끝나기를 기다렸다가 새 파일로 바꿉니다.',
      "$ErrorActionPreference = 'Stop'",
      `while (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }`,
      `$src = ${psq(src)}`,
      `$dst = ${psq(targetPath)}`,
      'for ($i = 0; $i -lt 20; $i++) {',
      "  try { Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force; break } catch { Start-Sleep -Milliseconds 500 }",
      '}',
      `$exes = @(${WIN_EXES.map(psq).join(', ')}) | ForEach-Object { Join-Path $dst $_ } | Where-Object { Test-Path $_ }`,
      '# 새 이름의 실행 파일이 들어왔으면 예전 이름의 파일은 지웁니다.',
      'if ($exes.Count -gt 1) { $exes | Select-Object -Skip 1 | Remove-Item -Force -ErrorAction SilentlyContinue }',
      relaunch ? 'Start-Process -FilePath ($exes | Select-Object -First 1)' : '',
      '',
    ].join('\r\n');
  }

  /**
   * 받아 둔 새 버전을 설치합니다. 스크립트를 띄워 놓고 true 를 돌려주면, 부르는 쪽이 앱을 끝내야 합니다.
   * @param {{ relaunch: boolean }} opts
   */
  install({ relaunch }) {
    if (this.state.status !== 'ready' || !this.prepared) throw new Error('설치할 업데이트가 없습니다.');
    const t = this.target();
    if (t.error) { this.set({ status: 'error', error: t.error }); throw new Error(t.error); }
    const mac = this.o.platform === 'darwin';
    const file = path.join(this.o.workDir, mac ? 'install.sh' : 'install.ps1');
    fs.writeFileSync(file, this.script(t.path, relaunch), { mode: 0o700 });
    const [cmd, args] = mac
      ? ['/bin/sh', [file]]
      : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file]];
    this.o.spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    this.set({ status: 'installing' });
    return true;
  }
}

module.exports = { Updater, newer, TAG_PREFIX, OLD_TAG_PREFIX, FEED_TAG, REPO };
