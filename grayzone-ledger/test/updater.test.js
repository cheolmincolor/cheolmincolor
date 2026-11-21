'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { Updater, newer } = require('../src/updater');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gz-upd-'));
const DL = 'https://github.com/cheolmincolor/cheolmincolor/releases/download/';

/** 가짜 새 버전 zip: Mac 이면 「GRAYZONE Ledger.app」, Windows 면 「GRAYZONE Ledger」 폴더 안에 exe */
function makeZip(dir, platform, marker) {
  const stage = path.join(dir, 'stage');
  const app = platform === 'darwin' ? path.join(stage, 'GRAYZONE Ledger.app', 'Contents', 'MacOS') : path.join(stage, 'GRAYZONE Ledger');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, platform === 'darwin' ? 'GRAYZONE Ledger' : 'GRAYZONE Ledger.exe'), marker);
  const zip = path.join(dir, 'new.zip');
  execFileSync('zip', ['-qry', zip, '.'], { cwd: stage });
  return fs.readFileSync(zip);
}

/** 가짜 GitHub: 릴리스 목록, latest.json, zip */
function fakeGitHub({ zip, version = '1.2.0', platformKey = 'darwin-arm64', sha, extra = [] }) {
  const name = `GRAYZONE-Ledger-${version}-mac-arm64.zip`;
  const manifest = { version, notes: '- 새 기능', files: { [platformKey]: { name, size: zip.length, sha256: sha || crypto.createHash('sha256').update(zip).digest('hex') } } };
  const rel = (v, o = {}) => ({ tag_name: 'ledger-v' + v, draft: false, prerelease: false, assets: [
    { name: 'latest.json', browser_download_url: `${DL}ledger-v${v}/latest.json` },
    { name, browser_download_url: `${DL}ledger-v${v}/${name}` }], ...o });
  const releases = [rel('1.0.0'), rel(version), rel('9.0.0', { draft: true }), { tag_name: 'gcopy-v5.0.0', assets: [] }, ...extra];
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (url.startsWith('https://api.github.com/repos/cheolmincolor/cheolmincolor/releases')) return json(releases);
    if (url === `${DL}ledger-v${version}/latest.json`) return json(manifest);
    if (url === `${DL}ledger-v${version}/${name}`) {
      return { ok: true, status: 200, body: (async function* () { for (let i = 0; i < zip.length; i += 1000) yield zip.subarray(i, i + 1000); })() };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.calls = calls;
  return f;
}

/** 쓸 수 있는 가짜 「응용 프로그램」 폴더 안의 앱 */
function fakeInstalledApp() {
  const apps = path.join(tmp(), 'Applications');
  const exe = path.join(apps, 'GRAYZONE Ledger.app', 'Contents', 'MacOS', 'GRAYZONE Ledger');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  return exe;
}

function updater(o) {
  const states = [];
  const u = new Updater({
    version: '1.1.0', platform: 'darwin', arch: 'arm64', packaged: true, pid: 999999,
    execPath: fakeInstalledApp(),
    extract: async (zip, dest) => { execFileSync('unzip', ['-q', zip, '-d', dest]); },
    spawn: () => ({ unref() {} }),
    onChange: (s) => states.push(s.status),
    ...o,
  });
  u.states = states;
  return u;
}

test('버전 비교', () => {
  assert.equal(newer('1.10.0', '1.9.9'), true);
  assert.equal(newer('1.1.0', '1.1.0'), false);
  assert.equal(newer('2.0.0', '10.0.0'), false);
});

test('새 버전 확인 → 내려받기 → SHA-256 확인 → 풀기 (초안·다른 앱 릴리스는 무시)', async () => {
  const dir = tmp();
  const zip = makeZip(dir, 'darwin', 'v1.2.0');
  const u = updater({ workDir: path.join(dir, 'work'), fetch: fakeGitHub({ zip }) });
  const s = await u.check();
  assert.equal(s.status, 'ready', s.error);
  assert.deepEqual([s.latest, s.notes, s.progress], ['1.2.0', '- 새 기능', 100]);
  assert.ok(u.states.includes('checking') && u.states.includes('downloading'));
  assert.match(u.prepared.app, /GRAYZONE Ledger\.app$/);
  assert.equal(fs.readFileSync(path.join(u.prepared.app, 'Contents/MacOS/GRAYZONE Ledger'), 'utf8'), 'v1.2.0');
  assert.equal(fs.readdirSync(path.dirname(path.dirname(u.prepared.app))).includes('GRAYZONE-Ledger-1.2.0-mac-arm64.zip'), false); // zip 은 지움
  // 준비된 뒤에는 다시 받지 않음
  const n = u.fetch.calls.length;
  await u.check();
  assert.equal(u.fetch.calls.length, n);
});

test('고정 주소(ledger-updates)로 찾음: 같은 저장소에 다른 앱 릴리스가 많아도 됨', async () => {
  const dir = tmp();
  const zip = makeZip(dir, 'darwin', 'v1.3.0');
  const name = 'GRAYZONE-Ledger-1.3.0-mac-arm64.zip';
  const sha = crypto.createHash('sha256').update(zip).digest('hex');
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    if (url === DL + 'ledger-updates/latest.json') {
      return { ok: true, json: async () => ({ version: '1.3.0', notes: '- 고정 주소', files: { 'darwin-arm64': { name, size: zip.length, sha256: sha, url: DL + 'ledger-v1.3.0/' + name } } }) };
    }
    if (url === DL + 'ledger-v1.3.0/' + name) return { ok: true, body: (async function* () { yield zip; })() };
    return { ok: false, status: 404 };
  };
  const u = updater({ workDir: path.join(dir, 'w'), fetch: f });
  const s = await u.check();
  assert.deepEqual([s.status, s.latest, s.notes], ['ready', '1.3.0', '- 고정 주소'], s.error);
  assert.equal(calls.some((c) => c.startsWith('https://api.github.com/')), false); // 릴리스 목록은 보지 않음
});

