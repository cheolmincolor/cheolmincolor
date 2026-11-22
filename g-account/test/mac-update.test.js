'use strict';
// Mac 빌드 서버(GitHub Actions)에서만: 방금 만든 진짜 앱 zip 으로 자동 업데이트를 끝까지 해 봅니다.
//   GZ_MAC_UPDATE_ZIP=dist/G-Account-1.1.0-mac-arm64.zip GZ_UPDATE_TARGET=/tmp/apps node --test test/mac-update.test.js
// 예전 앱 자리에 새 앱이 들어가고, 서명이 그대로 유효한지 확인합니다. 그다음 워크플로가 바뀐 앱을 실제로 띄워 봅니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { Updater } = require('../src/updater');

const ZIP = process.env.GZ_MAC_UPDATE_ZIP;
const TARGET_DIR = process.env.GZ_UPDATE_TARGET;

test('Mac: 진짜 앱으로 업데이트 → 서명 유지', { skip: !(ZIP && TARGET_DIR && process.platform === 'darwin') && 'Mac 빌드 서버 전용' }, async () => {
  const zip = fs.readFileSync(ZIP);
  const name = path.basename(ZIP);
  const bundle = path.join(TARGET_DIR, 'G-Account.app');
  // 「예전 앱」: 같은 앱을 풀어 두고 표시 파일을 하나 넣어 둡니다.
  fs.rmSync(TARGET_DIR, { recursive: true, force: true });
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  execFileSync('/usr/bin/ditto', ['-x', '-k', ZIP, TARGET_DIR]);
  fs.writeFileSync(path.join(bundle, 'Contents', 'OLD_VERSION_MARKER'), 'old');

  const DL = 'https://github.com/cheolmincolor/cheolmincolor/releases/download/g-account-v99.0.0/';
  const manifest = { version: '99.0.0', notes: '', files: { 'darwin-arm64': { name, size: zip.length, sha256: crypto.createHash('sha256').update(zip).digest('hex') } } };
  const fakeFetch = async (url) => {
    if (url.startsWith('https://api.github.com/')) {
      return { ok: true, json: async () => [{ tag_name: 'g-account-v99.0.0', draft: false, prerelease: false,
        assets: [{ name: 'latest.json', browser_download_url: DL + 'latest.json' }, { name, browser_download_url: DL + name }] }] };
    }
    if (url === DL + 'latest.json') return { ok: true, json: async () => manifest };
    if (url === DL + name) return { ok: true, body: (async function* () { yield zip; })() };
    return { ok: false, status: 404 };
  };
  const marker = path.join(TARGET_DIR, 'relaunched.txt');
  const running = spawn('sleep', ['1']);
  const u = new Updater({
    version: '1.0.0', platform: 'darwin', arch: 'arm64', packaged: true, pid: running.pid,
    execPath: path.join(bundle, 'Contents', 'MacOS', 'G-Account'),
    workDir: path.join(TARGET_DIR, 'work'),
    extract: (z, d) => new Promise((r, j) => execFile('/usr/bin/ditto', ['-x', '-k', z, d], (e) => (e ? j(e) : r()))),
    spawn, fetch: fakeFetch, relaunchCmd: `printf %s >"${marker}"`,
  });
  const s = await u.check();
  assert.equal(s.status, 'ready', s.error);
  u.install({ relaunch: true });
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.existsSync(marker), '바꿔 넣기 스크립트가 끝나지 않았습니다');
  assert.equal(fs.existsSync(path.join(bundle, 'Contents', 'OLD_VERSION_MARKER')), false);
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle]); // 서명이 깨졌으면 예외
  // 내려받은 파일에 「인터넷에서 받은 파일」 표시가 없어야 Mac 확인 창이 다시 뜨지 않습니다.
  const xattr = execFileSync('xattr', [path.join(bundle, 'Contents', 'MacOS', 'G-Account')]).toString();
  assert.doesNotMatch(xattr, /com\.apple\.quarantine/);
});
