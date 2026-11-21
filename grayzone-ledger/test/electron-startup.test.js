'use strict';
// 실제 Electron 앱을 띄워 런치 화면의 흐름(실제 초기화 단계 → 웨지)을 가짜 릴리스 서버로 확인합니다.
//   xvfb-run -a node --test test/electron-startup.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { _electron: electron } = require('playwright');

const VERSION = require('../package.json').version;
const SHOTS = process.env.SHOTS;
const needsDisplay = process.platform === 'linux' && !process.env.DISPLAY;

function feedServer({ latest, delayMs = 0 }) {
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (body) => setTimeout(() => { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); } }, delayMs).unref();
    const key = `${process.platform}-${process.arch}`;
    if (req.url === '/download/ledger-updates/latest.json') {
      return send({ version: latest, notes: '', files: { [key]: { name: 'app.zip', size: 1, sha256: '00', url: `${base}/download/ledger-v${latest}/app.zip` } } });
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function launch(feed) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gz-start-'));
  const t0 = Date.now();
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []), path.join(__dirname, '..')],
    env: { ...process.env, GZ_USER_DATA: userData, GZ_UPDATE_FEED: feed, GZ_NO_UPDATE: '' },
  });
  const splash = await app.firstWindow();
  return { app, splash, t0, done: async () => { await app.close(); fs.rmSync(userData, { recursive: true, force: true }); } };
}

/** 런치 화면이 닫힐 때까지 기다리고, 그동안 보여 준 상태 기록과 장부 창을 돌려줍니다. */
async function finish(app, splash) {
  if (!splash.isClosed()) await splash.waitForEvent('close', { timeout: 30000 });
  const log = await app.evaluate(() => global.gzLaunchLog);
  const main = app.windows().find((w) => w !== splash);
  await main.waitForSelector('.steps');
  return { log, main };
}

const opts = { skip: needsDisplay && 'DISPLAY 없음 (xvfb-run 으로 실행)' };

test('런치: 640×400 창, 번들 버전, 단계마다 웨지가 차고 11칸이 찬 뒤 장부로 넘어감 (최소 1초)', opts, async () => {
  const server = await feedServer({ latest: VERSION });
  const { app, splash, t0, done } = await launch(`http://127.0.0.1:${server.address().port}`);
  try {
    assert.deepEqual(await splash.evaluate(() => [innerWidth, innerHeight]), [640, 400]);
    assert.equal(await splash.locator('#ver').innerText(), VERSION); // 번들(package.json) 버전
    assert.equal(await app.evaluate(({ app: a }) => a.getVersion()), VERSION);
    if (SHOTS) await splash.screenshot({ path: path.join(SHOTS, '23-launch-electron.png') });
    const { log, main } = await finish(app, splash);
    assert.ok(Date.now() - t0 >= 1000, '1초보다 빨리 넘어감');
    const filled = log.map((x) => x.filled);
    assert.deepEqual(filled, filled.slice().sort((a, b) => a - b), '웨지가 줄어든 적이 있음: ' + filled.join());
    assert.equal(filled[filled.length - 1], 11);
    const texts = log.map((x) => x.text);
    for (const want of ['설정을 읽는 중…', '업데이트를 확인하는 중…', '최신 버전입니다.', '장부 창을 준비하는 중…', '장부를 읽는 중…', '준비 완료']) {
      assert.ok(texts.includes(want), `「${want}」가 없음: ${[...new Set(texts)].join(' / ')}`);
    }
    assert.equal(await main.title(), 'G-Account');
    assert.equal(app.windows().length, 1);
  } finally { await done(); server.close(); }
});

test('런치: 업데이트 확인이 실패하면 한 줄로 알리고 계속 진행해 장부를 엶', opts, async () => {
  const { app, splash, done } = await launch('http://127.0.0.1:9'); // 아무도 듣지 않는 포트
  try {
    const { log } = await finish(app, splash);
    assert.ok(log.some((x) => /^업데이트 확인 실패\(계속 진행\): /.test(x.text)), [...new Set(log.map((x) => x.text))].join(' / '));
    assert.equal(log[log.length - 1].filled, 11);
  } finally { await done(); }
});

test('런치: 새 버전이 있으면 받으러 감 (개발 실행에서는 설치하지 않고 이유를 알린 뒤 계속)', opts, async () => {
  const server = await feedServer({ latest: '99.0.0' });
  const { app, splash, done } = await launch(`http://127.0.0.1:${server.address().port}`);
  try {
    const { log } = await finish(app, splash);
    assert.ok(log.some((x) => /새 버전 99\.0\.0/.test(x.text)));
    assert.ok(log.some((x) => /^업데이트 건너뜀: 개발 실행에서는/.test(x.text)));
  } finally { await done(); server.close(); }
});

test('런치: 끝나기 전에 런치 창을 닫으면 앱이 끝남 (장부 창이 몰래 뜨지 않음)', opts, async () => {
  const server = await feedServer({ latest: VERSION, delayMs: 60000 });
  const { app, splash, done } = await launch(`http://127.0.0.1:${server.address().port}`);
  try {
    await splash.waitForFunction(() => /업데이트를 확인하는 중/.test(document.getElementById('msg').textContent));
    const closed = app.waitForEvent('close', { timeout: 10000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed;
  } finally { await done().catch(() => {}); server.close(); }
});