test('고정 주소의 내려받을 주소가 이 저장소 릴리스가 아니면 받지 않음', async () => {
  const f = async (url) => {
    if (url === DL + 'ledger-updates/latest.json') {
      return { ok: true, json: async () => ({ version: '1.3.0', files: { 'darwin-arm64': { name: 'x.zip', size: 1, sha256: '00', url: 'https://evil.example.com/x.zip' } } }) };
    }
    throw new Error('여기까지 오면 안 됨: ' + url);
  };
  const s = await updater({ workDir: path.join(tmp(), 'w'), fetch: f }).check();
  assert.equal(s.status, 'error');
  assert.match(s.error, /알 수 없는 주소/);
});

test('내려받다가 멈추면(조각이 안 옴) 포기하고, 다음 확인 때 다시 받음', async () => {
  const dir = tmp();
  const zip = makeZip(dir, 'darwin', 'x');
  const base = fakeGitHub({ zip });
  let stuck = true;
  const f = async (url, o) => {
    if (stuck && url.endsWith('.zip')) {
      return { ok: true, body: (async function* () { yield zip.subarray(0, 100); await new Promise(() => {}); })() }; // 끝나지 않음
    }
    return base(url, o);
  };
  const u = updater({ workDir: path.join(dir, 'w'), fetch: f, stallMs: 300 });
  const keepAlive = setTimeout(() => {}, 5000);
  const s = await u.check();
  clearTimeout(keepAlive);
  assert.equal(s.status, 'error');
  assert.match(s.error, /한동안 오지 않아/);
  stuck = false;
  assert.equal((await u.check()).status, 'ready');
});

test('앱 본체가 멈추게 할 수 있음(네트워크 라이브러리 오류 등)', async () => {
  const dir = tmp();
  const zip = makeZip(dir, 'darwin', 'x');
  const base = fakeGitHub({ zip });
  const f = async (url, o) => (url.endsWith('.zip')
    ? { ok: true, body: (async function* () { yield zip.subarray(0, 100); await new Promise(() => {}); })() }
    : base(url, o));
  const u = updater({ workDir: path.join(dir, 'w'), fetch: f });
  const keepAlive = setTimeout(() => {}, 5000);
  const p = u.check();
  while (u.state.status !== 'downloading') await new Promise((r) => setTimeout(r, 10));
  u.abort('업데이트를 받다가 연결이 끊겼습니다.');
  const s = await p;
  clearTimeout(keepAlive);
  assert.deepEqual([s.status, s.error], ['error', '업데이트를 받다가 연결이 끊겼습니다.']);
});

test('최신이면 아무것도 받지 않음', async () => {
  const dir = tmp();
  const zip = makeZip(dir, 'darwin', 'x');
  const u = updater({ version: '1.2.0', workDir: path.join(dir, 'work'), fetch: fakeGitHub({ zip }) });
  assert.equal((await u.check()).status, 'none');
  assert.deepEqual(u.fetch.calls.map((c) => c.replace(/\?.*/, '')), [DL + 'ledger-updates/latest.json', 'https://api.github.com/repos/cheolmincolor/cheolmincolor/releases']); // 고정 주소가 없으면(404) 목록으로
});

