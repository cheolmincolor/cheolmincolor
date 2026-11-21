'use strict';
// 실제 Electron 앱을 띄워, 앱을 열 때의 업데이트 확인 창 흐름을 가짜 릴리스 서버로 확인합니다.
//   xvfb-run -a node --test test/electron-startup.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { _electron: electron } = require('playwright');

const VERSION = require('../package.json').version;
const needsDisplay = process.platform === 'linux' && !process.env.DISPLAY;

/** 가짜 릴리스 서버. latest: 올라가 있는 버전, delayMs: 응답 지연 */
function feedServer({ latest, delayMs = 0 }) {
  const server = http.createServer((req, res) => {
    server.requests = (server.requests || 0) + 1;
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (body) => setTimeout(() => {
      server.answered = true;
      if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
    }, delayMs).unref(); // 시험이 끝난 뒤 이 타이머 때문에 기다리지 않도록
    const key = `${process.platform}-${process.arch}`;
    if (req.url === '/releases') {
      return send([{ tag_name: 'ledger-v' + latest, draft: false, prerelease: false, assets: [
        { name: 'latest.json', browser_download_url: `${base}/download/ledger-v${latest}/latest.json` },
        { name: 'app.zip', browser_download_url: `${base}/download/ledger-v${latest}/app.zip` }] }]);
    }
    if (req.url === `/download/ledger-v${latest}/latest.json`) {
      return send({ version: latest, notes: '', files: { [key]: { name: 'app.zip', size: 1, sha256: '00' } } });
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function launch(feed) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gz-start-'));
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []), path.join(__dirname, '..')],
    env: { ...process.env, GZ_USER_DATA: userData, GZ_UPDATE_FEED: feed, GZ_NO_UPDATE: '' },
  });
  const splash = await app.firstWindow();
  return { app, splash, done: async () => { await app.close(); fs.rmSync(userData, { recursive: true, force: true }); } };
}

/** 장부 창(설정 화면)이 열리고 업데이트 확인 창이 닫힐 때까지 */
async function waitMain(app) {
  for (let i = 0; i < 100; i++) {
    const ws = app.windows();
    for (const w of ws) {
      if (await w.locator('.steps').count().catch(() => 0)) return { main: w };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('장부 창이 열리지 않았습니다');
}

const opts = { skip: needsDisplay && 'DISPLAY 없음 (xvfb-run 으로 실행)' };

test('앱 열기: 업데이트 확인 창(고지 포함) → 최신이면 장부가 열리고 확인 창은 닫힘', opts, async () => {
  const server = await feedServer({ latest: VERSION });
  const { app, splash, done } = await launch(`http://127.0.0.1:${server.address().port}`);
  try {
    assert.equal(await splash.locator('h1').innerText(), 'GRAYZONE 매출 장부');
    assert.match(await splash.locator('.notice').innerText(), /그레이존\(GRAYZONE\)의 매출 장부 전용 앱/);
    assert.equal(await splash.locator('#ver').innerText(), '버전 ' + VERSION);
    await splash.waitForFunction(() => /최신 버전입니다/.test(document.getElementById('msg').textContent));
    const { main } = await waitMain(app);
    if (!splash.isClosed()) await splash.waitForEvent('close', { timeout: 15000 }); // 장부 창이 뜨면 확인 창은 닫힘
    assert.equal(app.windows().length, 1);
    assert.equal(await main.title(), 'GRAYZONE 매출 장부');
  } finally { await done(); server.close(); }
});

test('앱 열기: 새 버전이 있으면 받으러 감 (개발 실행에서는 설치하지 않고 이유를 보이고 장부를 엶)', opts, async () => {
  const server = await feedServer({ latest: '99.0.0' });
  const { app, splash, done } = await launch(`http://127.0.0.1:${server.address().port}`);
  try {
    await splash.waitForFunction(() => /개발 실행에서는 업데이트를 설치하지 않습니다/.test(document.getElementById('msg').textContent));
    await waitMain(app);
  } finally { await done(); server.close(); }
});

test('앱 열기: 인터넷이 안 되면 잠깐 알리고 장부를 엶', opts, async () => {
  const { app, splash, done } = await launch('http://127.0.0.1:9'); // 아무도 듣지 않는 포트
  try {
    await splash.waitForFunction(() => /확인하지 못했습니다/.test(document.getElementById('msg').textContent));
    await waitMain(app);
  } finally { await done(); }
});

test('앱 열기: 확인이 늦으면 「업데이트 건너뛰고 열기」로 바로 엶', opts, async () => {
  const server = await feedServer({ latest: VERSION, delayMs: 60000 }); // 1분 동안 답하지 않는 서버
  const { app, splash, done } = await launch(`http://127.0.0.1:${server.address().port}`);
  try {
    await splash.waitForSelector('#skip');
    await splash.click('#skip');
    await waitMain(app);
    assert.equal(server.answered, undefined, '서버가 답하기 전에 장부가 열려야 함');
  } finally { await done(); server.close(); }
});