test('손상된 파일(SHA-256 불일치)은 설치하지 않음', async () => {
  const dir = tmp();
  const zip = makeZip(dir, 'darwin', 'x');
  const u = updater({ workDir: path.join(dir, 'work'), fetch: fakeGitHub({ zip, sha: 'ab'.repeat(32) }) });
  const s = await u.check();
  assert.equal(s.status, 'error');
  assert.match(s.error, /손상/);
  assert.equal(u.prepared, null);
  assert.throws(() => u.install({ relaunch: true }), /설치할 업데이트가 없습니다/);
});

test('이 컴퓨터용 파일이 없거나 개발 실행이면 설치하지 않음', async () => {
  const dir = tmp();
  const zip = makeZip(dir, 'darwin', 'x');
  assert.equal((await updater({ arch: 'x64', workDir: path.join(dir, 'a'), fetch: fakeGitHub({ zip }) }).check()).status, 'unsupported');
  const dev = updater({ packaged: false, workDir: path.join(dir, 'b'), fetch: fakeGitHub({ zip }) });
  const s = await dev.check();
  assert.deepEqual([s.status, s.latest], ['unsupported', '1.2.0']);
});

test('네트워크 오류는 상태에만 남기고 앱은 계속', async () => {
  const u = updater({ workDir: path.join(tmp(), 'w'), fetch: async () => { throw new TypeError('fetch failed'); } });
  const s = await u.check();
  assert.equal(s.status, 'error');
});

test('Mac: 앱이 끝나면 새 앱으로 바꾸고 다시 엶 (실제 sh 스크립트 실행)', async () => {
  const dir = tmp();
  const zip = makeZip(dir, 'darwin', 'NEW');
  const apps = path.join(dir, 'Applications');
  const bundle = path.join(apps, 'GRAYZONE Ledger.app');
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'GRAYZONE Ledger'), 'OLD');
  const marker = path.join(dir, "relaunched it's.txt");
  // 지금 앱 대신: 1초 뒤에 끝나는 프로세스
  const running = spawn('sleep', ['1']);
  const u = updater({
    workDir: path.join(dir, 'work'), fetch: fakeGitHub({ zip }), spawn, pid: running.pid,
    execPath: path.join(bundle, 'Contents', 'MacOS', 'GRAYZONE Ledger'),
    relaunchCmd: `printf %s >"${marker}"`,
  });
  assert.equal((await u.check()).status, 'ready');
  assert.equal(u.install({ relaunch: true }), true);
  assert.equal(u.state.status, 'installing');
  // 앱이 아직 도는 동안에는 그대로
  assert.equal(fs.readFileSync(path.join(bundle, 'Contents/MacOS/GRAYZONE Ledger'), 'utf8'), 'OLD');
  for (let i = 0; i < 60 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.readFileSync(path.join(bundle, 'Contents/MacOS/GRAYZONE Ledger'), 'utf8'), 'NEW');
  assert.equal(fs.readFileSync(marker, 'utf8'), bundle); // 새 앱을 엶
  assert.equal(fs.existsSync(bundle + '.old-update'), false);
});

test('Mac: 다운로드 폴더에서 바로 연 앱(App Translocation)·쓰기 권한 없는 곳은 받지도 않고 이유를 알림', async () => {
  const dir = tmp();
  const zip = makeZip(dir, 'darwin', 'x');
  const f1 = fakeGitHub({ zip });
  const u = updater({ workDir: path.join(dir, 'w'), fetch: f1,
    execPath: '/private/var/folders/x/AppTranslocation/ABC/d/GRAYZONE Ledger.app/Contents/MacOS/GRAYZONE Ledger' });
  const s = await u.check();
  assert.deepEqual([s.status, s.latest], ['unsupported', '1.2.0']);
  assert.match(s.error, /응용 프로그램/);
  assert.equal(f1.calls.some((c) => c.endsWith('.zip')), false); // 큰 파일은 받지 않음
  assert.throws(() => u.install({ relaunch: true }), /설치할 업데이트가 없습니다/);
  const v = updater({ workDir: path.join(dir, 'v'), fetch: fakeGitHub({ zip }), execPath: '/nonexistent-dir/GRAYZONE Ledger.app/Contents/MacOS/GRAYZONE Ledger' });
  assert.match((await v.check()).error, /쓸 권한이 없어/);
});

test('응답이 없으면 시간 제한 안에 포기하고 앱은 계속', async () => {
  const hang = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
  const u = updater({ workDir: path.join(tmp(), 'w'), fetch: hang, timeoutMs: 200 });
  const t0 = Date.now();
  const keepAlive = setTimeout(() => {}, 5000); // 실제 앱은 늘 살아 있지만, 테스트 프로세스는 기다리는 동안 깨워 둡니다.
  const s = await u.check();
  clearTimeout(keepAlive);
  assert.equal(s.status, 'error');
  assert.match(s.error, /시간 초과/);
  assert.ok(Date.now() - t0 < 2000);
});

test('Windows: 끝나기를 기다렸다가 복사하고 다시 여는 PowerShell 스크립트 (한글·따옴표 경로)', async () => {
  const dir = tmp();
  const zip = makeZip(dir, 'win32', 'NEW');
  const install = path.join(dir, "문서 폴더", "O'Brien", 'GRAYZONE Ledger');
  fs.mkdirSync(install, { recursive: true });
  const spawned = [];
  const u = updater({
    platform: 'win32', arch: 'x64', pid: 4321, workDir: path.join(dir, 'work'),
    execPath: path.join(install, 'GRAYZONE Ledger.exe'),
    fetch: fakeGitHub({ zip, platformKey: 'win32-x64' }),
    spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} }; },
  });
  assert.equal((await u.check()).status, 'ready');
  u.install({ relaunch: true });
  const [{ cmd, args, opts }] = spawned;
  assert.equal(cmd, 'powershell.exe');
  assert.deepEqual(args.slice(-2)[0], '-File');
  assert.deepEqual([opts.detached, opts.windowsHide], [true, true]);
  const ps = fs.readFileSync(args[args.length - 1], 'utf8');
  assert.equal(ps.charCodeAt(0), 0xfeff); // UTF-8 BOM: 한글 경로
  assert.match(ps, /Get-Process -Id 4321/);
  assert.ok(ps.includes(`$dst = '${install.replace(/'/g, "''")}'`));
  assert.ok(ps.includes(`$src = '${u.prepared.app.replace(/'/g, "''")}'`));
  assert.match(ps, /Start-Process -FilePath \(Join-Path \$dst 'GRAYZONE Ledger\.exe'\)/);
  // 끌 때 설치(다시 열지 않음)
  const w = updater({ platform: 'win32', arch: 'x64', workDir: path.join(dir, 'w2'), execPath: path.join(install, 'GRAYZONE Ledger.exe'), fetch: fakeGitHub({ zip, platformKey: 'win32-x64' }) });
  await w.check();
  assert.doesNotMatch(w.script(install, false), /Start-Process/);
});

test('릴리스 정보: CHANGELOG 의 이번 버전 내용과 zip 3개의 SHA-256', () => {
  const dir = tmp();
  const v = require('../package.json').version;
  for (const k of ['mac-arm64', 'mac-x64', 'windows-x64']) fs.writeFileSync(path.join(dir, `GRAYZONE-Ledger-${v}-${k}.zip`), k);
  fs.writeFileSync(path.join(dir, 'GRAYZONE-Ledger-0.9.0-mac-x64.zip'), 'old');
  const out = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'scripts', 'release-manifest.js'), dir]));
  assert.equal(out.version, v);
  const log = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  assert.ok(out.notes.length > 0 && log.includes(`## ${v}\n\n${out.notes}\n`), '이번 버전의 바뀐 점이 아님');
  assert.doesNotMatch(out.notes, /^## /m);
  assert.deepEqual(Object.keys(out.files).sort(), ['darwin-arm64', 'darwin-x64', 'win32-x64']);
  assert.equal(out.files['win32-x64'].sha256, crypto.createHash('sha256').update('windows-x64').digest('hex'));
  assert.equal(out.files['win32-x64'].url, undefined);
  const withUrl = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'scripts', 'release-manifest.js'), dir, `${DL}ledger-v${v}/`]));
  assert.equal(withUrl.files['darwin-arm64'].url, `${DL}ledger-v${v}/GRAYZONE-Ledger-${v}-mac-arm64.zip`);
  fs.rmSync(path.join(dir, `GRAYZONE-Ledger-${v}-mac-x64.zip`));
  assert.throws(() => execFileSync('node', [path.join(__dirname, '..', 'scripts', 'release-manifest.js'), dir], { stdio: 'pipe' }));
});
